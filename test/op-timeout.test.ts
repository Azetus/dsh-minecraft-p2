import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ArtifactHost } from '../src/core/artifact-host.ts'
import { DeclaredOpBroker } from '../src/core/op-broker.ts'
import type { OpSource } from '../src/core/op-broker.ts'
import { createAuthoredOpSource } from '../src/core/op-artifact.ts'
import { BodyRuntime } from '../src/body/runtime.ts'
import type { BodyInfo } from '../src/contracts/protocol.ts'
import type { ActHandle, ActPoll, QueryOutcome } from '../src/core/node-runtime.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function writeOp(name: string, body: string): string {
  const directory = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-op-timeout-'))
  directories.push(directory)
  const path = join(directory, name)
  writeFileSync(path, body)
  return path
}

const SLOW_QUERY = `
defineOp({
  manifest: { schemaVersion: 1, kind: 'op', name: 'slow-scan', opKind: 'query', limits: { totalMs: 50 } },
  query: () => new Promise(function () {}),
})
`

const STUCK_CONTROL = `
defineOp({
  manifest: {
    schemaVersion: 1, kind: 'op', name: 'stuck-dig', opKind: 'control',
    effects: 'active', stop: 'poll', capabilities: ['dig'], limits: { totalMs: 50 },
  },
  start: (ctx, args) => ctx.provider.start('dig', args),
})
`

const body: BodyInfo = {
  manifest: { schemaVersion: 1, bodyVersion: 'test', protocolVersion: 1, entry: 'body.mjs', files: {} },
  manifestDigest: 'digest',
  bindingId: null,
  capabilities: [],
  provider: null,
}

const owner = { sessionId: 's', agentId: 'a', cwd: process.cwd() }

type Clock = { now: number }

function createHarness(clock: Clock, options: { stubbornStop?: boolean } = {}): {
  host: ArtifactHost
  broker: DeclaredOpBroker
  calls: string[]
} {
  const calls: string[] = []
  const source: OpSource = {
    capabilities: ['dig', 'move'],
    query: (): QueryOutcome => ({ status: 'ok', value: null }),
    start: (name: string): ActHandle => {
      calls.push(`start:${name}`)
      const state = { running: true }
      const poll = (): ActPoll => state.running ? { status: 'running' } : { status: 'succeeded' }
      return {
        poll,
        stop: () => {
          calls.push(`stop:${name}`)
          if (options.stubbornStop !== true) state.running = false
        },
      }
    },
  }
  let host: ArtifactHost | undefined
  const source2 = createAuthoredOpSource(source, name => host?.opArtifact(name), {
    log: () => {},
    now: () => clock.now,
  })
  const broker = new DeclaredOpBroker(source2, { now: () => clock.now })
  host = new ArtifactHost({
    bindingId: 'binding-op-timeout',
    query: broker.queryPort(),
    act: { start: () => { throw new Error('act port is not configured') } },
  })
  return { host, broker, calls }
}

describe('authored op timeouts', () => {
  it('fails an async query with OP_TIMEOUT when it exceeds limits.totalMs', async () => {
    const clock: Clock = { now: 1_000 }
    const harness = createHarness(clock)
    const checked = await harness.host.check({
      sourcePath: writeOp('slow.mjs', SLOW_QUERY),
      artifactKind: 'op',
    })
    harness.host.activate(checked.artifactId)

    const pending = harness.broker.query('slow-scan', {})
    if (pending.status !== 'pending') throw new Error(`expected pending, got ${pending.status}`)
    clock.now += 60
    expect(pending.poll()).toMatchObject({ status: 'failed', error: { code: 'OP_TIMEOUT' } })
    expect(harness.calls).toEqual([])
  })

  it('leaves the body responsive while an async op is pending', async () => {
    const clock: Clock = { now: 1_000 }
    const harness = createHarness(clock)
    const checked = await harness.host.check({
      sourcePath: writeOp('slow.mjs', SLOW_QUERY),
      artifactKind: 'op',
    })
    harness.host.activate(checked.artifactId)
    const runtime = new BodyRuntime({ body, owner, host: harness.host })

    const pending = harness.broker.query('slow-scan', {})
    expect(pending.status).toBe('pending')
    const heartbeat = runtime.handleRequest({
      protocol: 1,
      requestId: 'h1',
      method: 'heartbeat',
      bodyEpoch: runtime.bodyEpoch,
      params: { seq: 1 },
    })
    expect(heartbeat.result).toMatchObject({ alive: true })
    const status = runtime.handleRequest({
      protocol: 1,
      requestId: 's1',
      method: 'status',
      bodyEpoch: runtime.bodyEpoch,
      params: {},
    })
    expect(status.result).toMatchObject({ health: 'ready' })

    if (pending.status === 'pending') {
      clock.now += 60
      expect(pending.poll()).toMatchObject({ status: 'failed', error: { code: 'OP_TIMEOUT' } })
    }
  })

  it('fails a hung control op, releases it, and keeps the ledger honest', async () => {
    const clock: Clock = { now: 0 }
    const harness = createHarness(clock)
    const checked = await harness.host.check({
      sourcePath: writeOp('stuck.mjs', STUCK_CONTROL),
      artifactKind: 'op',
    })
    harness.host.activate(checked.artifactId)

    const handle = harness.broker.start(
      'stuck-dig',
      { x: 1 },
      { runId: 'run-1', actInstanceId: 'act-1', generation: 0 },
    )
    expect(handle.poll()).toMatchObject({ status: 'running' })
    clock.now += 60
    expect(handle.poll()).toMatchObject({ status: 'failed', error: { code: 'OP_TIMEOUT' } })
    expect(harness.calls).toEqual(['start:dig', 'stop:dig'])

    harness.broker.stopRun(clock.now, 'run-1')
    expect(harness.broker.pollRelease(clock.now)).toBe('stopping')
    expect(harness.broker.pollRelease(clock.now + 400)).toBe('released')
  })

  it('blocks a second exclusive control while a timed-out effect still polls running', async () => {
    const clock: Clock = { now: 0 }
    const harness = createHarness(clock, { stubbornStop: true })
    const checked = await harness.host.check({
      sourcePath: writeOp('stuck.mjs', STUCK_CONTROL),
      artifactKind: 'op',
    })
    harness.host.activate(checked.artifactId)
    const handle = harness.broker.start(
      'stuck-dig',
      {},
      { runId: 'run-1', actInstanceId: 'act-1', generation: 0 },
    )
    handle.poll()
    clock.now += 60
    expect(handle.poll()).toMatchObject({ status: 'failed', error: { code: 'OP_TIMEOUT' } })
    expect(() => harness.broker.start('moveTo', { x: 1, z: 2 }, {
      runId: 'run-1',
      actInstanceId: 'act-1',
      generation: 0,
    })).toThrow(/still active/u)
  })

  it('applies the declared limit to a normally completing op only when exceeded', async () => {
    const clock: Clock = { now: 0 }
    const harness = createHarness(clock)
    const checked = await harness.host.check({
      sourcePath: writeOp('stuck.mjs', STUCK_CONTROL),
      artifactKind: 'op',
    })
    harness.host.activate(checked.artifactId)
    const handle = harness.broker.start('stuck-dig', {}, {
      runId: 'run-1',
      actInstanceId: 'act-1',
      generation: 0,
    })
    clock.now += 10
    expect(handle.poll()).toMatchObject({ status: 'running' })
    handle.stop()
    expect(handle.poll()).toMatchObject({ status: 'succeeded' })
    harness.broker.stopRun(clock.now, 'run-1')
    expect(harness.broker.pollRelease(clock.now)).toBe('stopping')
    expect(harness.broker.pollRelease(clock.now + 400)).toBe('released')
  })
})




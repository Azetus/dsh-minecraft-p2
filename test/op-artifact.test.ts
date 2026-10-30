import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ArtifactHost } from '../src/core/artifact-host.ts'
import { DeclaredOpBroker } from '../src/core/op-broker.ts'
import type { OpSource } from '../src/core/op-broker.ts'
import { createAuthoredOpSource } from '../src/core/op-artifact.ts'
import { RunnerActPort } from '../src/core/act-port.ts'
import type { RunnerClient } from '../src/core/runner-client.ts'
import type { ActHandle, ActPoll } from '../src/core/node-runtime.ts'
import type { JsonValue } from '../src/contracts/types.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function sourceDirectory(): string {
  const directory = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-op-'))
  directories.push(directory)
  return directory
}

function writeSource(directory: string, name: string, body: string): string {
  const path = join(directory, name)
  writeFileSync(path, body)
  return path
}

class FakeProviderHandle implements ActHandle {
  private status: 'running' | 'succeeded' = 'running'
  stopped = false

  constructor(private readonly name: string, private readonly calls: string[]) {}

  poll(): ActPoll {
    return this.status === 'running'
      ? { status: 'running' }
      : { status: 'succeeded', result: { op: this.name } }
  }

  stop(): void {
    this.stopped = true
    this.status = 'succeeded'
    this.calls.push(`stop:${this.name}`)
  }
}

function fakeProvider(): { source: OpSource; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    source: {
      capabilities: ['dig', 'attack', 'look'],
      query(op: string): { status: 'ok'; value: JsonValue } {
        calls.push(`query:${op}`)
        return { status: 'ok', value: { op } }
      },
      start(op: string): ActHandle {
        calls.push(`start:${op}`)
        return new FakeProviderHandle(op, calls)
      },
    },
  }
}

function createHarness(options: {
  loadManifest?: (kind: 'act' | 'policy', code: string, artifactId: string) => Promise<JsonValue>
} = {}): {
  host: ArtifactHost
  broker: DeclaredOpBroker
  actPort: (client: RunnerClient) => RunnerActPort
  calls: string[]
} {
  const { source, calls } = fakeProvider()
  let host: ArtifactHost | undefined
  let broker: DeclaredOpBroker | undefined
  const ops = createAuthoredOpSource(source, name => host?.opArtifact(name), {
    log: () => {},
    now: () => 1000,
    onUntracked: input => { broker?.markUntracked(input.runId) },
  })
  broker = new DeclaredOpBroker(ops)
  host = new ArtifactHost({
    bindingId: 'binding-op',
    query: broker.queryPort(),
    act: { start: () => { throw new Error('act port is not configured in this harness') } },
    ...(options.loadManifest === undefined ? {} : { loadManifest: options.loadManifest }),
  })
  return {
    host,
    broker,
    calls,
    actPort: client => new RunnerActPort(client, broker as DeclaredOpBroker, id => host?.actSource(id)),
  }
}

const SCAN = `
defineOp({
  manifest: { schemaVersion: 1, kind: 'op', name: 'scan', opKind: 'query' },
  query: (ctx, args) => ({ scanned: args.where ?? null, at: ctx.now() }),
})
`

function controlOp(name: string, body: string, extra: string = "effects: 'active', stop: 'poll', capabilities: ['dig']"): string {
  return `
defineOp({
  manifest: { schemaVersion: 1, kind: 'op', name: '${name}', opKind: 'control', ${extra} },
  ${body}
})
`
}

const ACT_SOURCE = `
defineAct({
  manifest: { id: 'uses-authored', queryOps: ['scan'], controlOps: ['dig-area'] },
  create: () => ({
    start: () => ({ kind: 'running' }),
    update: () => ({ kind: 'running' }),
    stop: () => ({ kind: 'complete' }),
  }),
})
`

describe('authored op artifacts', () => {
  it('checks, activates and executes a query op inside the body', async () => {
    const directory = sourceDirectory()
    const path = writeSource(directory, 'scan.mjs', SCAN)
    const harness = createHarness()

    const checked = await harness.host.check({ sourcePath: path, artifactKind: 'op' })
    expect(checked.kind).toBe('op')
    expect(checked.definitionId).toBe('scan')
    expect(checked.artifactId).toMatch(/^p2:op:/u)
    expect(checked.artifact).toMatchObject({
      kind: 'op',
      opKind: 'query',
      effects: 'none',
      stop: 'none',
      capabilities: [],
    })

    const activated = harness.host.activate(checked.artifactId)
    expect(activated).toMatchObject({ enabled: true, kind: 'op' })
    expect(harness.host.opArtifact('scan')?.artifactId).toBe(checked.artifactId)

    const outcome = harness.broker.query('scan', { where: 'north' })
    expect(outcome).toMatchObject({ status: 'ok', value: { scanned: 'north', at: 1000 } })
    expect(harness.calls).toEqual([])
  })

  it('derives a new artifact when the op source changes', async () => {
    const directory = sourceDirectory()
    const path = writeSource(directory, 'scan.mjs', SCAN)
    const harness = createHarness()
    const first = await harness.host.check({ sourcePath: path, artifactKind: 'op' })
    const again = await harness.host.check({ sourcePath: path, artifactKind: 'op' })
    expect(again.artifactId).toBe(first.artifactId)

    writeSource(directory, 'scan.mjs', SCAN.replace("where ?? null", "where ?? 'anywhere'"))
    const second = await harness.host.check({ sourcePath: path, artifactKind: 'op' })
    expect(second.artifactId).not.toBe(first.artifactId)
    expect(second.sourceDigest).not.toBe(first.sourceDigest)
  })

  it('routes an act-declared control op through the broker to the authored implementation', async () => {
    const directory = sourceDirectory()
    const opPath = writeSource(directory, 'dig-area.mjs', controlOp('dig-area', "start: (ctx, args) => ctx.provider.start('dig', args),"))
    const actPath = writeSource(directory, 'act.mjs', ACT_SOURCE)
    const harness = createHarness({
      loadManifest: async () => ({ id: 'uses-authored', queryOps: ['scan'], controlOps: ['dig-area'] }),
    })

    // An act may only declare an op that the binding can resolve.
    await expect(harness.host.check({ sourcePath: actPath, artifactKind: 'act' }))
      .rejects.toMatchObject({ code: 'UNKNOWN_OP' })

    const op = await harness.host.check({ sourcePath: opPath, artifactKind: 'op' })
    const scan = await harness.host.check({ sourcePath: writeSource(directory, 'scan.mjs', SCAN), artifactKind: 'op' })
    harness.host.activate(op.artifactId)
    harness.host.activate(scan.artifactId)

    const act = await harness.host.check({ sourcePath: actPath, artifactKind: 'act' })
    expect(act.kind).toBe('act')
    expect((act.artifact as { ops: { query: string[]; control: string[] } }).ops)
      .toEqual({ query: ['scan'], control: ['dig-area'] })

    const client = {
      load: async () => null,
      actStart: async () => ({ kind: 'running' }),
      actUpdate: async () => ({ kind: 'running' }),
      actStop: async () => ({ kind: 'complete' }),
      actCleanup: async () => ({ kind: 'complete' }),
    } as unknown as RunnerClient
    const actPort = harness.actPort(client)
    const handle = actPort.start({ definitionId: 'uses-authored', artifactId: act.artifactId }, {})
    await new Promise(resolve => setTimeout(resolve, 0))
    actPort.handleOp({ type: 'op', callId: 1, kind: 'control', name: 'dig-area', args: { x: 1 } })
    expect(handle.poll()).toMatchObject({ status: 'running' })
    expect(harness.calls).toEqual(['start:dig'])
    expect(harness.broker.activeName).toBe('dig-area')

    handle.stop()
    handle.poll()
    expect(harness.calls).toContain('stop:dig')
  })

  it('lets an activated op replace a built-in name and falls back after retire', async () => {
    const directory = sourceDirectory()
    const path = writeSource(directory, 'attack.mjs', controlOp(
      'attack',
      'start: () => ({ poll: () => ({ status: \'succeeded\', result: { authored: true } }), stop: () => {} }),',
      "effects: 'none', stop: 'none', capabilities: ['attack']",
    ))
    const harness = createHarness()
    const checked = await harness.host.check({ sourcePath: path, artifactKind: 'op' })
    harness.host.activate(checked.artifactId)

    const first = harness.broker.start('attack', {}, { runId: 'run-1', actInstanceId: 'act-1', generation: 0 })
    expect(first.poll()).toMatchObject({ status: 'succeeded', result: { authored: true } })
    expect(harness.calls).toEqual([])

    harness.host.retire(checked.artifactId)
    const second = harness.broker.start('attack', {}, { runId: 'run-1', actInstanceId: 'act-2', generation: 0 })
    expect(second.poll()).toMatchObject({ status: 'running' })
    expect(harness.calls).toEqual(['start:attack'])
    second.stop()
    expect(harness.calls).toEqual(['start:attack', 'stop:attack'])
  })

  it('reports the release conclusion as unconfirmed when an op leaves a provider effect untracked', async () => {
    const directory = sourceDirectory()
    const ghost = writeSource(directory, 'ghost.mjs', controlOp(
      'ghost',
      "start: (ctx) => { ctx.provider.start('dig', { x: 1 }); return { poll: () => ({ status: 'succeeded' }), stop: () => {} }; },",
    ))
    const tracked = writeSource(directory, 'dig-area.mjs', controlOp('dig-area', "start: (ctx, args) => ctx.provider.start('dig', args),"))
    const harness = createHarness()
    const ghostArtifact = await harness.host.check({ sourcePath: ghost, artifactKind: 'op' })
    const trackedArtifact = await harness.host.check({ sourcePath: tracked, artifactKind: 'op' })
    harness.host.activate(ghostArtifact.artifactId)
    harness.host.activate(trackedArtifact.artifactId)

    const trackedHandle = harness.broker.start('dig-area', { x: 2 }, { runId: 'run-2', actInstanceId: 'act-2', generation: 0 })
    expect(trackedHandle.poll()).toMatchObject({ status: 'running' })
    expect(harness.broker.hasUntrackedControl).toBe(false)
    harness.broker.stopRun(0, 'run-2')
    expect(harness.broker.pollRelease(0)).toBe('stopping')
    expect(harness.broker.pollRelease(400)).toBe('released')

    const ghostHandle = harness.broker.start('ghost', {}, { runId: 'run-3', actInstanceId: 'act-3', generation: 0 })
    expect(ghostHandle.poll()).toMatchObject({ status: 'succeeded' })
    expect(harness.broker.untrackedControl).toEqual(['run-3'])
    harness.broker.stopRun(500, 'run-3')
    expect(harness.broker.pollRelease(500)).toBe('unconfirmed')
    expect(harness.broker.pollRelease(9000)).toBe('unconfirmed')
  })

  it('rejects malformed op manifests and forbidden syntax', async () => {
    const directory = sourceDirectory()
    const harness = createHarness()
    const cases: Array<[string, string, string]> = [
      ['missing-kind.mjs', "defineOp({ manifest: { schemaVersion: 1, name: 'x', opKind: 'query' }, query: () => null })", 'INVALID_OP_MANIFEST'],
      ['bad-name.mjs', "defineOp({ manifest: { schemaVersion: 1, kind: 'op', name: '2x', opKind: 'query' }, query: () => null })", 'INVALID_OP_MANIFEST'],
      ['query-control.mjs', "defineOp({ manifest: { schemaVersion: 1, kind: 'op', name: 'x', opKind: 'query', effects: 'active' }, query: () => null })", 'INVALID_OP_MANIFEST'],
      ['no-impl.mjs', "defineOp({ manifest: { schemaVersion: 1, kind: 'op', name: 'x', opKind: 'control' }, query: () => null })", 'INVALID_OP_MANIFEST'],
      ['no-define.mjs', "const x = 1", 'INVALID_OP_MODULE'],
      ['imports.mjs', "defineOp({ manifest: {}, query: () => require('fs') })", 'FORBIDDEN_SYNTAX'],
    ]
    for (const [name, body, code] of cases) {
      const path = writeSource(directory, name, body)
      await expect(harness.host.check({ sourcePath: path, artifactKind: 'op' }))
        .rejects.toMatchObject({ code })
    }
  })
})




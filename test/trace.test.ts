import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TraceSink } from '../src/core/trace.ts'
import { DeclaredOpBroker } from '../src/core/op-broker.ts'
import type { OpSource } from '../src/core/op-broker.ts'
import { createAuthoredOpSource } from '../src/core/op-artifact.ts'
import { RunnerActPort } from '../src/core/act-port.ts'
import type { RunnerClient } from '../src/core/runner-client.ts'
import { BehaviorHost } from '../src/core/host.ts'
import { BodyRuntime } from '../src/body/runtime.ts'
import type { BodyInfo } from '../src/contracts/protocol.ts'
import type { JsonValue } from '../src/contracts/types.ts'
import type { ActHandle, ActPoll } from '../src/core/node-runtime.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function sourceDirectory(): string {
  const directory = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-trace-'))
  directories.push(directory)
  return directory
}

function writeSource(directory: string, name: string, body: string): string {
  const path = join(directory, name)
  writeFileSync(path, body)
  return path
}

function flush(ms = 5): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const provider: OpSource = {
  capabilities: ['dig'],
  query(op: string): { status: 'ok'; value: JsonValue } {
    return { status: 'ok', value: { op } }
  },
  start(): ActHandle {
    let running = true
    return {
      poll: (): ActPoll => (running ? { status: 'running' } : { status: 'succeeded' }),
      stop: () => { running = false },
    }
  },
}

class Handle implements ActHandle {
  running = true
  poll(): ActPoll {
    return this.running ? { status: 'running' } : { status: 'succeeded' }
  }
  stop(): void {
    this.running = false
  }
}

function fakeRunnerClient(): RunnerClient {
  return {
    load: async () => null,
    actStart: async () => ({ kind: 'running' }),
    actUpdate: async () => ({ kind: 'running' }),
    actStop: async () => ({ kind: 'complete' }),
    actCleanup: async () => ({ kind: 'complete' }),
  } as unknown as RunnerClient
}

const OP_SOURCE = `
defineOp({
  manifest: { schemaVersion: 1, kind: 'op', name: 'scan', opKind: 'query' },
  query: (ctx, args) => ({ scanned: args.where ?? null }),
})
`

const BEHAVIOR_SOURCE = `
defineBehavior({
  manifest: { id: 'trace-run', mode: 'finite', parameters: {} },
  run: function* (ctx) {
    yield ctx.wait(1)
    return ctx.succeed({ ok: true })
  },
})
`

describe('TraceSink', () => {
  it('keeps a bounded ring and counts evicted events', () => {
    const sink = new TraceSink({ capacity: 3, now: () => 100 })
    for (let index = 0; index < 5; index += 1) {
      sink.record('op', 'end', `op-${index}`, { durationMs: index })
    }
    const all = sink.read()
    expect(all.events.map(event => event.seq)).toEqual([3, 4, 5])
    expect(all.dropped).toBe(2)
    expect(all.capacity).toBe(3)
    expect(all.seq).toBe(5)
    expect(all.gap).toBe(false)
    expect(sink.read({ sinceSeq: 1 }).gap).toBe(true)
    expect(sink.read({ sinceSeq: 1 }).events).toHaveLength(3)
    expect(sink.read({ sinceSeq: 4 }).events.map(event => event.seq)).toEqual([5])
  })

  it('filters by run, act, op and kind', () => {
    const sink = new TraceSink({ now: () => 100 })
    sink.record('op', 'end', 'position', { runId: 'r1', durationMs: 5 })
    sink.record('op', 'end', 'moveTo', { runId: 'r2', durationMs: 7 })
    sink.record('act', 'end', 'dig', { runId: 'r1', actId: 'p2:act:x', durationMs: 9 })
    sink.record('guard', 'event', 'fired', { runId: 'r1' })

    expect(sink.read({ runId: 'r1' }).events).toHaveLength(3)
    expect(sink.read({ op: 'moveTo' }).events).toHaveLength(1)
    expect(sink.read({ act: 'dig' }).events).toHaveLength(1)
    expect(sink.read({ kind: 'op' }).events).toHaveLength(2)
    expect(sink.read({ limit: 2 }).events.map(event => event.name)).toEqual(['dig', 'fired'])
    expect(sink.read({ limit: 2 }).stats.act?.count).toBe(1)
  })

  it('reports nearest-rank p50/p95 over completed spans', () => {
    const sink = new TraceSink()
    for (const duration of [40, 10, 30, 20]) {
      sink.record('behavior', 'end', 'step', { durationMs: duration })
    }
    expect(sink.read().stats.behavior).toEqual({ count: 4, p50: 20, p95: 40, max: 40 })
  })
})

describe('trace instrumentation', () => {
  it('records run and behavior-step spans without changing the outcome', async () => {
    const directory = sourceDirectory()
    const path = writeSource(directory, 'behavior.mjs', BEHAVIOR_SOURCE)
    const trace = new TraceSink()
    const query = (): { status: 'ok'; value: JsonValue } => ({ status: 'ok', value: null })
    const host = new BehaviorHost({
      bindingId: 'binding-trace',
      trace,
      query,
      act: { start: () => new Handle() },
    })
    const checked = await host.check({ sourcePath: path, artifactKind: 'behavior', format: 'js' })
    host.activate(checked.artifactId)
    expect(host.switch({ artifactId: checked.artifactId, params: {}, commandId: 'c1' }))
      .toMatchObject({ accepted: true, status: 'running' })

    host.tick(1000)
    host.tick(2000)
    expect(host.status().lastRun?.status).toBe('succeeded')

    const runs = trace.read({ kind: 'run' })
    expect(runs.events.map(event => `${event.phase}:${event.name}`)).toEqual(['start:trace-run', 'end:trace-run'])
    expect(runs.stats.run?.count).toBe(1)
    const lastRunId = host.status().lastRun?.runId
    expect(lastRunId).toBeDefined()
    const steps = trace.read({ kind: 'behavior', ...(lastRunId === undefined ? {} : { runId: lastRunId }) })
    expect(steps.events.length).toBeGreaterThanOrEqual(2)
    expect(steps.stats.behavior?.count).toBe(steps.events.length)
  })

  it('records op round-trips through the broker', async () => {
    const directory = sourceDirectory()
    const path = writeSource(directory, 'scan.mjs', OP_SOURCE)
    const trace = new TraceSink()
    let host: BehaviorHost | undefined
    const source = createAuthoredOpSource(provider, name => host?.opArtifact(name), { log: () => {} })
    const broker = new DeclaredOpBroker(source, { trace, now: () => Date.now() })
    host = new BehaviorHost({
      bindingId: 'binding-trace',
      trace,
      query: broker.queryPort(),
      act: { start: () => new Handle() },
    })
    const checked = await host.check({ sourcePath: path, artifactKind: 'op' })
    host.activate(checked.artifactId)
    expect(broker.query('scan', { where: 'east' })).toMatchObject({ status: 'ok' })
    expect(broker.query('position', {})).toMatchObject({ status: 'ok' })

    const events = trace.read({ kind: 'op' }).events
    expect(events.map(event => `${event.phase}:${event.name}`)).toEqual(['end:scan', 'end:position'])
    expect(trace.read({ kind: 'op' }).stats.op?.count).toBe(2)
  })

  it('records act start and stop spans through the act port', async () => {
    const trace = new TraceSink()
    const broker = new DeclaredOpBroker(provider, { trace })
    const actPort = new RunnerActPort(fakeRunnerClient(), broker, artifactId => ({
      artifactId,
      definitionId: 'dig',
      code: '',
      ops: { query: [], control: [] },
    }), trace)

    const handle = actPort.start(
      { definitionId: 'dig', artifactId: 'p2:act:trace' },
      {},
      { runId: 'run-1', actInstanceId: 'act-1', generation: 0 },
    )
    await flush()
    handle.poll()
    handle.stop()
    await flush()

    const events = trace.read({ kind: 'act', act: 'dig' }).events
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events.some(event => event.phase === 'end' && event.durationMs !== undefined)).toBe(true)
    expect(trace.read({ kind: 'act' }).stats.act?.count).toBeGreaterThanOrEqual(1)
    expect(handle.poll().status).not.toBe('running')
  })

  it('serves the bounded trace through the body protocol', () => {
    const sink = new TraceSink({ capacity: 2 })
    sink.record('guard', 'event', 'fired', { runId: 'r1' })
    sink.record('guard', 'event', 'started', { runId: 'r1' })
    sink.record('guard', 'event', 'error', { runId: 'r1' })
    const body: BodyInfo = {
      manifest: { schemaVersion: 1, bodyVersion: 'test', protocolVersion: 1, entry: 'body.mjs', files: {} },
      manifestDigest: 'digest',
      bindingId: 'binding' as BodyInfo['bindingId'],
      capabilities: [],
      provider: null,
    }
    const runtime = new BodyRuntime({
      body,
      owner: { sessionId: 's', agentId: 'a', cwd: process.cwd() },
      trace: sink,
    })
    const response = runtime.handleRequest({
      protocol: 1,
      requestId: 'r1',
      method: 'trace',
      bodyEpoch: runtime.bodyEpoch,
      params: { kind: 'guard' },
    })
    expect(response.error).toBeUndefined()
    expect(response.result).toMatchObject({ dropped: 1, capacity: 2, seq: 3 })
    expect((response.result as unknown as { events: unknown[] }).events).toHaveLength(2)

    const unsupported = new BodyRuntime({
      body,
      owner: { sessionId: 's', agentId: 'a', cwd: process.cwd() },
    })
    const empty = unsupported.handleRequest({
      protocol: 1,
      requestId: 'r2',
      method: 'trace',
      bodyEpoch: unsupported.bodyEpoch,
      params: {},
    })
    expect(empty.result).toMatchObject({ events: [], dropped: 0, capacity: 0 })
  })
})

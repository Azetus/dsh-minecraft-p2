import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import { BehaviorHost } from '../src/core/host.ts'
import { DebugLog } from '../src/core/logging.ts'
import { WorkQuota } from '../src/core/quota.ts'
import type { ActPort, QueryPort } from '../src/core/node-runtime.ts'
import { PROTOCOL_VERSION } from '../src/contracts/index.ts'
import type { BodyInfo, BodyManifest, JsonValue, RequestEnvelope } from '../src/contracts/index.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const manifest: BodyManifest = {
  schemaVersion: 1,
  bodyVersion: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
  entry: 'body.mjs',
  files: { 'body.mjs': 'a'.repeat(64) },
}
const body: BodyInfo = {
  manifest,
  manifestDigest: 'b'.repeat(64),
  bindingId: 'binding-1' as BodyInfo['bindingId'],
  capabilities: [],
  provider: null,
}
const query: QueryPort = () => ({ status: 'ok', value: null })
const act: ActPort = { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) }

function source(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-body-behavior-'))
  dirs.push(dir)
  const path = join(dir, 'behavior.mjs')
  writeFileSync(path, `
export default {
  id: 'body-external', description: 'external', mode: 'finite', parameters: {}, locals: {},
  root: { kind: 'sequence', id: 'root', children: [] },
  completion: { kind: 'externalConfirmation', description: 'body ack' },
}
`)
  return path
}

function loopSource(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-body-loop-'))
  dirs.push(dir)
  const path = join(dir, 'loop.mjs')
  writeFileSync(path, 'while (true) {}\n')
  return path
}

function request(method: string, params: Record<string, JsonValue>, commandId?: string, epoch?: string): RequestEnvelope {
  return {
    protocol: PROTOCOL_VERSION,
    requestId: `req-${method}`,
    method,
    params,
    ...(commandId === undefined ? {} : { commandId }),
    ...(epoch === undefined ? {} : { bodyEpoch: epoch }),
  }
}

describe('body behavior methods', () => {
  it('checks, activates, switches, ticks and confirms over the request surface', async () => {
    const host = new BehaviorHost({
      bindingId: 'binding-1',
      owner: 'session-1/agent-1',
      query,
      act,
    })
    const rt = new BodyRuntime({
      body,
      behavior: host,
      owner: { sessionId: 'session-1', agentId: 'agent-1', cwd: process.cwd() },
      newEpoch: () => 'epoch-1',
    })
    const check = await rt.handleRequestAsync(request('check', { sourcePath: source() }, 'check-1', 'epoch-1'))
    expect(check.error).toBeUndefined()
    const checked = check.result as { artifactId: string; enabled: boolean }
    expect(checked.enabled).toBe(false)

    const activate = await rt.handleRequestAsync(request('activate', { artifactId: checked.artifactId }, 'activate-1', 'epoch-1'))
    expect(activate.error).toBeUndefined()

    const switched = await rt.handleRequestAsync(request('switch', {
      artifactId: checked.artifactId,
      params: {},
    }, 'switch-1', 'epoch-1'))
    expect(switched.error).toBeUndefined()
    const run = switched.result as { accepted: boolean; runId: string }
    expect(run.accepted).toBe(true)
    expect(rt.tickBehavior(0)).toBe('blocked')
    expect(rt.status().pendingConfirmation?.runId).toBe(run.runId)

    const confirmed = await rt.handleRequestAsync(request('confirm', {
      runId: run.runId,
      confirmationId: rt.status().pendingConfirmation?.id ?? '',
      decision: 'confirm',
    }, 'confirm-1', 'epoch-1'))
    expect(confirmed.error).toBeUndefined()
    expect((confirmed.result as { outcome: string }).outcome).toBe('confirmed')
    expect(rt.tickBehavior(1)).toBe('succeeded')
  })

  it('rejects a source outside the owner project and requires a behavior host', async () => {
    const rt = new BodyRuntime({
      body,
      owner: { sessionId: 's', agentId: 'a', cwd: process.cwd() },
      newEpoch: () => 'epoch-1',
    })
    const noHost = await rt.handleRequestAsync(request('check', { sourcePath: source() }, 'check-1', 'epoch-1'))
    expect(noHost.error?.code).toBe('BEHAVIOR_UNAVAILABLE')

    const host = new BehaviorHost({ bindingId: 'binding-1', query, act })
    const withHost = new BodyRuntime({
      body,
      behavior: host,
      owner: { sessionId: 's', agentId: 'a', cwd: process.cwd() },
      newEpoch: () => 'epoch-1',
    })
    const outside = await withHost.handleRequestAsync(request('check', {
      sourcePath: join(process.cwd(), '..', 'outside.mjs'),
    }, 'check-2', 'epoch-1'))
    expect(outside.error?.code).toBe('SOURCE_OUTSIDE_PROJECT')
  })

  it('stops only the behavior run and keeps the body alive', async () => {
    const host = new BehaviorHost({ bindingId: 'binding-1', owner: 's/a', query, act })
    const rt = new BodyRuntime({
      body,
      behavior: host,
      owner: { sessionId: 's', agentId: 'a', cwd: process.cwd() },
      newEpoch: () => 'epoch-1',
    })
    const checked = await rt.handleRequestAsync(request('check', { sourcePath: source() }, 'stop-check', 'epoch-1'))
    const artifactId = (checked.result as { artifactId: string }).artifactId
    await rt.handleRequestAsync(request('activate', { artifactId }, 'stop-activate', 'epoch-1'))
    const switched = await rt.handleRequestAsync(request('switch', { artifactId, params: {} }, 'stop-switch', 'epoch-1'))
    const runId = (switched.result as { runId: string }).runId
    expect(rt.tickBehavior(0)).toBe('blocked')
    const stopped = await rt.handleRequestAsync(request('behavior.stop', { runId }, 'stop-run', 'epoch-1'))
    expect(stopped.error).toBeUndefined()
    expect((stopped.result as { accepted: boolean }).accepted).toBe(true)
    expect(rt.status().activeRun).toBeNull()
    expect(rt.status().bodyEpoch).toBe('epoch-1')
  })

  it('does not execute a duplicate pending check and still answers status', async () => {
    const host = new BehaviorHost({ bindingId: 'binding-1', query, act })
    const rt = new BodyRuntime({
      body,
      behavior: host,
      owner: { sessionId: 's', agentId: 'a', cwd: process.cwd() },
      newEpoch: () => 'epoch-1',
    })
    const check = request('check', { sourcePath: loopSource(), timeoutMs: 100 }, 'same-check', 'epoch-1')
    const first = rt.handleRequestAsync(check)
    const duplicate = await rt.handleRequestAsync(check)
    expect(duplicate.error?.code).toBe('COMMAND_PENDING')
    const status = await rt.handleRequestAsync(request('status', {}, undefined, 'epoch-1'))
    expect(status.error).toBeUndefined()
    expect((await first).error).toBeDefined()
  })

  it('keeps commands and status working when debug logging is unavailable', async () => {
    const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-body-log-'))
    dirs.push(dir)
    const log = new DebugLog({ filePath: join(dir, 'missing', 'debug.jsonl') })
    const host = new BehaviorHost({ bindingId: 'binding-1', owner: 's/a', query, act })
    const rt = new BodyRuntime({
      body,
      behavior: host,
      debugLog: log,
      owner: { sessionId: 's', agentId: 'a', cwd: process.cwd() },
      newEpoch: () => 'epoch-1',
    })
    const checked = await rt.handleRequestAsync(request('check', { sourcePath: source() }, 'log-check', 'epoch-1'))
    expect(checked.error).toBeUndefined()
    await log.close()
    expect(rt.status().loggingUnavailable).toBe(true)
    expect(rt.status().droppedLogCount).toBeGreaterThan(0)
  })

  it('does not let a full log buffer block check, terminal status, or stop', async () => {
    const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-body-log-full-'))
    dirs.push(dir)
    const log = new DebugLog({ filePath: join(dir, 'debug.jsonl'), maxBuffer: 1 })
    log.log({ filler: true })
    const host = new BehaviorHost({ bindingId: 'binding-1', owner: 's/a', query, act })
    const rt = new BodyRuntime({
      body,
      behavior: host,
      debugLog: log,
      owner: { sessionId: 's', agentId: 'a', cwd: process.cwd() },
      newEpoch: () => 'epoch-1',
    })
    const checked = await rt.handleRequestAsync(request('check', { sourcePath: source() }, 'full-check', 'epoch-1'))
    expect(checked.error).toBeUndefined()
    const artifactId = (checked.result as { artifactId: string }).artifactId
    await rt.handleRequestAsync(request('activate', { artifactId }, 'full-activate', 'epoch-1'))
    const switched = await rt.handleRequestAsync(request('switch', { artifactId, params: {} }, 'full-switch', 'epoch-1'))
    expect(switched.error).toBeUndefined()
    expect(rt.tickBehavior(0)).toBe('blocked')
    const runId = (switched.result as { runId: string }).runId
    const stopped = await rt.handleRequestAsync(request('stop', { runId }, 'full-stop', 'epoch-1'))
    expect(stopped.error).toBeUndefined()
    expect(rt.status().droppedLogCount).toBeGreaterThan(0)
    await log.close()
  })

  it('rejects a second normal build when the work quota is full but keeps status available', async () => {
    const host = new BehaviorHost({ bindingId: 'binding-1', query, act })
    const rt = new BodyRuntime({
      body,
      behavior: host,
      workQuota: new WorkQuota(1),
      owner: { sessionId: 's', agentId: 'a', cwd: process.cwd() },
      newEpoch: () => 'epoch-1',
    })
    const first = rt.handleRequestAsync(request('check', {
      sourcePath: loopSource(),
      timeoutMs: 100,
    }, 'quota-1', 'epoch-1'))
    const second = await rt.handleRequestAsync(request('check', {
      sourcePath: source(),
    }, 'quota-2', 'epoch-1'))
    expect(second.error?.code).toBe('QUOTA_EXCEEDED')
    const status = await rt.handleRequestAsync(request('status', {}, undefined, 'epoch-1'))
    expect(status.error).toBeUndefined()
    expect((await first).error?.code).toBe('CHECK_TIMEOUT')

    const after = await rt.handleRequestAsync(request('check', { sourcePath: source() }, 'quota-3', 'epoch-1'))
    expect(after.error).toBeUndefined()
  })
})

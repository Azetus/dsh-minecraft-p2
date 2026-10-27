import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import { BehaviorHost } from '../src/core/host.ts'
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
})

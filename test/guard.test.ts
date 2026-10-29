import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { p2Error } from '../src/contracts/protocol.ts'
import type { JsonValue } from '../src/contracts/types.ts'
import { BehaviorHost } from '../src/core/host.ts'
import type { ActPort, QueryOutcome, QueryPort, ReleaseStatus } from '../src/core/node-runtime.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const act: ActPort = { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) }

function source(name: string, body: string): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-guard-'))
  dirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

const done = `
export default {
  id: 'guard-target', description: 'guard target', mode: 'finite', parameters: {}, locals: {},
  root: { kind: 'sequence', id: 'root', children: [] },
  completion: { kind: 'predicate', condition: { kind: 'expr', expr: { kind: 'literal', value: true } } },
}
`

const waiting = `
export default {
  id: 'guard-waiting', description: 'guard waiting owner', mode: 'finite', parameters: {}, locals: {},
  root: { kind: 'wait', id: 'wait-node', durationMs: 5000 },
  completion: { kind: 'externalConfirmation', description: 'never in this test' },
}
`

function healthQuery(read: () => JsonValue): QueryPort {
  return () => ({ status: 'ok', value: { health: read() } })
}

function releasableAct(): { act: ActPort; release: (state: ReleaseStatus) => void } {
  let state: ReleaseStatus = 'stopping'
  return {
    act: {
      start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }),
      stopRun: () => {},
      pollRelease: () => state,
    },
    release: next => { state = next },
  }
}

describe('guard contract', () => {
  it('fires once from idle and starts the target', async () => {
    let health: JsonValue = 6
    const host = new BehaviorHost({ bindingId: 'guard-1', query: healthQuery(() => health), act })
    const target = await host.check({ sourcePath: source('target.mjs', done) })
    host.activate(target.artifactId)

    const guard = host.setGuard({
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId: target.artifactId,
      params: {},
      ttlMs: 60_000,
    }, 1_000)
    expect(guard.state).toBe('active')

    host.tick(1_000)
    const fired = host.status()
    expect(fired.guard).toMatchObject({ state: 'fired', condition: { kind: 'health', hpBelow: 10 } })
    expect(fired.lastSwitch).toMatchObject({ phase: 'started', targetArtifactId: target.artifactId })
    expect(fired.activeRun?.artifactId).toBe(target.artifactId)
    expect(fired.guardEvents?.map(event => event.phase)).toEqual(['armed', 'fired', 'started'])
    const firstAttempt = fired.guard?.attemptId

    health = 1
    host.tick(2_000)
    const after = host.status()
    expect(after.guard?.attemptId).toBe(firstAttempt)
    expect(after.guardEvents?.filter(event => event.phase === 'fired')).toHaveLength(1)
    expect(after.guardEvents?.filter(event => event.phase === 'started')).toHaveLength(1)
  })

  it('expires without firing when ttl elapses', async () => {
    const host = new BehaviorHost({ bindingId: 'guard-2', query: healthQuery(() => 6), act })
    const target = await host.check({ sourcePath: source('target.mjs', done) })
    host.activate(target.artifactId)
    host.setGuard({
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId: target.artifactId,
      params: {},
      ttlMs: 10_000,
    }, 0)

    host.tick(10_001)
    const status = host.status()
    expect(status.guard?.state).toBe('expired')
    expect(status.lastSwitch).toBeNull()
    expect(status.activeRun).toBeNull()
    expect(status.guardEvents?.some(event => event.phase === 'fired')).toBe(false)
  })

  it('clears the guard without touching the behavior', async () => {
    const host = new BehaviorHost({ bindingId: 'guard-3', query: healthQuery(() => 6), act })
    const target = await host.check({ sourcePath: source('target.mjs', done) })
    host.activate(target.artifactId)
    host.setGuard({
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId: target.artifactId,
      params: {},
      ttlMs: 60_000,
    }, 0)

    const cleared = host.clearGuard(100)
    expect(cleared.cleared).toBe(true)
    expect(host.status().guard).toBeNull()
    expect(host.status().guardEvents?.at(-1)?.phase).toBe('cleared')
  })

  it('keeps one in-flight query and does not count pending as a failure', async () => {
    let calls = 0
    let pending = true
    const query: QueryPort = () => {
      calls += 1
      if (!pending) return { status: 'ok', value: { health: 6 } }
      const poll = (): QueryOutcome => pending ? { status: 'pending', poll } : { status: 'ok', value: { health: 6 } }
      return { status: 'pending', poll }
    }
    const host = new BehaviorHost({ bindingId: 'guard-4', query, act })
    const target = await host.check({ sourcePath: source('target.mjs', done) })
    host.activate(target.artifactId)
    host.setGuard({
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId: target.artifactId,
      params: {},
      ttlMs: 60_000,
    }, 0)

    host.tick(0)
    host.tick(250)
    host.tick(500)
    expect(calls).toBe(1)
    expect(host.status().guard?.state).toBe('active')

    pending = false
    host.tick(750)
    expect(calls).toBe(1)
    expect(host.status().guard?.state).toBe('fired')
  })

  it('clears a fired guard before its pending target starts', async () => {
    const host = new BehaviorHost({ bindingId: 'guard-6', query: healthQuery(() => 6), act })
    const current = await host.check({ sourcePath: source('waiting.mjs', waiting) })
    const target = await host.check({ sourcePath: source('target.mjs', done) })
    host.activate(current.artifactId)
    host.activate(target.artifactId)
    const switched = host.switch({ artifactId: current.artifactId, params: {}, commandId: 'owner' })
    expect(switched.accepted).toBe(true)
    host.tick(0)

    host.setGuard({
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId: target.artifactId,
      params: {},
      ttlMs: 60_000,
    }, 1_000)
    host.tick(1_000)
    expect(host.status().guard?.state).toBe('firing')
    expect(host.status().lastSwitch?.phase).toBe('stopping')

    host.clearGuard(1_001)
    host.tick(1_001)
    expect(host.status().guard).toBeNull()
    expect(host.status().activeRun?.artifactId).not.toBe(target.artifactId)
  })

  it('does not stop the current behavior when the target is invalid before stop', async () => {
    const host = new BehaviorHost({ bindingId: 'guard-7', query: healthQuery(() => 6), act })
    const current = await host.check({ sourcePath: source('waiting.mjs', waiting) })
    const target = await host.check({ sourcePath: source('target.mjs', done) })
    host.activate(current.artifactId)
    host.activate(target.artifactId)
    host.switch({ artifactId: current.artifactId, params: {}, commandId: 'owner' })
    host.tick(0)
    host.setGuard({
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId: target.artifactId,
      params: {},
      ttlMs: 60_000,
    }, 1_000)
    host.retire(target.artifactId)

    host.tick(1_000)
    const status = host.status()
    expect(status.lastSwitch).toMatchObject({ phase: 'precheck-failed' })
    expect(status.guard?.state).toBe('fired')
    expect(status.activeRun?.artifactId).toBe(current.artifactId)
  })

  it('reports stop-unconfirmed without starting the target', async () => {
    const control = releasableAct()
    control.release('unconfirmed')
    const host = new BehaviorHost({ bindingId: 'guard-8', query: healthQuery(() => 6), act: control.act })
    const current = await host.check({ sourcePath: source('waiting.mjs', waiting) })
    const target = await host.check({ sourcePath: source('target.mjs', done) })
    host.activate(current.artifactId)
    host.activate(target.artifactId)
    host.switch({ artifactId: current.artifactId, params: {}, commandId: 'owner' })
    host.tick(0)
    host.setGuard({
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId: target.artifactId,
      params: {},
      ttlMs: 60_000,
    }, 1_000)

    host.tick(1_000)
    host.tick(1_001)
    const status = host.status()
    expect(status.guard?.state).toBe('error')
    expect(status.lastSwitch?.phase).toBe('failed')
    expect(status.activeRun?.artifactId).not.toBe(target.artifactId)
  })

  it('disables the guard after three completed failures', async () => {
    const query: QueryPort = () => ({
      status: 'failed',
      error: p2Error('QUERY_FAILED', 'runtime', 'health unavailable', { module: 'test.guard' }),
    })
    const host = new BehaviorHost({ bindingId: 'guard-5', query, act })
    const target = await host.check({ sourcePath: source('target.mjs', done) })
    host.activate(target.artifactId)
    host.setGuard({
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId: target.artifactId,
      params: {},
      ttlMs: 60_000,
    }, 0)

    host.tick(0)
    host.tick(250)
    expect(host.status().guard?.state).toBe('active')
    host.tick(500)
    const status = host.status()
    expect(status.guard?.state).toBe('error')
    expect(status.lastSwitch).toBeNull()
    expect(status.guardEvents?.filter(event => event.phase === 'error')).toHaveLength(4)
  })
})

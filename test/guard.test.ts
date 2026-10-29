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

async function targetHost(bindingId: string, query: QueryPort = healthQuery(() => 6), actPort: ActPort = act): Promise<{
  host: BehaviorHost
  targetArtifactId: string
}> {
  const host = new BehaviorHost({ bindingId, query, act: actPort })
  const target = await host.check({ sourcePath: source('target.mjs', done) })
  host.activate(target.artifactId)
  return { host, targetArtifactId: target.artifactId }
}

describe('guard contract', () => {
  it('fires once from idle and starts the target', async () => {
    let health: JsonValue = 6
    const { host, targetArtifactId } = await targetHost('guard-1', healthQuery(() => health))
    const guard = host.setGuard({
      guardId: 'low-health',
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 1_000)
    expect(guard).toMatchObject({ id: 'low-health', priority: 0, state: 'active' })

    host.tick(1_000)
    const fired = host.status()
    expect(fired.guards[0]).toMatchObject({ state: 'fired', condition: { kind: 'health', hpBelow: 10 } })
    expect(fired.lastSwitch).toMatchObject({ phase: 'started', targetArtifactId, fromRunId: null })
    expect(fired.activeRun?.artifactId).toBe(targetArtifactId)
    expect(fired.guardEvents?.map(event => event.phase)).toEqual(['armed', 'fired', 'started'])
    const firstAttempt = fired.guards[0]?.attemptId

    health = 1
    host.tick(2_000)
    const after = host.status()
    expect(after.guards[0]?.attemptId).toBe(firstAttempt)
    expect(after.guardEvents?.filter(event => event.phase === 'fired')).toHaveLength(1)
    expect(after.guardEvents?.filter(event => event.phase === 'started')).toHaveLength(1)
  })

  it('expires without firing when ttl elapses', async () => {
    const { host, targetArtifactId } = await targetHost('guard-2', healthQuery(() => 6))
    host.setGuard({
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId,
      params: {},
      ttlMs: 10_000,
    }, 0)

    host.tick(10_001)
    const status = host.status()
    expect(status.guards[0]?.state).toBe('expired')
    expect(status.lastSwitch).toBeNull()
    expect(status.activeRun).toBeNull()
    expect(status.guardEvents?.some(event => event.phase === 'fired')).toBe(false)
  })

  it('clears one guard or all guards without touching the behavior', async () => {
    const { host, targetArtifactId } = await targetHost('guard-3')
    host.setGuard({
      guardId: 'a',
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 0)
    host.setGuard({
      guardId: 'b',
      condition: { kind: 'health', hpBelow: 15 },
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 0)

    expect(host.clearGuard('a', 100)).toMatchObject({ cleared: 1 })
    expect(host.status().guards.map(guard => guard.id)).toEqual(['b'])
    expect(host.status().guardEvents?.at(-1)?.phase).toBe('cleared')

    expect(host.clearGuard(undefined, 200)).toMatchObject({ cleared: 1 })
    expect(host.status().guards).toEqual([])
  })

  it('replaces a guard with the same id and keeps its position', async () => {
    const { host, targetArtifactId } = await targetHost('guard-3b')
    host.setGuard({ guardId: 'first', condition: { kind: 'health', hpBelow: 10 }, targetArtifactId, params: {}, ttlMs: 60_000 }, 0)
    host.setGuard({ guardId: 'second', condition: { kind: 'health', hpBelow: 5 }, targetArtifactId, params: {}, ttlMs: 60_000 }, 0)
    const replaced = host.setGuard({
      guardId: 'first',
      priority: 7,
      condition: { kind: 'health', hpBelow: 4 },
      targetArtifactId,
      params: {},
      ttlMs: 30_000,
    }, 1_000)

    expect(replaced).toMatchObject({ id: 'first', priority: 7, armedAt: 1_000, state: 'active' })
    expect(host.status().guards.map(guard => guard.id)).toEqual(['first', 'second'])
    expect(host.status().guards[0]?.condition).toEqual({ kind: 'health', hpBelow: 4 })
    expect(host.status().guardEvents?.filter(event => event.phase === 'armed')).toHaveLength(3)
  })

  it('accepts multiple guards and rejects the ninth', async () => {
    const { host, targetArtifactId } = await targetHost('guard-3c')
    for (let index = 0; index < 8; index += 1) {
      host.setGuard({
        guardId: `g${index}`,
        priority: index,
        condition: { kind: 'health', hpBelow: 10 },
        targetArtifactId,
        params: {},
        ttlMs: 60_000,
      }, 0)
    }
    expect(host.status().guards).toHaveLength(8)
    expect(() => host.setGuard({
      guardId: 'g8',
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 0)).toThrow(/at most 8/u)

    // Settled records are pruned before the limit is enforced.
    for (let index = 0; index < 8; index += 1) host.tick(120_000 + index)
    expect(host.status().guards.every(guard => guard.state === 'expired')).toBe(true)
    expect(() => host.setGuard({
      guardId: 'g8',
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 200_000)).not.toThrow()
    expect(host.status().guards.map(guard => guard.id)).toEqual(['g8'])
  })

  it('clears all guards when the host is disposed', async () => {
    const { host, targetArtifactId } = await targetHost('guard-3d')
    host.setGuard({ condition: { kind: 'health', hpBelow: 10 }, targetArtifactId, params: {}, ttlMs: 60_000 }, 0)
    expect(host.status().guards).toHaveLength(1)
    host.dispose()
    expect(host.status().guards).toEqual([])
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
    const { host, targetArtifactId } = await targetHost('guard-4', query)
    host.setGuard({
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 0)

    host.tick(0)
    host.tick(250)
    host.tick(500)
    expect(calls).toBe(1)
    expect(host.status().guards[0]?.state).toBe('active')

    pending = false
    host.tick(750)
    expect(calls).toBe(1)
    expect(host.status().guards[0]?.state).toBe('fired')
  })

  it('clears a fired guard before its pending target starts', async () => {
    const { host } = await targetHost('guard-6')
    const current = await host.check({ sourcePath: source('waiting.mjs', waiting) })
    const target = await host.check({ sourcePath: source('target.mjs', done) })
    host.activate(current.artifactId)
    host.activate(target.artifactId)
    const switched = host.switch({ artifactId: current.artifactId, params: {}, commandId: 'owner' })
    expect(switched.accepted).toBe(true)
    host.tick(0)

    host.setGuard({
      guardId: 'pending',
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId: target.artifactId,
      params: {},
      ttlMs: 60_000,
    }, 1_000)
    host.tick(1_000)
    expect(host.status().guards[0]?.state).toBe('firing')
    expect(host.status().lastSwitch?.phase).toBe('stopping')

    host.clearGuard('pending', 1_001)
    host.tick(1_001)
    expect(host.status().guards).toEqual([])
    expect(host.status().activeRun?.artifactId).not.toBe(target.artifactId)
  })

  it('does not stop the current behavior when the target is invalid before stop', async () => {
    const { host } = await targetHost('guard-7')
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
    expect(status.guards[0]?.state).toBe('fired')
    expect(status.activeRun?.artifactId).toBe(current.artifactId)
  })

  it('reports the run a guard switched away from', async () => {
    const control = releasableAct()
    const { host } = await targetHost('guard-9', healthQuery(() => 6), control.act)
    const current = await host.check({ sourcePath: source('waiting.mjs', waiting) })
    const target = await host.check({ sourcePath: source('target.mjs', done) })
    host.activate(current.artifactId)
    host.activate(target.artifactId)
    host.switch({ artifactId: current.artifactId, params: {}, commandId: 'owner' })
    host.tick(0)
    const fromRunId = host.status().activeRun?.runId
    expect(fromRunId).toBeTruthy()

    host.setGuard({
      guardId: 'switch-away',
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId: target.artifactId,
      params: {},
      ttlMs: 60_000,
    }, 1_000)
    host.tick(1_000)
    expect(host.status().lastSwitch).toMatchObject({ phase: 'stopping', fromRunId })

    control.release('released')
    host.tick(1_001)
    host.tick(1_002)
    const status = host.status()
    expect(status.lastSwitch).toMatchObject({ phase: 'started', fromRunId })
    expect(status.lastSwitch?.toRunId).toBeTruthy()
    expect(status.guards[0]?.state).toBe('fired')
  })

  it('reports stop-unconfirmed without starting the target', async () => {
    const control = releasableAct()
    control.release('unconfirmed')
    const { host } = await targetHost('guard-8', healthQuery(() => 6), control.act)
    const current = await host.check({ sourcePath: source('waiting.mjs', waiting) })
    const target = await host.check({ sourcePath: source('target.mjs', done) })
    host.activate(current.artifactId)
    host.activate(target.artifactId)
    host.switch({ artifactId: current.artifactId, params: {}, commandId: 'owner' })
    host.tick(0)
    host.setGuard({
      guardId: 'stop-fault',
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId: target.artifactId,
      params: {},
      ttlMs: 60_000,
    }, 1_000)

    host.tick(1_000)
    host.tick(1_001)
    const status = host.status()
    expect(status.guards[0]?.state).toBe('error')
    expect(status.lastSwitch?.phase).toBe('failed')
    expect(status.activeRun?.artifactId).not.toBe(target.artifactId)
  })

  it('disables a guard after three completed failures', async () => {
    const query: QueryPort = () => ({
      status: 'failed',
      error: p2Error('QUERY_FAILED', 'runtime', 'health unavailable', { module: 'test.guard' }),
    })
    const { host, targetArtifactId } = await targetHost('guard-5', query)
    host.setGuard({
      guardId: 'flaky',
      condition: { kind: 'health', hpBelow: 10 },
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 0)

    host.tick(0)
    host.tick(250)
    expect(host.status().guards[0]?.state).toBe('active')
    host.tick(500)
    const status = host.status()
    expect(status.guards[0]?.state).toBe('error')
    expect(status.lastSwitch).toBeNull()
    expect(status.guardEvents?.filter(event => event.phase === 'error')).toHaveLength(4)
  })
})

describe('policy guard conditions', () => {
  const poisonedPolicy = `
definePolicy({
  manifest: { id: 'poisoned', inputs: ['samples', 'now'], outputs: [] },
  run: () => false,
})
`

  async function policyHost(
    bindingId: string,
    query: QueryPort,
    decide: (samples: Record<string, { value?: JsonValue }>) => JsonValue,
  ): Promise<{ host: BehaviorHost; targetArtifactId: string; predicate: string }> {
    const host = new BehaviorHost({
      bindingId,
      query,
      act,
      policy: {
        call: (_ref, inputs) => ({
          status: 'ok',
          value: decide((inputs.samples ?? {}) as unknown as Record<string, { value?: JsonValue }>),
        }),
      },
      loadManifest: async () => ({ id: 'poisoned', inputs: ['samples', 'now'], outputs: [] }),
    })
    const target = await host.check({ sourcePath: source('target.mjs', done) })
    host.activate(target.artifactId)
    const predicate = await host.check({
      sourcePath: source('poison.mjs', poisonedPolicy),
      artifactKind: 'policy',
    })
    return { host, targetArtifactId: target.artifactId, predicate: predicate.artifactId }
  }

  it('fires from declared query samples and carries policy evidence', async () => {
    const query: QueryPort = ref => ref.op === 'entities'
      ? {
          status: 'ok',
          value: { nearest: 'creeper', distance: 3 },
          meta: { source: 'query', scope: 'entities', sampledAt: 1_000 },
        }
      : { status: 'ok', value: { health: 20 } }
    const { host, targetArtifactId, predicate } = await policyHost(
      'guard-policy-1',
      query,
      samples => ({
        fire: ((samples['0']?.value as { distance?: number } | undefined)?.distance ?? 99) < 5,
        evidence: { threat: 'creeper' },
      }),
    )

    host.setGuard({
      guardId: 'poison',
      condition: { kind: 'policy', queries: [{ op: 'entities' }], predicate },
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 1_000)
    host.tick(1_000)

    const status = host.status()
    expect(status.guards[0]?.state).toBe('fired')
    expect(status.lastSwitch?.phase).toBe('started')
    const fired = status.guardEvents?.find(event => event.phase === 'fired')
    expect(fired?.evidence).toMatchObject({
      samples: { '0': { status: 'ok', value: { nearest: 'creeper', distance: 3 } } },
      sampledAt: 1_000,
      policy: { threat: 'creeper' },
    })
  })

  it('does not fire on a failed query and errors after three completed failures', async () => {
    const query: QueryPort = () => ({
      status: 'failed',
      error: p2Error('QUERY_FAILED', 'runtime', 'entities unavailable', { module: 'test.guard' }),
    })
    const { host, targetArtifactId, predicate } = await policyHost('guard-policy-2', query, () => true)
    host.setGuard({
      guardId: 'poison',
      condition: { kind: 'policy', queries: [{ op: 'entities' }], predicate },
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 0)

    host.tick(0)
    host.tick(250)
    expect(host.status().guards[0]?.state).toBe('active')
    expect(host.status().guardEvents?.some(event => event.phase === 'fired')).toBe(false)
    host.tick(500)
    expect(host.status().guards[0]?.state).toBe('error')
    expect(host.status().lastSwitch).toBeNull()
  })

  it('does not fire on stale samples', async () => {
    const query: QueryPort = () => ({
      status: 'ok',
      value: { nearest: 'creeper', distance: 3 },
      meta: { source: 'query', scope: 'entities', sampledAt: 0, validUntil: 50 },
    })
    const { host, targetArtifactId, predicate } = await policyHost('guard-policy-3', query, () => true)
    host.setGuard({
      guardId: 'poison',
      condition: { kind: 'policy', queries: [{ op: 'entities' }], predicate },
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 0)

    host.tick(1_000)
    const status = host.status()
    expect(status.guards[0]?.state).toBe('active')
    expect(status.guards[0]?.lastError?.code).toBe('STALE_OBSERVATION')
    expect(status.guardEvents?.some(event => event.phase === 'fired')).toBe(false)
  })

  it('rejects more than four queries, unknown queries and unchecked predicates', async () => {
    const { host, targetArtifactId, predicate } = await policyHost(
      'guard-policy-4',
      healthQuery(() => 6),
      () => false,
    )
    expect(() => host.setGuard({
      condition: {
        kind: 'policy',
        queries: [{ op: 'health' }, { op: 'position' }, { op: 'inventory' }, { op: 'time' }, { op: 'entities' }],
        predicate,
      },
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 0)).toThrow(/at most 4/u)
    expect(() => host.setGuard({
      condition: { kind: 'policy', queries: [{ op: 'nope' }], predicate },
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 0)).toThrow(/unknown operation/u)
    expect(() => host.setGuard({
      condition: { kind: 'policy', queries: [{ op: 'health' }], predicate: 'p2:policy:missing' },
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 0)).toThrow(/predicate/u)
  })
})

describe('guard priority and serial switching', () => {
  const health10 = { kind: 'health' as const, hpBelow: 10 }

  it('fires the highest priority match and defers the rest without consuming them', async () => {
    const { host, targetArtifactId } = await targetHost('guard-g3-1', healthQuery(() => 6))
    host.setGuard({
      guardId: 'low',
      priority: 1,
      condition: health10,
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 1_000)
    host.setGuard({
      guardId: 'high',
      priority: 10,
      condition: health10,
      targetArtifactId,
      params: {},
      ttlMs: 60_000,
    }, 1_000)

    host.tick(1_000)
    let status = host.status()
    expect(status.lastSwitch).toMatchObject({ guardId: 'high', phase: 'started' })
    expect(status.guards.find(guard => guard.id === 'high')?.state).toBe('fired')
    expect(status.guards.find(guard => guard.id === 'low')?.state).toBe('active')
    expect(status.guardEvents?.filter(event => event.phase === 'deferred').map(event => event.guardId))
      .toEqual(['low'])

    // The authorization was kept, so the deferred guard fires on re-evaluation.
    host.tick(1_250)
    status = host.status()
    expect(status.guards.find(guard => guard.id === 'low')?.state).toBe('fired')
    expect(status.lastSwitch).toMatchObject({ guardId: 'low', phase: 'started' })
  })

  it('breaks priority ties by registration order', async () => {
    const { host, targetArtifactId } = await targetHost('guard-g3-2', healthQuery(() => 6))
    host.setGuard({ guardId: 'first', condition: health10, targetArtifactId, params: {}, ttlMs: 60_000 }, 1_000)
    host.setGuard({ guardId: 'second', condition: health10, targetArtifactId, params: {}, ttlMs: 60_000 }, 1_000)
    host.tick(1_000)
    expect(host.status().lastSwitch).toMatchObject({ guardId: 'first', phase: 'started' })
    expect(host.status().guards.find(guard => guard.id === 'second')?.state).toBe('active')
  })

  it('defers a second match while a switch is stopping and reports it once per attempt', async () => {
    const control = releasableAct()
    const { host } = await targetHost('guard-g3-3', healthQuery(() => 6), control.act)
    const current = await host.check({ sourcePath: source('waiting.mjs', waiting) })
    host.activate(current.artifactId)
    host.switch({ artifactId: current.artifactId, params: {}, commandId: 'owner' })
    host.tick(0)
    host.setGuard({ guardId: 'high', priority: 5, condition: health10, targetArtifactId: current.artifactId, params: {}, ttlMs: 60_000 }, 1_000)
    host.setGuard({ guardId: 'low', condition: health10, targetArtifactId: current.artifactId, params: {}, ttlMs: 60_000 }, 1_000)

    host.tick(1_000)
    expect(host.status().lastSwitch).toMatchObject({ guardId: 'high', phase: 'stopping' })
    host.tick(1_250)
    expect(host.status().guards.find(guard => guard.id === 'low')?.state).toBe('deferred')
    const first = host.status().guardEvents?.filter(event => event.phase === 'deferred' && event.guardId === 'low') ?? []
    expect(first).toHaveLength(1)
    expect(first[0]?.attemptId).toBeTruthy()
    host.tick(1_500)
    expect(host.status().guardEvents?.filter(event => event.phase === 'deferred' && event.guardId === 'low'))
      .toHaveLength(1)

    control.release('released')
    host.tick(1_501)
    // The deferred guard re-evaluates as soon as the winner's switch settles;
    // assert the winner did start rather than the final lastSwitch owner.
    expect(host.status().guardEvents?.some(event => event.phase === 'started' && event.guardId === 'high'))
      .toBe(true)
  })

  it('does not start a pending target after the guard TTL expires', async () => {
    const control = releasableAct()
    const { host } = await targetHost('guard-g3-4', healthQuery(() => 6), control.act)
    const current = await host.check({ sourcePath: source('waiting.mjs', waiting) })
    const target = await host.check({ sourcePath: source('target.mjs', done) })
    host.activate(current.artifactId)
    host.activate(target.artifactId)
    host.switch({ artifactId: current.artifactId, params: {}, commandId: 'owner' })
    host.tick(0)
    host.setGuard({
      guardId: 'expiring',
      condition: health10,
      targetArtifactId: target.artifactId,
      params: {},
      ttlMs: 10_000,
    }, 1_000)
    host.tick(1_000)
    expect(host.status().lastSwitch).toMatchObject({ phase: 'stopping' })

    host.tick(11_001)
    expect(host.status().guards[0]?.state).toBe('expired')
    control.release('released')
    host.tick(11_002)
    expect(host.status().activeRun?.artifactId ?? null).not.toBe(target.artifactId)
  })

  it('suppresses the old attempt when a guard is replaced during a pending switch', async () => {
    const control = releasableAct()
    const { host } = await targetHost('guard-g3-5', healthQuery(() => 6), control.act)
    const current = await host.check({ sourcePath: source('waiting.mjs', waiting) })
    const target = await host.check({ sourcePath: source('target.mjs', done) })
    host.activate(current.artifactId)
    host.activate(target.artifactId)
    host.switch({ artifactId: current.artifactId, params: {}, commandId: 'owner' })
    host.tick(0)
    host.setGuard({
      guardId: 'same',
      condition: health10,
      targetArtifactId: target.artifactId,
      params: {},
      ttlMs: 60_000,
    }, 1_000)
    host.tick(1_000)
    expect(host.status().lastSwitch?.phase).toBe('stopping')

    const replaced = host.setGuard({
      guardId: 'same',
      priority: 2,
      condition: { kind: 'health', hpBelow: 5 },
      targetArtifactId: target.artifactId,
      params: {},
      ttlMs: 60_000,
    }, 1_001)
    expect(replaced).toMatchObject({ id: 'same', state: 'active' })

    control.release('released')
    host.tick(1_002)
    host.tick(1_003)
    const status = host.status()
    expect(status.activeRun?.artifactId ?? null).not.toBe(target.artifactId)
    expect(status.guardEvents?.some(event => event.phase === 'suppressed' && event.guardId === 'same')).toBe(true)
  })
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { p2Error } from '../src/contracts/protocol.ts'
import type { JsonValue } from '../src/contracts/types.ts'
import { BehaviorHost } from '../src/core/host.ts'
import type { ActPort, QueryOutcome, QueryPort } from '../src/core/node-runtime.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const act: ActPort = { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) }

function source(name: string, body: string): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-watch-'))
  dirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

const PREDICATE = `
definePolicy({
  manifest: { id: 'watch-predicate', inputs: ['samples', 'now'], outputs: [] },
  run: () => false,
})
`

type PredicateInputs = Record<string, { value?: JsonValue }>

async function watchHost(
  bindingId: string,
  query: QueryPort,
  predicate: (samples: PredicateInputs, now: number) => JsonValue,
): Promise<{ host: BehaviorHost; predicate: string }> {
  const host = new BehaviorHost({
    bindingId,
    query,
    act,
    policy: {
      call: (_ref, inputs) => ({
        status: 'ok',
        value: predicate(inputs.samples as unknown as PredicateInputs, Number(inputs.now)),
      }),
    },
    loadManifest: async () => ({ id: 'watch-predicate', inputs: ['samples', 'now'], outputs: [] }),
  })
  const artifact = await host.check({
    sourcePath: source('predicate.mjs', PREDICATE),
    artifactKind: 'policy',
  })
  return { host, predicate: artifact.artifactId }
}

function health(value: () => JsonValue): QueryPort {
  return () => ({ status: 'ok', value: value() })
}

describe('watch registration and edge control', () => {
  it('notifies once on a rising edge and not while the condition stays true', async () => {
    const { host, predicate } = await watchHost('watch-1', health(() => ({ poisoned: true })), samples =>
      (samples['0']?.value as { poisoned?: boolean } | undefined)?.poisoned === true)
    const watch = host.addWatch({
      queries: [{ op: 'health' }],
      predicate,
      ttlMs: 60_000,
    }, 0)
    expect(watch).toMatchObject({ state: 'active', edge: 'rising', cooldownMs: 5_000 })

    host.tick(0)
    expect(host.status().watchEvents).toHaveLength(1)
    expect(host.status().watchEvents?.[0]).toMatchObject({ watchId: watch.id, key: null })
    host.tick(500)
    host.tick(1_000)
    host.tick(1_500)
    expect(host.status().watchEvents).toHaveLength(1)
    expect(host.status().watches?.[0]?.lastFire).toBe(0)
  })

  it('treats a key change as a new event and deduplicates the same key', async () => {
    let key = 'a'
    const { host, predicate } = await watchHost('watch-2', health(() => ({ value: key })), samples => ({
      fire: true,
      key: String((samples['0']?.value as { value?: string } | undefined)?.value),
    }))
    host.addWatch({ queries: [{ op: 'health' }], predicate, cooldownMs: 1_000, ttlMs: 60_000 }, 0)

    host.tick(0)
    key = 'b'
    host.tick(1_000)
    host.tick(1_500)
    const events = host.status().watchEvents ?? []
    expect(events.map(event => event.key)).toEqual(['a', 'b'])
  })

  it('suppresses events inside the per-watch cooldown', async () => {
    let counter = 0
    const { host, predicate } = await watchHost('watch-3', health(() => null), () => ({
      fire: true,
      key: `k-${++counter}`,
    }))
    const watch = host.addWatch({ queries: [{ op: 'health' }], predicate, cooldownMs: 1_000, ttlMs: 60_000 }, 0)

    host.tick(0)
    host.tick(500)
    expect(host.status().watchEvents).toHaveLength(1)
    expect(host.status().watches?.[0]?.suppressed).toBe(1)
    host.tick(1_000)
    expect(host.status().watchEvents).toHaveLength(2)
    expect(host.status().watches?.find(candidate => candidate.id === watch.id)?.suppressed).toBe(1)
  })

  it('drops events above the global 60/min rate and counts them per watch', async () => {
    let counter = 0
    const { host, predicate } = await watchHost('watch-4', health(() => null), () => ({
      fire: true,
      key: `k-${++counter}`,
    }))
    for (let index = 0; index < 16; index += 1) {
      host.addWatch({ queries: [{ op: 'health' }], predicate, cooldownMs: 1_000, ttlMs: 60_000 }, 0)
    }
    for (const at of [0, 1_000, 2_000, 3_000, 4_000]) host.tick(at)

    const status = host.status()
    expect(status.watchEvents).toHaveLength(60)
    expect((status.watches ?? []).reduce((sum, watch) => sum + watch.dropped, 0)).toBe(20)
    expect(status.watchEventSeq).toBe(60)
  })

  it('marks a watch error after three completed failures', async () => {
    const query: QueryPort = () => ({
      status: 'failed',
      error: p2Error('QUERY_FAILED', 'runtime', 'health unavailable', { module: 'test.watch' }),
    })
    const { host, predicate } = await watchHost('watch-5', query, () => true)
    host.addWatch({ queries: [{ op: 'health' }], predicate, ttlMs: 60_000 }, 0)

    host.tick(0)
    host.tick(500)
    expect(host.status().watches?.[0]?.state).toBe('active')
    host.tick(1_000)
    const status = host.status()
    expect(status.watches?.[0]?.state).toBe('error')
    expect(status.watchEvents).toHaveLength(0)
  })

  it('does not count a pending query as a failure', async () => {
    let pending = true
    const query: QueryPort = () => {
      const poll = (): QueryOutcome => pending
        ? { status: 'pending', poll }
        : { status: 'ok', value: { poisoned: true } }
      return { status: 'pending', poll }
    }
    const { host, predicate } = await waitHost('watch-6', query)
    host.addWatch({ queries: [{ op: 'health' }], predicate, ttlMs: 60_000 }, 0)

    host.tick(0)
    host.tick(500)
    expect(host.status().watches?.[0]?.state).toBe('active')
    expect(host.status().watches?.[0]?.lastError).toBeUndefined()
    pending = false
    host.tick(1_000)
    expect(host.status().watchEvents).toHaveLength(1)
  })

  it('expires by TTL without notifying', async () => {
    const { host, predicate } = await watchHost('watch-7', health(() => ({ poisoned: true })), () => true)
    host.addWatch({ queries: [{ op: 'health' }], predicate, ttlMs: 1_000 }, 0)
    host.tick(1_500)
    expect(host.status().watches?.[0]?.state).toBe('expired')
    expect(host.status().watchEvents).toHaveLength(0)
  })

  it('notifies on a falling edge only', async () => {
    let present = true
    const { host, predicate } = await watchHost('watch-8', health(() => ({ present })), samples =>
      (samples['0']?.value as { present?: boolean } | undefined)?.present === true)
    host.addWatch({ queries: [{ op: 'health' }], predicate, edge: 'falling', ttlMs: 60_000 }, 0)

    host.tick(0)
    expect(host.status().watchEvents).toHaveLength(0)
    present = false
    host.tick(500)
    expect(host.status().watchEvents).toHaveLength(1)
    host.tick(1_000)
    expect(host.status().watchEvents).toHaveLength(1)
  })

  it('enforces registration limits and removes watches explicitly', async () => {
    const { host, predicate } = await watchHost('watch-9', health(() => null), () => false)
    for (let index = 0; index < 16; index += 1) {
      host.addWatch({ queries: [{ op: 'health' }], predicate, ttlMs: 60_000 }, 0)
    }
    expect(host.listWatches()).toHaveLength(16)
    expect(() => host.addWatch({ queries: [{ op: 'health' }], predicate, ttlMs: 60_000 }, 0))
      .toThrow(/at most 16/u)
    expect(() => host.addWatch({
      queries: [{ op: 'health' }, { op: 'position' }, { op: 'inventory' }, { op: 'time' }, { op: 'entities' }],
      predicate,
      ttlMs: 60_000,
    }, 0)).toThrow(/at most 4/u)
    expect(() => host.addWatch({ queries: [{ op: 'health' }], predicate, cooldownMs: 500, ttlMs: 60_000 }, 0))
      .toThrow(/cooldownMs/u)
    expect(() => host.addWatch({ queries: [{ op: 'nope' }], predicate, ttlMs: 60_000 }, 0))
      .toThrow(/unknown operation/u)
    expect(() => host.addWatch({ queries: [{ op: 'health' }], predicate: 'p2:policy:missing', ttlMs: 60_000 }, 0))
      .toThrow(/predicate/u)

    const first = host.listWatches()[0]?.id as string
    expect(host.removeWatch(first)).toMatchObject({ removed: 1 })
    expect(host.listWatches()).toHaveLength(15)
    expect(host.removeWatch()).toMatchObject({ removed: 15 })
    expect(host.listWatches()).toEqual([])
  })

  it('does not notify on stale samples and errors after three completed failures', async () => {
    const query: QueryPort = () => ({
      status: 'ok',
      value: { poisoned: true },
      meta: { source: 'query', scope: 'health', sampledAt: 0, validUntil: 50 },
    })
    const { host, predicate } = await watchHost('watch-12', query, () => true)
    host.addWatch({ queries: [{ op: 'health' }], predicate, ttlMs: 60_000 }, 0)

    host.tick(1_000)
    expect(host.status().watchEvents).toHaveLength(0)
    expect(host.status().watches?.[0]?.lastError?.code).toBe('STALE_OBSERVATION')
    host.tick(1_500)
    host.tick(2_000)
    expect(host.status().watches?.[0]?.state).toBe('error')
  })

  it('clears watches when the host is disposed', async () => {
    const { host, predicate } = await watchHost('watch-11', health(() => null), () => false)
    host.addWatch({ queries: [{ op: 'health' }], predicate, ttlMs: 60_000 }, 0)
    expect(host.listWatches()).toHaveLength(1)
    host.dispose()
    expect(host.listWatches()).toEqual([])
    expect(host.status().watchEvents).toEqual([])
  })

  it('exposes no control entry on a watch', async () => {
    const { host, predicate } = await watchHost('watch-10', health(() => null), () => false)
    host.addWatch({ queries: [{ op: 'health' }], predicate, ttlMs: 60_000 }, 0)
    const status = host.status().watches?.[0]
    expect(status).toBeDefined()
    expect(status).not.toHaveProperty('target')
    expect(status).not.toHaveProperty('attemptId')
    const internals = host as unknown as Record<string, unknown>
    expect(internals.watchStop).toBeUndefined()
    expect(internals.watchSwitch).toBeUndefined()
  })
})

/** Small helper for the pending-query case where the predicate reads a value. */
async function waitHost(bindingId: string, query: QueryPort): Promise<{ host: BehaviorHost; predicate: string }> {
  return watchHost(bindingId, query, samples =>
    (samples['0']?.value as { poisoned?: boolean } | undefined)?.poisoned === true)
}

/**
 * M1 acceptance: observation validity and bounded action memory (C3).
 *
 * Category: data/state safety. Protects: unknown is never false, TTL and scope
 * invalidation, coherence between facts used in one decision, re-verification
 * freshness, bounded hazard/failure/retry memory.
 */

import { describe, expect, it } from 'vitest'

import { ObservationBus } from '../src/controller/observation.ts'
import { ActionMemory } from '../src/controller/memory.ts'

function bus(now: { t: number }): ObservationBus {
  return new ObservationBus({ now: () => now.t, defaultTtlMs: 1000, coherenceWindowMs: 500 })
}

describe('ObservationBus (C3)', () => {
  it('never turns an unknown fact into false or an empty value', () => {
    const clock = { t: 0 }
    const observations = bus(clock)

    const missing = observations.read('oxygen')
    expect(missing.known).toBe(false)
    expect(missing.reason).toBe('missing')
    expect(missing.fact.value).toBeNull()

    observations.publish({ key: 'oxygen', value: 15, scope: 'world:overworld', sampledAt: 0, ttlMs: 100 })
    expect(observations.read('oxygen', 50)).toMatchObject({ known: true })
    const expired = observations.read('oxygen', 100)
    expect(expired.known).toBe(false)
    expect(expired.reason).toBe('expired')

    const set = observations.readMany(['oxygen', 'health'], 100)
    expect(set.values.oxygen).toBeUndefined()
    expect(set.unknown).toEqual(expect.arrayContaining(['oxygen', 'health']))
    expect(set.reasons.oxygen).toBe('expired')
  })

  it('invalidates a scope and refuses pre-recovery samples', () => {
    const clock = { t: 0 }
    const observations = bus(clock)
    observations.publish({ key: 'position', value: { x: 0 }, scope: 'world:overworld', sampledAt: 0 })
    observations.publish({ key: 'health', value: 20, scope: 'world:nether', sampledAt: 0 })

    expect(observations.invalidateScope('world:overworld')).toBe(1)
    expect(observations.read('position', 10)).toMatchObject({ known: false, reason: 'invalidated' })
    expect(observations.read('health', 10)).toMatchObject({ known: true })

    observations.publish({ key: 'position', value: { x: 1 }, scope: 'world:overworld', sampledAt: 20 })
    expect(observations.read('position', 30, { freshSince: 21 })).toMatchObject({
      known: false,
      reason: 'stale-before-recovery',
    })
    expect(observations.read('position', 30, { freshSince: 20 })).toMatchObject({ known: true })
  })

  it('requires one coherent sample window for a multi-fact decision', () => {
    const clock = { t: 0 }
    const observations = bus(clock)
    observations.publish({ key: 'position', value: { x: 0 }, scope: 'world', sampledAt: 0 })
    observations.publish({ key: 'inventory', value: [], scope: 'world', sampledAt: 600 })

    const split = observations.readMany(['position', 'inventory'], 600)
    expect(split.coherent).toBe(false)
    expect(split.coherenceGapMs).toBe(600)
    // The older sample is reported unknown, so it cannot be stitched in.
    expect(split.unknown).toContain('position')
    expect(split.reasons.position).toBe('incoherent')
    expect(split.known).toEqual(['inventory'])

    observations.publish({ key: 'position', value: { x: 0 }, scope: 'world', sampledAt: 650 })
    const together = observations.readMany(['position', 'inventory'], 650)
    expect(together.coherent).toBe(true)
    expect(together.unknown).toEqual([])
  })

  it('keeps the fact store bounded', () => {
    const clock = { t: 0 }
    const observations = new ObservationBus({ now: () => clock.t, maxFacts: 2 })
    for (let index = 0; index < 4; index += 1) {
      observations.publish({ key: `fact-${index}`, value: index, scope: 'world', sampledAt: index })
    }
    expect(observations.snapshot()).toHaveLength(2)
  })
})

describe('ActionMemory (C3)', () => {
  it('keeps bounded hazard and failure history', () => {
    const clock = { t: 0 }
    const memory = new ActionMemory({ now: () => clock.t, maxHazards: 2, maxFailures: 2, hazardTtlMs: 100 })

    memory.recordHazard({ hazardId: 'a', kind: 'water', area: { x: 0, y: 0, z: 0, radius: 1 }, at: 0, dimension: 'overworld' })
    memory.recordHazard({ hazardId: 'b', kind: 'creeper', area: { x: 5, y: 0, z: 0, radius: 2 }, at: 0, dimension: 'overworld' })
    memory.recordHazard({ hazardId: 'c', kind: 'lava', area: { x: 9, y: 0, z: 0, radius: 1 }, at: 0 })
    expect(memory.hazards(0).map(hazard => hazard.hazardId)).toEqual(['b', 'c'])
    expect(memory.hazards(101)).toHaveLength(0)

    memory.recordFailure({ goal: 'dig:1,2,3', reason: 'MOVE_TO_BLOCKED', at: 0 })
    memory.recordFailure({ goal: 'dig:4,5,6', reason: 'ACT_TIMEOUT', at: 0 })
    memory.recordFailure({ goal: 'dig:7,8,9', reason: 'GOTO_NO_PATH', at: 0 })
    expect(memory.failures(0)).toHaveLength(2)
    expect(memory.failuresFor('dig:1,2,3', 0)).toHaveLength(0)
    expect(memory.failuresFor('dig:7,8,9', 0)).toHaveLength(1)
  })

  it('finds remembered hazards by area and dimension', () => {
    const clock = { t: 0 }
    const memory = new ActionMemory({ now: () => clock.t })
    memory.recordHazard({ hazardId: 'water', kind: 'water', area: { x: 0, y: 64, z: 0, radius: 3 }, at: 0, dimension: 'overworld' })

    expect(memory.hazardsAt({ x: 2, y: 64, z: 0 }, 'overworld', 10)).toHaveLength(1)
    expect(memory.hazardsAt({ x: 2, y: 64, z: 0 }, 'nether', 10)).toHaveLength(0)
    expect(memory.hazardsAt({ x: 20, y: 64, z: 0 }, 'overworld', 10)).toHaveLength(0)
  })

  it('bounds retries and resets the budget after the window', () => {
    const clock = { t: 0 }
    const memory = new ActionMemory({ now: () => clock.t, retryWindowMs: 1000 })
    expect(memory.spendRetry('escape', 2, 0)).toBe(1)
    expect(memory.spendRetry('escape', 2, 0)).toBe(2)
    expect(memory.spendRetry('escape', 2, 0)).toBeUndefined()
    expect(memory.retryRemaining('escape', 2, 0)).toBe(0)
    expect(memory.spendRetry('escape', 2, 1000)).toBe(1)
  })
})

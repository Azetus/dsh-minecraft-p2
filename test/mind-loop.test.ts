import { describe, expect, it } from 'vitest'

import { MindLoop } from '../src/mind/loop.ts'
import type { Candidate, WorldView } from '../src/mind/types.ts'
import type { TreeResult } from '../src/mind/tree.ts'
import type { JobTracker } from '../src/mind/tracker.ts'

/**
 * Category: state/contract (todo M1-02/M1-05 loop).
 * Protects: the constant tree is offered every tick, the main tree only while
 * idle and past the idle delay, and definition errors never turn into jobs.
 */

function candidate(keys: string): Candidate {
  return {
    driverId: 'move',
    target: { kind: 'point', pos: { x: 1, y: 64, z: 0 } },
    params: { x: 1, y: 64, z: 0 },
    keys,
  }
}

function world(stale = false): WorldView {
  return {
    self: {
      pos: { x: 0.5, y: 64, z: 0.5 },
      yaw: 0,
      pitch: 0,
      health: 20,
      food: 20,
      onGround: true,
      inWater: false,
      inLava: false,
    },
    time: { timeOfDay: 1000, worldAge: 100 },
    ...(stale ? { stale: true } : {}),
    blockAt: () => null,
    blocksIn: () => [],
    entitiesIn: () => [],
  }
}

type FakeTracker = {
  offers: Array<Candidate | null>
  ticks: number
  stateValue: 'idle' | 'running'
  state(): string
  offer(candidate: Candidate | null): void
  tick(): void
}

function fakeTracker(): FakeTracker {
  const tracker: FakeTracker = {
    offers: [],
    ticks: 0,
    stateValue: 'idle',
    state: () => tracker.stateValue,
    offer: value => tracker.offers.push(value),
    tick: () => { tracker.ticks += 1 },
  }
  return tracker
}

describe('mind loop', () => {
  it('offers the constant tree every tick and still ticks the tracker', () => {
    const tracker = fakeTracker()
    tracker.stateValue = 'running'
    let now = 0
    const loop = new MindLoop({
      world: () => world(),
      evaluate: tree => tree === 'constant' ? { kind: 'job', candidate: candidate('escape:lava') } : { kind: 'nowork' },
      tracker: tracker as unknown as JobTracker,
      now: () => now,
    })
    loop.tick()
    now = 50
    loop.tick()
    expect(tracker.offers.map(entry => entry?.keys)).toEqual(['escape:lava', 'escape:lava'])
    expect(tracker.ticks).toBe(2)
  })

  it('offers the main tree only while idle and past the idle delay', () => {
    const tracker = fakeTracker()
    let now = 0
    let mainCalls = 0
    const loop = new MindLoop({
      world: () => world(),
      evaluate: tree => {
        if (tree === 'constant') return { kind: 'nowork' }
        mainCalls += 1
        return { kind: 'job', candidate: candidate('wander:1,64,0') }
      },
      tracker: tracker as unknown as JobTracker,
      now: () => now,
      mainIdleDelayMs: 20_000,
    })
    loop.tick()
    expect(mainCalls).toBe(1)
    expect(tracker.offers.at(-1)?.keys).toBe('wander:1,64,0')

    now = 5_000
    loop.tick()
    expect(mainCalls).toBe(1)

    tracker.stateValue = 'running'
    now = 30_000
    loop.tick()
    expect(mainCalls).toBe(1)

    tracker.stateValue = 'idle'
    now = 31_000
    loop.tick()
    expect(mainCalls).toBe(2)
  })

  it('does not offer anything while the world is stale', () => {
    const tracker = fakeTracker()
    const loop = new MindLoop({
      world: () => world(true),
      evaluate: () => ({ kind: 'need-observation', reason: 'stale-snapshot' }),
      tracker: tracker as unknown as JobTracker,
    })
    loop.tick()
    expect(tracker.offers).toHaveLength(0)
    expect(tracker.ticks).toBe(1)
  })

  it('reports a definition error without offering a job', () => {
    const events: string[] = []
    const tracker = fakeTracker()
    const loop = new MindLoop({
      world: () => world(),
      evaluate: (): TreeResult => ({
        kind: 'definition-error',
        error: { code: 'DEFINITION_ERROR', category: 'validation', message: 'bad ref', source: { module: 'test' }, retry: 'never' },
      }),
      tracker: tracker as unknown as JobTracker,
      onEvent: event => events.push(event.kind),
    })
    loop.tick()
    expect(tracker.offers).toHaveLength(0)
    expect(events).toContain('mind.definition-error')
  })

  it('survives a world sample error and reports it', () => {
    const events: string[] = []
    const tracker = fakeTracker()
    const loop = new MindLoop({
      world: () => { throw new Error('no snapshot') },
      evaluate: () => ({ kind: 'nowork' }),
      tracker: tracker as unknown as JobTracker,
      onEvent: event => events.push(event.kind),
    })
    loop.tick()
    expect(tracker.ticks).toBe(0)
    expect(events).toEqual(['mind.world-error'])
  })
})

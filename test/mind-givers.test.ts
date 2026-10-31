import { describe, expect, it } from 'vitest'

import { createEscapeGiver } from '../src/mind/givers/escape.ts'
import { createGoHomeGiver, createWanderGiver } from '../src/mind/givers/home.ts'
import type { Candidate, EvalCtx } from '../src/mind/types.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { EntityInfo, SelfInfo } from '../src/port/index.ts'

/**
 * Category: state safety / contract (todo M1-05).
 * Protects: escape reacts only to immediate danger, home/wander stay inside
 * their radius, and targets are standable cells from the same snapshot.
 */

function asCandidate(result: unknown): Candidate {
  if (result === null || result === undefined || typeof result !== 'object' || !('keys' in result)) {
    throw new Error(`expected a candidate, got ${JSON.stringify(result)}`)
  }
  return result as Candidate
}

function self(overrides: Partial<SelfInfo> = {}): SelfInfo {
  return {
    pos: { x: 0.5, y: 64, z: 0.5 },
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    onGround: true,
    inWater: false,
    inLava: false,
    ...overrides,
  }
}

function flatWorld(options: {
  self?: Partial<SelfInfo>
  entities?: EntityInfo[]
  radius?: number
} = {}): SnapshotWorld {
  const radius = options.radius ?? 12
  const blocks = []
  for (let x = -radius; x <= radius; x += 1) {
    for (let z = -radius; z <= radius; z += 1) {
      blocks.push({ name: 'stone', loaded: true, pos: { x, y: 63, z } })
      blocks.push({ name: 'air', loaded: true, pos: { x, y: 64, z } })
      blocks.push({ name: 'air', loaded: true, pos: { x, y: 65, z } })
    }
  }
  return new SnapshotWorld({
    self: self(options.self),
    time: { timeOfDay: 1000, worldAge: 100 },
    entities: options.entities ?? [],
    blocks,
  })
}

const ctx: EvalCtx = { now: 0, home: { x: 0, y: 64, z: 0 } }

describe('escape giver', () => {
  it('does nothing without immediate danger', () => {
    expect(createEscapeGiver().find(ctx, flatWorld())).toBeNull()
  })

  it('escapes lava to a standable neighbour', () => {
    const result = asCandidate(createEscapeGiver().find(ctx, flatWorld({ self: { inLava: true } })))
    expect(result?.driverId).toBe('move')
    expect(result?.keys).toBe('escape:lava')
    expect(result?.params).toMatchObject({ range: 1 })
  })

  it('escapes deep water', () => {
    const result = asCandidate(createEscapeGiver().find(ctx, flatWorld({ self: { inWater: true, onGround: false } })))
    expect(result?.keys).toBe('escape:water')
  })

  it('retreats from a hostile within six blocks', () => {
    const threat: EntityInfo = { id: 'c1', name: 'creeper', position: { x: 2, y: 64, z: 0 } }
    const result = asCandidate(createEscapeGiver().find(ctx, flatWorld({ entities: [threat] })))
    expect(result?.keys).toBe('escape:hostile:c1')
    const target = result?.target
    if (target === undefined || target.kind !== 'point') throw new Error('expected a point')
    expect(Math.hypot(target.pos.x - threat.position.x, target.pos.z - threat.position.z)).toBeGreaterThan(3)
  })

  it('ignores a non-hostile entity', () => {
    const cow: EntityInfo = { id: 'cow', name: 'cow', position: { x: 2, y: 64, z: 0 } }
    expect(createEscapeGiver().find(ctx, flatWorld({ entities: [cow] }))).toBeNull()
  })
})

describe('home and wander givers', () => {
  it('goes home only when outside the home radius', () => {
    const giver = createGoHomeGiver({ radius: 16 })
    expect(giver.find(ctx, flatWorld({ self: { pos: { x: 5.5, y: 64, z: 0.5 } } }))).toBeNull()
    const far = asCandidate(giver.find(ctx, flatWorld({ self: { pos: { x: 20.5, y: 64, z: 0.5 } } })))
    expect(far?.keys).toBe('home:0,64,0')
  })

  it('does not go home without a home point', () => {
    expect(createGoHomeGiver().find({ now: 0 }, flatWorld())).toBeNull()
  })

  it('wanders to a standable point inside the radius', () => {
    const result = asCandidate(createWanderGiver({ radius: 8 }).find(ctx, flatWorld()))
    expect(result?.keys.startsWith('wander:')).toBe(true)
    const target = result?.target
    if (target === undefined || target.kind !== 'point') throw new Error('expected a point')
    expect(Math.hypot(target.pos.x, target.pos.z)).toBeLessThanOrEqual(8)
    expect(Math.hypot(target.pos.x - 0.5, target.pos.z - 0.5)).toBeGreaterThanOrEqual(2)
  })

  it('returns no work when no standable cell is known', () => {
    const empty = new SnapshotWorld({
      self: self(),
      time: { timeOfDay: 1000, worldAge: 1 },
      entities: [],
      blocks: [],
    })
    expect(createWanderGiver().find(ctx, empty)).toBeNull()
  })
})

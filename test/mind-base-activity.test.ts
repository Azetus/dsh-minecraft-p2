import { describe, expect, it } from 'vitest'

import { BaseActivityController } from '../src/mind/base-activity.ts'
import { createBaseActivityGiver } from '../src/mind/givers/base-activity.ts'
import type { Candidate, EvalCtx } from '../src/mind/types.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { EntityInfo, SelfInfo } from '../src/port/index.ts'

/**
 * Category: state safety / cross-module contract.
 * Protects: the default activity has a fixed in-memory shape, records its
 * anchor only on takeover, stays inside the radius, and never turns a lost
 * escort target into a teleport or an automatic activity switch.
 */

function asCandidate(result: unknown): Candidate {
  if (result === null || typeof result !== 'object' || !('keys' in result)) {
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
  const radius = options.radius ?? 14
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
    inventory: [],
  })
}

function player(x: number, z: number, username = 'Alice'): EntityInfo {
  return {
    id: `player-${username}`,
    name: username,
    username,
    type: 'player',
    position: { x, y: 64, z },
  }
}

const ctx: EvalCtx = { now: 1_000 }

describe('base activity controller', () => {
  it('starts in wandering with a fixed default radius and no persistence', () => {
    const controller = new BaseActivityController()
    expect(controller.view()).toEqual({
      kind: 'wandering',
      state: 'inactive',
      params: { radius: 8 },
      waitingReason: null,
    })
    expect(new BaseActivityController().view().kind).toBe('wandering')
  })

  it('records the anchor on takeover and on an Agent switch while active', () => {
    const controller = new BaseActivityController()
    expect(controller.activate(1_000, { x: 3.4, y: 64.2, z: -2.1 })).toBe(true)
    expect(controller.anchor()).toEqual({ x: 3, y: 64, z: -3 })
    expect(controller.activate(1_100, { x: 9, y: 64, z: 9 })).toBe(false)

    controller.set({ kind: 'wandering', radius: 4 }, 1_200, { x: 7.9, y: 65.1, z: 2.2 })
    expect(controller.anchor()).toEqual({ x: 7, y: 65, z: 2 })
    expect(controller.view().params).toEqual({ radius: 4 })
  })

  it('rejects center and out-of-range values', () => {
    const controller = new BaseActivityController()
    expect(() => controller.set({ kind: 'wandering', center: { x: 0, y: 64, z: 0 } }, 0)).toThrow(/center/)
    expect(() => controller.set({ kind: 'wandering', radius: 9 }, 0)).toThrow(/radius/)
    expect(() => controller.set({ kind: 'escort' }, 0)).toThrow(/target/)
    expect(() => controller.set({ kind: 'escort', target: 'Alice', distance: 9 }, 0)).toThrow(/distance/)
    expect(() => controller.set({ kind: 'sleep' }, 0)).toThrow(/kind/)
  })

  it('keeps escort active and reports a lost target once', () => {
    const controller = new BaseActivityController()
    controller.activate(0, { x: 0, y: 64, z: 0 })
    controller.set({ kind: 'escort', target: 'Alice' }, 10, { x: 0, y: 64, z: 0 })
    expect(controller.view()).toMatchObject({
      kind: 'escort',
      state: 'active',
      params: { target: 'Alice', distance: 3 },
    })
    expect(controller.markWaiting('TARGET_LOST', 20)).toBe(true)
    expect(controller.markWaiting('TARGET_LOST', 30)).toBe(false)
    expect(controller.view()).toMatchObject({ kind: 'escort', state: 'active', waitingReason: 'TARGET_LOST' })
    expect(controller.clearWaiting(40)).toBe(true)
    expect(controller.view().waitingReason).toBeNull()
  })
})

describe('base.work giver', () => {
  it('does not move in idle', () => {
    const controller = new BaseActivityController()
    controller.activate(0, { x: 0, y: 64, z: 0 })
    controller.set({ kind: 'idle' }, 0, { x: 0, y: 64, z: 0 })
    expect(createBaseActivityGiver(controller).find({ now: 1_000 }, flatWorld())).toBeNull()
  })

  it('wanders inside the anchor radius and not around home', () => {
    const controller = new BaseActivityController()
    controller.activate(0, { x: 0, y: 64, z: 0 })
    const candidate = asCandidate(createBaseActivityGiver(controller).find({ now: 1_000 }, flatWorld()))
    expect(candidate.driverId).toBe('move')
    expect(candidate.keys.startsWith('base:wander:')).toBe(true)
    const x = Number(candidate.params.x)
    const z = Number(candidate.params.z)
    expect(Math.hypot(x - 0, z - 0)).toBeLessThanOrEqual(8.5)
    expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(0.9)
  })

  it('follows an escort target by name without teleporting', () => {
    const controller = new BaseActivityController()
    controller.activate(0, { x: 0, y: 64, z: 0 })
    controller.set({ kind: 'escort', target: 'Alice', distance: 3 }, 0, { x: 0, y: 64, z: 0 })
    const giver = createBaseActivityGiver(controller)
    const near = flatWorld({ entities: [player(2.5, 0.5)] })
    expect(giver.find({ now: 1_000 }, near)).toBeNull()

    const far = flatWorld({ entities: [player(10.5, 0.5)] })
    const candidate = asCandidate(giver.find({ now: 1_000 }, far))
    expect(candidate.driverId).toBe('move')
    expect(candidate.keys.startsWith('base:escort:Alice:')).toBe(true)
    // Exact arrival avoids stopping one cell short of the follow distance.
    expect(candidate.params.range).toBe(0)
    // A stand cell near the target, never the target position itself.
    expect(Number(candidate.params.x)).not.toBe(10)
  })

  it('uses a targeted entity observation before declaring a target lost', () => {
    const controller = new BaseActivityController()
    controller.activate(0, { x: 0, y: 64, z: 0 })
    controller.set({ kind: 'escort', target: 'Alice' }, 0, { x: 0, y: 64, z: 0 })
    const world = flatWorld()
    const candidate = asCandidate(createBaseActivityGiver(controller).find({
      now: 1_000,
      observeEntities: () => { world.addEntities([player(6.5, 0.5)]) },
    }, world))
    expect(candidate.keys.startsWith('base:escort:Alice:')).toBe(true)
  })

  it('stays in escort when the target cannot be observed', () => {
    const controller = new BaseActivityController()
    controller.activate(0, { x: 0, y: 64, z: 0 })
    controller.set({ kind: 'escort', target: 'Alice' }, 0, { x: 0, y: 64, z: 0 })
    const giver = createBaseActivityGiver(controller)
    expect(giver.find({ now: 1_000 }, flatWorld())).toBeNull()
    expect(controller.view()).toMatchObject({
      kind: 'escort',
      state: 'active',
      waitingReason: 'TARGET_LOST',
    })
  })
})

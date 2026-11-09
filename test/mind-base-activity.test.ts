import { describe, expect, it } from 'vitest'

import { BaseActivityController } from '../src/mind/base-activity.ts'
import { createBaseActivityGiver } from '../src/mind/givers/base-activity.ts'
import type { Candidate, EvalCtx } from '../src/mind/types.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { EntityInfo, SelfInfo } from '../src/body/api.ts'

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
  it('starts idle with no persistence', () => {
    const controller = new BaseActivityController()
    expect(controller.view()).toEqual({
      kind: 'idle',
      state: 'inactive',
      params: {},
      waitingReason: null,
    })
    expect(new BaseActivityController().view().kind).toBe('idle')
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
    controller.set({ kind: 'wandering' }, 0, { x: 0, y: 64, z: 0 })
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

  it('does not re-issue a corner goal that is outside the follow gap', () => {
    const controller = new BaseActivityController()
    controller.activate(0, { x: 0, y: 64, z: 0 })
    controller.set({ kind: 'escort', target: 'Alice', distance: 3 }, 0, { x: 0, y: 64, z: 0 })
    const giver = createBaseActivityGiver(controller)
    // A box reach around (4,64,4) would pick the corner (1,64,1), which is
    // 4.24 blocks away. Standing there leaves `flat > distance + 1`, so the old
    // logic re-issued the same instant move every 750ms.
    const candidate = asCandidate(giver.find({
      now: 1_000,
      focus: player(4.5, 4.5),
    }, flatWorld()))
    const x = Number(candidate.params.x)
    const z = Number(candidate.params.z)
    expect(Math.hypot(x - 4, z - 4)).toBeLessThanOrEqual(3.5)

    const arrived = flatWorld({
      self: { pos: { x: x + 0.5, y: 64, z: z + 0.5 } },
      entities: [player(4.5, 4.5)],
    })
    expect(giver.find({ now: 1_800 }, arrived)).toBeNull()
  })

  it('moves to a focused target that the block snapshot cannot see', () => {
    const controller = new BaseActivityController()
    controller.activate(0, { x: 0, y: 64, z: 0 })
    controller.set({ kind: 'escort', target: 'Alice', distance: 3 }, 0, { x: 0, y: 64, z: 0 })
    const candidate = asCandidate(createBaseActivityGiver(controller).find({
      now: 1_000,
      focus: player(40.5, 0.5),
    }, flatWorld()))
    expect(candidate.driverId).toBe('move')
    expect(candidate.keys).toBe('base:escort:Alice:40,64,0')
    // The goal is the target point and the move driver's range owns the gap.
    expect(candidate.params).toMatchObject({ x: 40, y: 64, z: 0, range: 3 })
    expect(candidate.params.timeoutMs).toBe(25_000)
  })

  it('keeps following a focused target with no client-side distance cap', () => {
    const controller = new BaseActivityController()
    controller.activate(0, { x: 0, y: 64, z: 0 })
    controller.set({ kind: 'escort', target: 'Alice', distance: 2 }, 0, { x: 0, y: 64, z: 0 })
    const candidate = asCandidate(createBaseActivityGiver(controller).find({
      now: 1_000,
      focus: player(200.5, 0.5),
    }, flatWorld()))
    expect(candidate.params).toMatchObject({ x: 200, y: 64, z: 0, range: 2 })
  })

  it('chases the last known position for up to two seconds before TARGET_LOST', () => {
    const controller = new BaseActivityController()
    controller.activate(0, { x: 0, y: 64, z: 0 })
    controller.set({ kind: 'escort', target: 'Alice', distance: 3 }, 0, { x: 0, y: 64, z: 0 })
    const giver = createBaseActivityGiver(controller)
    const seen = flatWorld({ entities: [player(10.5, 0.5)] })
    expect(asCandidate(giver.find({ now: 1_000 }, seen)).keys.startsWith('base:escort:Alice:')).toBe(true)

    const lost = flatWorld()
    const chase = asCandidate(giver.find({ now: 1_800 }, lost))
    expect(chase.keys.startsWith('base:escort:Alice:chase:')).toBe(true)
    expect(chase.params).toMatchObject({ x: 10, y: 64, z: 0, range: 3 })
    expect(controller.view().waitingReason).toBeNull()

    expect(giver.find({ now: 3_200 }, lost)).toBeNull()
    expect(controller.view()).toMatchObject({ kind: 'escort', state: 'active', waitingReason: 'TARGET_LOST' })
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

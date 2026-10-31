import { describe, expect, it } from 'vitest'

import { createEatDriver } from '../src/mind/drivers/eat.ts'
import { createSleepDriver } from '../src/mind/drivers/sleep.ts'
import { createGoHomeGiver, createWanderGiver, isNight } from '../src/mind/givers/home.ts'
import {
  createEatOrderGiver,
  createGoOrderGiver,
  createSleepOrderGiver,
  createWanderOrderGiver,
} from '../src/mind/givers/orders.ts'
import type { JsonValue } from '../src/contracts/types.ts'
import type { Job, WorldView } from '../src/mind/types.ts'
import type { ClientPort } from '../src/port/index.ts'

/**
 * Category: data (M4-03 idle).
 * Protects: night returns home and suppresses wandering; eating is selected
 * before the body starves.
 */

const baseSelf = {
  pos: { x: 5.5, y: 64, z: 0.5 },
  health: 1,
  food: 0,
  yaw: 0,
  pitch: 0,
  onGround: true,
  inWater: false,
  inLava: false,
}

const world = (overrides: Record<string, unknown> = {}) => ({
  self: baseSelf,
  time: { timeOfDay: 1000, worldAge: 1 },
  inventory: [],
  ...overrides,
}) as unknown as WorldView

describe('idle givers', () => {
  it('uses a tighter home radius at night', () => {
    expect(isNight(18_000)).toBe(true)
    expect(isNight(1000)).toBe(false)
    const giver = createGoHomeGiver({ radius: 16, nightRadius: 2 })
    const ctx = { now: 0, home: { x: 0, y: 64, z: 0 } }
    expect(giver.find(ctx, world())).toBeNull()
    expect(giver.find(ctx, world({ time: { timeOfDay: 18_000, worldAge: 1 } })))
      .toMatchObject({ driverId: 'move', keys: 'home:night:0,64,0' })
  })

  it('does not wander at night', () => {
    const giver = createWanderGiver({ radius: 8, cooldownMs: 0 })
    const ctx = { now: 0, home: { x: 0, y: 64, z: 0 } }
    expect(giver.find(ctx, world({ time: { timeOfDay: 18_000, worldAge: 1 } }))).toBeNull()
  })

  it('executes go/eat/sleep only from an explicit order', () => {
    const active: { order: { id: string; verb: string; params?: Record<string, JsonValue> } } = {
      order: { id: 'ord-1', verb: 'go', params: { x: 4, y: 64, z: -2 } },
    }
    const go = createGoOrderGiver(() => active)
    expect(go.find({ now: 0 }, world())).toMatchObject({
      driverId: 'move',
      target: { kind: 'point', pos: { x: 4, y: 64, z: -2 } },
    })

    active.order = { id: 'ord-2', verb: 'eat', params: {} }
    const eat = createEatOrderGiver(() => active)
    expect(eat.find({ now: 0 }, world({
      inventory: [{ slot: 36, name: 'cookie', count: 10 }],
    }))).toMatchObject({ driverId: 'eat', params: { item: 'cookie' } })

    active.order = { id: 'ord-3', verb: 'sleep', params: { x: 1, y: 64, z: 1 } }
    const sleep = createSleepOrderGiver(() => active)
    expect(sleep.find({ now: 0 }, world())).toMatchObject({ driverId: 'sleep' })
    expect(createGoOrderGiver(() => undefined).find({ now: 0 }, world())).toBeNull()
  })

  it('executes a wander order', () => {
    const wander = createWanderOrderGiver(
      () => ({ order: { id: 'ord-w', verb: 'wander' } }),
      createWanderGiver({ allowNight: true, cooldownMs: 0, radius: 6 }),
    )
    const candidate = wander.find({ now: 0, home: { x: 0, y: 64, z: 0 } }, Object.assign(world(), {
      blockAt: (p: { y: number }) => ({ name: p.y < 64 ? 'stone' : 'air', loaded: true }),
    }))
    expect(candidate).toMatchObject({ driverId: 'move' })
  })
})

describe('sleep driver', () => {
  it('moves near the bed and then sleeps', async () => {
    const calls: string[] = []
    const port = {
      moveTo: async () => { calls.push('move'); return { state: 'ok' as const, elapsedMs: 1 } },
      sleep: async () => { calls.push('sleep'); return { state: 'ok' as const, elapsedMs: 1 } },
    } as unknown as ClientPort
    const driver = createSleepDriver()
    const job = { driverId: 'sleep', params: { x: 1, y: 64, z: 1 } } as unknown as Job
    const handle = driver.start(job, { port, now: () => 1 })
    for (let index = 0; index < 100 && handle.result().state === 'running'; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    expect(handle.result()).toMatchObject({ state: 'succeeded', observed: { kind: 'sleep' } })
    expect(calls).toEqual(['move', 'sleep'])
  })
})

describe('eat driver', () => {
  it('equips food and reports the food gain', async () => {
    let food = 2
    const port = {
      self: () => ({ food }),
      equip: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
      useItem: async () => {
        food = 6
        return { state: 'ok' as const, elapsedMs: 1 }
      },
    } as unknown as ClientPort
    const driver = createEatDriver()
    const job = { driverId: 'eat', params: { item: 'cookie', durationMs: 1 } } as unknown as Job
    const handle = driver.start(job, { port, now: () => 1 })
    for (let index = 0; index < 300 && handle.result().state === 'running'; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    expect(handle.result()).toMatchObject({
      state: 'succeeded',
      observed: { kind: 'eat', foodBefore: 2, foodAfter: 6 },
    })
  })
})


import { describe, expect, it } from 'vitest'

import { createEatDriver } from '../src/mind/drivers/eat.ts'
import { createEatGiver } from '../src/mind/givers/eat.ts'
import { createGoHomeGiver, createWanderGiver, isNight } from '../src/mind/givers/home.ts'
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

  it('selects food when food is low', () => {
    const giver = createEatGiver({ threshold: 14 })
    const candidate = giver.find({ now: 0 }, world({
      inventory: [{ slot: 36, name: 'cookie', count: 10 }],
    }))
    expect(candidate).toMatchObject({ driverId: 'eat', params: { item: 'cookie' } })
    expect(giver.find({ now: 0 }, world({ self: { ...baseSelf, food: 20 } }))).toBeNull()
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

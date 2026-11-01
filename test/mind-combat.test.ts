import { describe, expect, it } from 'vitest'

import { createAttackDriver } from '../src/mind/drivers/attack.ts'
import { createAttackOrderGiver } from '../src/mind/givers/combat.ts'
import type { Job, WorldView } from '../src/mind/types.ts'
import type { ClientPort, EntityInfo } from '../src/port/index.ts'

/**
 * Category: data (P1-4 combat ROE).
 * Protects: attack is explicit; players/neutrals are protected; combat only
 * acquires allowed hostile targets.
 */

const entity = (overrides: Partial<EntityInfo> & Pick<EntityInfo, 'id' | 'name'>): EntityInfo => ({
  position: { x: 1, y: 64, z: 1 },
  type: 'hostile',
  kind: 'Hostile mobs',
  ...overrides,
})

function world(entities: EntityInfo[]): WorldView {
  return {
    self: {
      pos: { x: 0.5, y: 64, z: 0.5 },
      health: 20,
      food: 20,
      yaw: 0,
      pitch: 0,
      onGround: true,
      inWater: false,
      inLava: false,
    },
    time: { timeOfDay: 1000, worldAge: 1 },
    inventory: [],
    blockAt: () => null,
    blocksIn: () => [],
    entitiesIn: () => entities,
  } as unknown as WorldView
}

describe('combat ROE', () => {
  it('attacks only the explicit attack-order entity', () => {
    const giver = createAttackOrderGiver(() => ({
      order: { id: 'ord-a', verb: 'attack', params: { entityId: 'e1' } },
    }))
    expect(giver.find({ now: 0 }, world([entity({ id: 'e1', name: 'zombie' })]))).toMatchObject({
      driverId: 'attack',
      params: { entityId: 'e1' },
    })
    expect(giver.find({ now: 0 }, world([]))).toBeNull()
  })

  it('requires explicit allowPassive for a named passive target', () => {
    const sheep = entity({ id: 's1', name: 'sheep', type: 'animal', kind: 'Passive mobs' })
    const blocked = createAttackOrderGiver(() => ({
      order: { id: 'ord-s', verb: 'attack', params: { entityId: 's1' } },
    }))
    expect(blocked.find({ now: 0 }, world([sheep]))).toBeNull()
    const allowed = createAttackOrderGiver(() => ({
      order: { id: 'ord-s', verb: 'attack', params: { entityId: 's1', allowPassive: true } },
    }))
    expect(allowed.find({ now: 0 }, world([sheep]))).toMatchObject({
      driverId: 'attack', params: { entityId: 's1', allowPassive: true },
    })
    const player = entity({ id: 'p1', name: 'Human_Player', type: 'player', kind: 'player' })
    const playerGiver = createAttackOrderGiver(() => ({
      order: { id: 'ord-p', verb: 'attack', params: { entityId: 'p1', allowPassive: true } },
    }))
    expect(playerGiver.find({ now: 0 }, world([player]))).toBeNull()
  })

  it('executes one attack and reports success', async () => {
    const port = { self: () => world([]).self, entities: () => [entity({ id: 'z1', name: 'zombie' })],
      attack: async () => ({ state: 'ok' as const, elapsedMs: 1 }) } as unknown as ClientPort
    const driver = createAttackDriver()
    const job = { driverId: 'attack', params: { entityId: 'z1', targetName: 'zombie' } } as unknown as Job
    const handle = driver.start(job, { port, now: () => 1 })
    for (let index = 0; index < 100 && handle.result().state === 'running'; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    expect(handle.result()).toMatchObject({ state: 'succeeded', observed: { kind: 'attack', entityId: 'z1' } })
  })

  it('uses bounded attack reach and rechecks a moving target before attacking', async () => {
    let attacks = 0
    const moves: unknown[] = []
    const port = {
      self: () => world([]).self,
      entities: () => [entity({ id: 'z1', name: 'zombie', position: { x: 6, y: 64, z: 0 } })],
      moveTo: async (_target: unknown, opts: unknown) => { moves.push(opts); return { state: 'ok', elapsedMs: 1 } },
      attack: async () => { attacks++; return { state: 'ok', elapsedMs: 1 } },
    } as unknown as ClientPort
    const job = { driverId: 'attack', params: { entityId: 'z1', targetName: 'zombie' } } as unknown as Job
    const handle = createAttackDriver().start(job, { port, now: () => 1 })
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(moves).toEqual([{ range: 2.5, intent: 'attack', timeoutMs: 15_000 }])
    expect(attacks).toBe(0)
    expect(handle.result()).toMatchObject({ state: 'failed', code: 'ATTACK_TARGET_MOVED' })
  })
})

import { describe, expect, it } from 'vitest'

import { createAttackDriver } from '../src/mind/drivers/attack.ts'
import { createAttackOrderGiver, createCombatGiver } from '../src/mind/givers/combat.ts'
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

  it('never acquires players or neutrals', () => {
    const giver = createCombatGiver(() => ({
      order: {
        id: 'ord-c',
        verb: 'combat',
        params: { allowedTargets: ['zombie', 'player', 'piglin'] },
      },
    }))
    const candidate = giver.find({ now: 0 }, world([
      entity({ id: 'p1', name: 'Human_Player', type: 'player', kind: 'player' }),
      entity({ id: 'n1', name: 'piglin', type: 'mob', kind: 'Neutral mobs' }),
      entity({ id: 'z1', name: 'zombie' }),
    ]))
    expect(candidate).toMatchObject({ driverId: 'attack', params: { entityId: 'z1' } })
  })

  it('does not acquire without allowedTargets', () => {
    const giver = createCombatGiver(() => ({
      order: { id: 'ord-c', verb: 'combat', params: {} },
    }))
    expect(giver.find({ now: 0 }, world([entity({ id: 'z1', name: 'zombie' })]))).toBeNull()
  })

  it('executes one attack and reports success', async () => {
    const port = { attack: async () => ({ state: 'ok' as const, elapsedMs: 1 }) } as unknown as ClientPort
    const driver = createAttackDriver()
    const job = { driverId: 'attack', params: { entityId: 'z1', targetName: 'zombie' } } as unknown as Job
    const handle = driver.start(job, { port, now: () => 1 })
    for (let index = 0; index < 100 && handle.result().state === 'running'; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    expect(handle.result()).toMatchObject({ state: 'succeeded', observed: { kind: 'attack', entityId: 'z1' } })
  })
})

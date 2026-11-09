import { describe, expect, it } from 'vitest'

import { createContainerDriver } from '../src/mind/drivers/container.ts'
import { createCraftDriver } from '../src/mind/drivers/craft.ts'
import { createEquipDriver } from '../src/mind/drivers/equip.ts'
import { createUseDriver } from '../src/mind/drivers/use.ts'
import { createContainerOrderGiver } from '../src/mind/givers/container.ts'
import {
  createCraftOrderGiver,
  createEquipOrderGiver,
  createPlaceOrderGiver,
  createUseOrderGiver,
} from '../src/mind/givers/primitives.ts'
import type { ClientPort, Item, SelfInfo } from '../src/port/index.ts'
import type { Job, WorldView } from '../src/mind/types.ts'

const self: SelfInfo = {
  pos: { x: 0.5, y: 64, z: 0.5 },
  yaw: 0,
  pitch: 0,
  health: 20,
  food: 20,
  onGround: true,
  inWater: false,
  inLava: false,
}

function world(items: Item[] = [], blocks: Record<string, string> = {}): WorldView {
  return {
    self,
    time: { timeOfDay: 1000, worldAge: 1 },
    inventory: items,
    blockAt: p => {
      const name = blocks[`${p.x},${p.y},${p.z}`]
      return name === undefined ? null : { name, loaded: true, pos: p }
    },
    blocksIn: () => [],
    entitiesIn: () => [],
  }
}

function driverResult(driver: { start: (job: Job, ctx: { port: ClientPort; now: () => number }) => { result(): { state: string } } },
  port: ClientPort, job: Job): Promise<{ state: string; [key: string]: unknown }> {
  const handle = driver.start(job, { port, now: () => 1 })
  return new Promise(resolve => {
    const timer = setInterval(() => {
      const result = handle.result()
      if (result.state !== 'running') {
        clearInterval(timer)
        resolve(result as { state: string })
      }
    }, 2)
  })
}

describe('finite primitive orders', () => {
  it('maps place, equip, use, craft and container orders to generic drivers', () => {
    const place = createPlaceOrderGiver(() => ({ order: {
      id: 'p', verb: 'place', params: { x: -8, y: 66, z: -17, item: 'dirt' },
    } }))
    expect(place.find({ now: 0 }, world())).toMatchObject({
      driverId: 'place', params: { x: -8, y: 66, z: -17, item: 'dirt' },
    })

    const equip = createEquipOrderGiver(() => ({ order: { id: 'e', verb: 'equip', params: { item: 'stone_pickaxe' } } }))
    expect(equip.find({ now: 0 }, world())).toMatchObject({ driverId: 'equip', params: { item: 'stone_pickaxe' } })

    const use = createUseOrderGiver(() => ({ order: {
      id: 'u', verb: 'use', params: { x: -11, y: 69, z: -18 },
    } }))
    expect(use.find({ now: 0 }, world())).toMatchObject({ driverId: 'use', params: { x: -11, y: 69, z: -18 } })

    const craft = createCraftOrderGiver(() => ({ order: { id: 'c', verb: 'craft', params: { item: 'stick', count: 4 } } }))
    expect(craft.find({ now: 0 }, world())).toMatchObject({ driverId: 'craft', params: { item: 'stick', count: 4 } })

    const container = createContainerOrderGiver(() => ({ order: {
      id: 'k', verb: 'container', params: { x: -16, y: 67, z: -1, action: 'load-input', item: 'raw_iron', count: 1 },
    } }))
    expect(container.find({ now: 0 }, world())).toMatchObject({
      driverId: 'container', params: { action: 'load-input', item: 'raw_iron', count: 1 },
    })
  })

  it('equips an inventory item and fails when it is absent', async () => {
    const calls: string[] = []
    const port = {
      inventory: () => [{ slot: 36, name: 'stone_pickaxe', count: 1 }],
      equip: async (item: string) => {
        calls.push(item)
        return { state: 'ok' as const, elapsedMs: 1, observed: { item, held: item } }
      },
    } as unknown as ClientPort
    const result = await driverResult(createEquipDriver(), port,
      { driverId: 'equip', params: { item: 'stone_pickaxe' } } as unknown as Job)
    expect(result).toMatchObject({ state: 'succeeded', observed: { kind: 'equip', item: 'stone_pickaxe' } })
    expect(calls).toEqual(['stone_pickaxe'])

    const missing = { inventory: () => [], equip: async () => ({ state: 'ok' as const, elapsedMs: 1 }) } as unknown as ClientPort
    expect(await driverResult(createEquipDriver(), missing,
      { driverId: 'equip', params: { item: 'stone_pickaxe' } } as unknown as Job))
      .toMatchObject({ state: 'failed', code: 'EQUIP_ITEM_MISSING' })
  })

  it('does not succeed on equip provider ok without a held-item readback', async () => {
    const base = { inventory: () => [{ slot: 36, name: 'stone_pickaxe', count: 1 }] }
    const unknown = {
      ...base,
      equip: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    } as unknown as ClientPort
    expect(await driverResult(createEquipDriver(), unknown,
      { driverId: 'equip', params: { item: 'stone_pickaxe' } } as unknown as Job))
      .toMatchObject({ state: 'failed', code: 'EQUIP_READBACK_UNKNOWN' })

    const mismatch = {
      ...base,
      equip: async () => ({ state: 'ok' as const, elapsedMs: 1, observed: { held: 'dirt' } }),
    } as unknown as ClientPort
    expect(await driverResult(createEquipDriver(), mismatch,
      { driverId: 'equip', params: { item: 'stone_pickaxe' } } as unknown as Job))
      .toMatchObject({ state: 'failed', code: 'EQUIP_READBACK_MISMATCH' })
  })

  it('equips an off-hand item using the destination-slot readback', async () => {
    const calls: Array<{ item: string; destination: string }> = []
    const port = {
      inventory: () => [{ slot: 36, name: 'shield', count: 1 }],
      equip: async (item: string, destination?: string) => {
        calls.push({ item, destination: destination ?? 'hand' })
        return { state: 'ok' as const, elapsedMs: 1, observed: { item, destination, equipped: item } }
      },
    } as unknown as ClientPort
    const result = await driverResult(createEquipDriver(), port,
      { driverId: 'equip', params: { item: 'shield', destination: 'offhand' } } as unknown as Job)
    expect(result).toMatchObject({
      state: 'succeeded',
      observed: { kind: 'equip', item: 'shield', destination: 'offhand', equipped: 'shield' },
    })
    expect(calls).toEqual([{ item: 'shield', destination: 'offhand' }])
  })

  it('unequips the off hand and requires an empty destination readback', async () => {
    const calls: string[] = []
    const ok = (observed?: Record<string, unknown>): ClientPort => ({
      unequip: async (destination?: string) => {
        calls.push(destination ?? 'hand')
        return { state: 'ok' as const, elapsedMs: 1, ...(observed === undefined ? {} : { observed }) }
      },
    }) as unknown as ClientPort

    const empty = await driverResult(createEquipDriver(), ok({ item: null, equipped: null }),
      { driverId: 'equip', params: { unequip: true, destination: 'offhand' } } as unknown as Job)
    expect(empty).toMatchObject({ state: 'succeeded', observed: { kind: 'unequip', item: null } })

    const filled = await driverResult(createEquipDriver(), ok({ item: 'shield', equipped: null }),
      { driverId: 'equip', params: { unequip: true, destination: 'offhand' } } as unknown as Job)
    expect(filled).toMatchObject({ state: 'succeeded', observed: { kind: 'unequip', item: 'shield' } })

    expect(await driverResult(createEquipDriver(), ok(),
      { driverId: 'equip', params: { unequip: true, destination: 'offhand' } } as unknown as Job))
      .toMatchObject({ state: 'failed', code: 'UNEQUIP_READBACK_UNKNOWN' })
    expect(await driverResult(createEquipDriver(), ok({ item: 'shield', equipped: 'shield' }),
      { driverId: 'equip', params: { unequip: true, destination: 'offhand' } } as unknown as Job))
      .toMatchObject({ state: 'failed', code: 'UNEQUIP_READBACK_MISMATCH' })
    expect(calls).toEqual(['offhand', 'offhand', 'offhand', 'offhand'])
  })

  it('passes destination and unequip through order.equip', () => {
    const equip = createEquipOrderGiver(() => ({ order: {
      id: 'e-off', verb: 'equip', params: { item: 'shield', destination: 'offhand' },
    } }))
    expect(equip.find({ now: 0 }, world())).toMatchObject({
      driverId: 'equip',
      params: { item: 'shield', destination: 'offhand' },
    })
    const unequip = createEquipOrderGiver(() => ({ order: {
      id: 'e-unequip', verb: 'equip', params: { unequip: true, destination: 'offhand' },
    } }))
    expect(unequip.find({ now: 0 }, world())).toMatchObject({
      driverId: 'equip',
      params: { unequip: true, destination: 'offhand' },
    })
  })

  it('requires player/container movement before a transfer succeeds', async () => {
    const success = {
      moveTo: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
      containerTransfer: async () => ({
        state: 'ok' as const,
        elapsedMs: 1,
        observed: { playerBefore: 2, playerAfter: 1, containerBefore: 0, containerAfter: 1 },
      }),
    } as unknown as ClientPort
    expect(await driverResult(createContainerDriver(), success, {
      driverId: 'container',
      params: { x: 2, y: 63, z: 0, action: 'deposit', item: 'stone', count: 1 },
    } as unknown as Job)).toMatchObject({
      state: 'succeeded',
      observed: { playerMoved: 1, containerMoved: 1 },
    })

    const incomplete = {
      moveTo: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
      containerTransfer: async () => ({
        state: 'ok' as const,
        elapsedMs: 1,
        observed: { playerBefore: 2, playerAfter: 2, containerBefore: 0, containerAfter: 0 },
      }),
    } as unknown as ClientPort
    expect(await driverResult(createContainerDriver(), incomplete, {
      driverId: 'container',
      params: { x: 2, y: 63, z: 0, action: 'deposit', item: 'stone', count: 1 },
    } as unknown as Job)).toMatchObject({ state: 'failed', code: 'CONTAINER_INCOMPLETE' })

    const unknown = {
      moveTo: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
      containerTransfer: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    } as unknown as ClientPort
    expect(await driverResult(createContainerDriver(), unknown, {
      driverId: 'container',
      params: { x: 2, y: 63, z: 0, action: 'deposit', item: 'stone', count: 1 },
    } as unknown as Job)).toMatchObject({ state: 'failed', code: 'CONTAINER_READBACK_UNKNOWN' })
  })

  it('crafts a bounded batch and verifies the inventory readback', async () => {
    let count = 0
    const port = {
      inventory: () => (count === 0 ? [] : [{ slot: 36, name: 'stick', count }]),
      craft: async (_item: string, amount: number) => { count += amount; return { state: 'ok' as const, elapsedMs: 1 } },
    } as unknown as ClientPort
    expect(await driverResult(createCraftDriver(), port,
      { driverId: 'craft', params: { item: 'stick', count: 4 } } as unknown as Job))
      .toMatchObject({ state: 'succeeded', observed: { kind: 'craft', item: 'stick', count: 4 } })
    expect(count).toBe(4)
  })

  it('accepts a provider CRAFT_INCOMPLETE when the produced amount meets the request', async () => {
    let inventory: Array<{ slot: number; name: string; count: number }> = []
    const port = {
      inventory: () => inventory,
      craft: async () => {
        inventory = [{ slot: 36, name: 'birch_planks', count: 20 }]
        return {
          state: 'failed' as const,
          code: 'CRAFT_INCOMPLETE',
          observed: {
            item: 'birch_planks',
            requested: 20,
            neededCrafts: 5,
            crafted: 5,
            produced: 20,
            expected: 20,
          },
          elapsedMs: 1,
        }
      },
    } as unknown as ClientPort
    const result = await driverResult(createCraftDriver(), port,
      { driverId: 'craft', params: { item: 'birch_planks', count: 20 } } as unknown as Job)
    expect(result).toMatchObject({
      state: 'succeeded',
      observed: { kind: 'craft', item: 'birch_planks', attempted: 20, produced: 20, before: 0, after: 20 },
    })
  })

  it('reports a partial craft with crafted/attempted instead of a bare failure', async () => {
    let inventory = [{ slot: 36, name: 'stick', count: 3 }]
    const port = {
      inventory: () => inventory,
      craft: async () => {
        inventory = [{ slot: 36, name: 'stick', count: 5 }]
        return {
          state: 'failed' as const,
          code: 'CRAFT_INCOMPLETE',
          observed: { item: 'stick', requested: 3, crafted: 1, produced: 2, expected: 4 },
          elapsedMs: 1,
        }
      },
    } as unknown as ClientPort
    const result = await driverResult(createCraftDriver(), port,
      { driverId: 'craft', params: { item: 'stick', count: 3 } } as unknown as Job)
    expect(result).toMatchObject({
      state: 'failed',
      code: 'CRAFT_INCOMPLETE',
      observed: {
        kind: 'craft',
        item: 'stick',
        attempted: 3,
        crafted: 1,
        produced: 2,
        before: 3,
        after: 5,
      },
    })
  })

  it('uses a bed by sleeping, a block by activating it, and an item by using it', async () => {
    const calls: string[] = []
    const at = { pos: { x: 0.5, y: 64, z: 0.5 }, yaw: 0, pitch: 0, health: 20, food: 20,
      onGround: true, inWater: false, inLava: false }
    const bedPort = {
      self: () => at,
      moveTo: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
      blockAt: (p: { x: number; y: number; z: number }) => ({ name: 'red_bed', loaded: true, pos: p }),
      sleep: async () => { calls.push('sleep'); return { state: 'ok' as const, elapsedMs: 1 } },
    } as unknown as ClientPort
    expect(await driverResult(createUseDriver(), bedPort,
      { driverId: 'use', params: { x: 0, y: 64, z: 0 } } as unknown as Job))
      .toMatchObject({ state: 'succeeded', observed: { kind: 'sleep' } })
    expect(calls).toEqual(['sleep'])

    const blockPort = {
      self: () => at,
      moveTo: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
      blockAt: (p: { x: number; y: number; z: number }) => ({ name: 'oak_door', loaded: true, pos: p }),
      useOn: async () => { calls.push('useOn'); return { state: 'ok' as const, elapsedMs: 1 } },
    } as unknown as ClientPort
    expect(await driverResult(createUseDriver(), blockPort,
      { driverId: 'use', params: { x: 1, y: 64, z: 0 } } as unknown as Job))
      .toMatchObject({ state: 'succeeded', observed: { kind: 'use-on' } })

    const itemPort = {
      equip: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
      useItem: async () => { calls.push('useItem'); return { state: 'ok' as const, elapsedMs: 1 } },
    } as unknown as ClientPort
    expect(await driverResult(createUseDriver(), itemPort,
      { driverId: 'use', params: { item: 'bread' } } as unknown as Job))
      .toMatchObject({ state: 'succeeded', observed: { kind: 'use-item', item: 'bread' } })
    expect(calls).toEqual(['sleep', 'useOn', 'useItem'])
  })
})

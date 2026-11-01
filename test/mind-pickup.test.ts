import { describe, expect, it } from 'vitest'

import { createDigDriver } from '../src/mind/drivers/dig.ts'
import { pickupNearby } from '../src/mind/pickup.ts'
import type { Job } from '../src/mind/types.ts'
import type { BlockInfo, ClientPort, EntityInfo, Item, Vec3 } from '../src/port/index.ts'

const target = { x: 1, y: 64, z: 0 }

function drop(position: Vec3): EntityInfo {
  return { id: 'drop-1', name: 'item', position, item: { name: 'dirt', count: 1 } }
}

describe('pickup', () => {
  it('walks to a drop and reads the inventory increase', async () => {
    const items: Item[] = []
    let drops: EntityInfo[] = [drop({ x: 1.5, y: 64, z: 0.5 })]
    const moves: Vec3[] = []
    const port = {
      inventory: () => items,
      entities: () => drops,
      moveTo: async (position: Vec3) => {
        moves.push(position)
        items.push({ slot: 36, name: 'dirt', count: 1 })
        drops = []
        return { state: 'ok', elapsedMs: 1 }
      },
    } as unknown as ClientPort

    const result = await pickupNearby(port, target)

    expect(result).toMatchObject({ drops: 1, picked: 1, unreachable: 0, notCollected: 0 })
    expect(moves).toEqual([{ x: 1.5, y: 64, z: 0.5 }])
  })

  it('reports an unreachable drop instead of claiming a pickup', async () => {
    const port = {
      inventory: () => [],
      entities: () => [drop({ x: 1.5, y: 64, z: 0.5 })],
      blockAt: () => null,
      moveTo: async () => ({ state: 'failed', code: 'GOTO_NO_PATH', elapsedMs: 1 }),
    } as unknown as ClientPort

    const result = await pickupNearby(port, target)

    expect(result).toMatchObject({ drops: 1, picked: 0, unreachable: 1 })
  })

  it('does nothing when there is no drop entity', async () => {
    const port = {
      inventory: () => [],
      entities: () => [],
      moveTo: async () => ({ state: 'ok', elapsedMs: 1 }),
    } as unknown as ClientPort

    expect(await pickupNearby(port, target)).toMatchObject({ drops: 0, picked: 0 })
  })
})

describe('dig then pickup', () => {
  it('completes harvest only after the dropped item is collected', async () => {
    const item: Item[] = [{ slot: 36, name: 'stone_pickaxe', count: 1 }]
    let drops: EntityInfo[] = [drop({ x: 1.5, y: 64, z: 0.5 })]
    const blocks = new Map<string, BlockInfo>([['1,64,0', {
      name: 'stone', loaded: true, material: 'mineable/pickaxe', diggable: true,
      harvestTools: ['stone_pickaxe'],
    }]])
    const port = {
      self: () => ({ pos: { x: 1.5, y: 64, z: 0.5 } }),
      blockAt: (point: Vec3) => blocks.get(`${point.x},${point.y},${point.z}`) ?? null,
      inventory: () => item,
      entities: () => drops,
      equip: async () => ({ state: 'ok', elapsedMs: 1 }),
      dig: async (point: Vec3) => {
        blocks.set(`${point.x},${point.y},${point.z}`, { name: 'air', loaded: true })
        return { state: 'ok', elapsedMs: 1 }
      },
      moveTo: async () => {
        item.push({ slot: 37, name: 'cobblestone', count: 1 })
        drops = []
        return { state: 'ok', elapsedMs: 1 }
      },
    } as unknown as ClientPort

    const job = {
      driverId: 'dig', target: { kind: 'point', pos: target },
      params: { ...target, purpose: 'harvest' }, runId: 'run-1', issuedAt: 0,
      budget: { maxTicks: 600, maxWallMs: 30_000 },
    } as unknown as Job
    const handle = createDigDriver().start(job, { port, now: () => 0 })
    for (let index = 0; index < 300 && handle.result().state === 'running'; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    expect(handle.result()).toMatchObject({
      state: 'succeeded',
      observed: { kind: 'dig', dropDelta: 1, pickup: { drops: 1, picked: 1 } },
    })
  })
})

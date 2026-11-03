import { describe, expect, it } from 'vitest'

import { createDigDriver } from '../src/mind/drivers/dig.ts'
import { pickupNearby } from '../src/mind/pickup.ts'
import type { Job } from '../src/mind/types.ts'
import type { BlockInfo, ClientPort, EntityInfo, Item, Vec3 } from '../src/port/index.ts'

const target = { x: 1, y: 64, z: 0 }

function drop(position: Vec3, count = 1): EntityInfo {
  return { id: 'drop-1', name: 'item', position, width: 0.25, height: 0.25,
    item: { name: 'dirt', count } }
}

function selfAt(z = -2.5) {
  return {
    pos: { x: 0.5, y: 64, z },
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    onGround: true,
    inWater: false,
    inLava: false,
    width: 0.6,
    height: 1.8,
  }
}

function groundAt(point: Vec3): BlockInfo | null {
  if (point.y === 63) return { name: 'stone', loaded: true, solid: true }
  return { name: 'air', loaded: true }
}

describe('pickup', () => {
  it('walks to a drop and reads the inventory increase', async () => {
    const items: Item[] = []
    let drops: EntityInfo[] = [drop({ x: 1.5, y: 64, z: 0.5 })]
    const moves: Vec3[] = []
    const port = {
      self: () => selfAt(),
      blockAt: groundAt,
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
    expect(moves).toHaveLength(1)
    expect(Math.hypot(moves[0]!.x - 1, moves[0]!.z)).toBeLessThanOrEqual(3)
  })

  it('reports an unreachable drop without walking to the item position', async () => {
    let moves = 0
    const port = {
      self: () => selfAt(),
      inventory: () => [],
      entities: () => [drop({ x: 1.5, y: 64, z: 0.5 })],
      blockAt: () => null,
      moveTo: async () => { moves += 1; return { state: 'failed', code: 'GOTO_NO_PATH', elapsedMs: 1 } },
    } as unknown as ClientPort

    const result = await pickupNearby(port, target)

    expect(result).toMatchObject({ drops: 1, picked: 0, unreachable: 1 })
    // P1: an item position is not a stand cell, so a dead window means no move.
    expect(moves).toBe(0)
    expect(result.observed.standQuery).toMatchObject({
      reason: 'unloaded-window',
      unreachableReason: 'unloaded-window',
      candidates: 0,
    })
  })

  it('points at the head/feet cells when the drop has no stand cell', async () => {
    const solid = { name: 'stone', loaded: true, solid: true }
    const port = {
      self: () => selfAt(-2.5),
      inventory: () => [],
      entities: () => [drop({ x: 0.5, y: 64, z: 0.5 })],
      blockAt: () => solid,
      moveTo: async () => ({ state: 'ok', elapsedMs: 1 }),
    } as unknown as ClientPort

    const result = await pickupNearby(port, { x: 0, y: 64, z: 0 })

    expect(result).toMatchObject({ drops: 1, picked: 0, unreachable: 1 })
    const stand = result.observed.standQuery
    expect(stand).toMatchObject({ unreachableReason: 'no-stand-cell', candidates: 0 })
    expect(stand?.requiredDig).toEqual(expect.arrayContaining([
      { x: 0, y: 64, z: 0, layer: 'feet', name: 'stone' },
      { x: 0, y: 65, z: 0, layer: 'head', name: 'stone' },
    ]))
  })

  it('reports path-blocked with candidates instead of moving to proven-unreachable cells', async () => {
    const floor = (p: Vec3): BlockInfo | null => {
      if (p.y === 63 && p.x >= -4 && p.x <= 4
        && ((p.z >= 0 && p.z <= 1) || (p.z >= 4 && p.z <= 6))) {
        return { name: 'stone', loaded: true, solid: true }
      }
      return { name: 'air', loaded: true }
    }
    let moves = 0
    const port = {
      self: () => selfAt(0.5),
      inventory: () => [],
      entities: () => [drop({ x: 0.5, y: 64, z: 5.5 })],
      blockAt: floor,
      moveTo: async () => { moves += 1; return { state: 'ok', elapsedMs: 1 } },
    } as unknown as ClientPort

    const result = await pickupNearby(port, { x: 0, y: 64, z: 0 })

    expect(result).toMatchObject({ drops: 1, picked: 0, unreachable: 1 })
    expect(moves).toBe(0)
    const stand = result.observed.standQuery
    expect(stand).toMatchObject({ coverage: 'complete', unreachableReason: 'path-blocked' })
    expect(stand?.candidateCells?.some(candidate => candidate.reachable === 'no')).toBe(true)
  })

  it('counts an automatic pickup even when the move reports failure', async () => {
    const items: Item[] = []
    const port = {
      self: () => selfAt(),
      blockAt: groundAt,
      inventory: () => items,
      entities: () => [drop({ x: 1.5, y: 64, z: 0.5 })],
      moveTo: async () => {
        items.push({ slot: 36, name: 'dirt', count: 1 })
        return { state: 'failed', code: 'GOTO_NO_PATH', elapsedMs: 1 }
      },
    } as unknown as ClientPort

    const result = await pickupNearby(port, target)

    expect(result).toMatchObject({ drops: 1, picked: 1, unreachable: 0 })
  })

  it('does nothing when there is no drop entity', async () => {
    const port = {
      self: () => selfAt(),
      blockAt: groundAt,
      inventory: () => [],
      entities: () => [],
      moveTo: async () => ({ state: 'ok', elapsedMs: 1 }),
    } as unknown as ClientPort

    expect(await pickupNearby(port, target)).toMatchObject({ drops: 0, picked: 0 })
  })

  it('reports a full inventory instead of not-collected', async () => {
    const full: Item[] = Array.from({ length: 36 }, (_, index) => ({
      slot: 9 + index,
      name: 'dirt',
      count: 1,
    }))
    const port = {
      self: () => selfAt(0.5),
      blockAt: groundAt,
      inventory: () => full,
      entities: () => [drop({ x: 1.5, y: 64, z: 0.5 })],
      moveTo: async () => ({ state: 'ok', elapsedMs: 1 }),
    } as unknown as ClientPort

    const result = await pickupNearby(port, target)
    expect(result).toMatchObject({ drops: 1, picked: 0, full: 1, notCollected: 0 })
  })

  it('reports an item that disappeared after the wait', async () => {
    let calls = 0
    const port = {
      self: () => selfAt(0.5),
      blockAt: groundAt,
      inventory: () => [],
      entities: () => {
        calls += 1
        return calls === 1 ? [drop({ x: 1.5, y: 64, z: 0.5 })] : []
      },
      moveTo: async () => ({ state: 'ok', elapsedMs: 1 }),
    } as unknown as ClientPort

    const result = await pickupNearby(port, target)
    expect(result).toMatchObject({ drops: 1, picked: 0, gone: 1 })
    expect(result.observed.items[0]?.presentAfter).toBe(false)
  })

  it('reports a partial pickup while the entity remains', async () => {
    const items: Item[] = []
    let drops: EntityInfo[] = [drop({ x: 1.5, y: 64, z: 0.5 }, 2)]
    const port = {
      self: () => selfAt(),
      blockAt: groundAt,
      inventory: () => items,
      entities: () => drops,
      moveTo: async () => {
        items.push({ slot: 36, name: 'dirt', count: 1 })
        drops = [drop({ x: 1.5, y: 64, z: 0.5 }, 1)]
        return { state: 'ok', elapsedMs: 1 }
      },
    } as unknown as ClientPort

    const result = await pickupNearby(port, target)
    expect(result).toMatchObject({ drops: 1, picked: 1, partial: 1, notCollected: 0 })
  })

  it('reports a merge when the original entity id disappears', async () => {
    let calls = 0
    const port = {
      self: () => selfAt(0.5),
      blockAt: groundAt,
      inventory: () => [],
      entities: () => {
        calls += 1
        return calls === 1
          ? [drop({ x: 1.5, y: 64, z: 0.5 })]
          : [{ ...drop({ x: 1.6, y: 64, z: 0.6 }), id: 'merged-1' }]
      },
      moveTo: async () => ({ state: 'ok', elapsedMs: 1 }),
    } as unknown as ClientPort

    const result = await pickupNearby(port, target)
    expect(result).toMatchObject({ drops: 1, picked: 0, gone: 1, merged: 1 })
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
      self: () => selfAt(),
      blockAt: (point: Vec3) => blocks.get(`${point.x},${point.y},${point.z}`)
        ?? (point.y === 63 ? { name: 'stone', loaded: true, solid: true } : { name: 'air', loaded: true }),
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

  it('does not fail harvest when the inventory rose despite pickup bookkeeping', async () => {
    const item: Item[] = [{ slot: 36, name: 'stone_pickaxe', count: 1 }]
    const blocks = new Map<string, BlockInfo>([['1,64,0', {
      name: 'stone', loaded: true, material: 'mineable/pickaxe', diggable: true,
      harvestTools: ['stone_pickaxe'],
    }]])
    const port = {
      self: () => selfAt(),
      blockAt: (point: Vec3) => blocks.get(`${point.x},${point.y},${point.z}`)
        ?? (point.y === 63 ? { name: 'stone', loaded: true, solid: true } : { name: 'air', loaded: true }),
      inventory: () => item,
      entities: () => [drop({ x: 1.5, y: 64, z: 0.5 })],
      equip: async () => ({ state: 'ok', elapsedMs: 1 }),
      dig: async (point: Vec3) => {
        blocks.set(`${point.x},${point.y},${point.z}`, { name: 'air', loaded: true })
        return { state: 'ok', elapsedMs: 1 }
      },
      moveTo: async () => {
        item.push({ slot: 37, name: 'cobblestone', count: 1 })
        return { state: 'failed', code: 'GOTO_NO_PATH', elapsedMs: 1 }
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

    expect(handle.result()).toMatchObject({ state: 'succeeded', observed: { dropDelta: 1 } })
  })
})

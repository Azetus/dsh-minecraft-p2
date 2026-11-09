import { describe, expect, it } from 'vitest'

import { createDigDriver } from '../src/mind/drivers/dig.ts'
import { pickupNearby } from '../src/mind/pickup.ts'
import type { Job } from '../src/mind/types.ts'
import type { BlockInfo, BodyApi, EntityInfo, Item, Vec3 } from '../src/body/api.ts'

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

/**
 * A two-deep pit under the same surface as `groundAt` (rim feet 64, floor feet
 * 62): the floor block is at y=61 and y=62..63 are air. With `step`, a block at
 * (2,62,0) makes (2,63,0) a one-block step out of the pit.
 */
function pitWorld(columns: Array<[number, number]>, step = false) {
  return (point: Vec3): BlockInfo | null => {
    if (columns.some(([x, z]) => point.x === x && point.z === z)) {
      return point.y === 61 ? { name: 'stone', loaded: true, solid: true } : { name: 'air', loaded: true }
    }
    if (step && point.x === 2 && point.z === 0) {
      if (point.y === 62) return { name: 'stone', loaded: true, solid: true }
      if (point.y === 63) return { name: 'air', loaded: true }
    }
    return groundAt(point)
  }
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
    } as unknown as BodyApi

    const result = await pickupNearby(port, target)

    expect(result).toMatchObject({ drops: 1, picked: 1, unreachable: 0, notCollected: 0, noReturn: 0 })
    expect(result.observed.items[0]?.outcome).toBe('collected')
    expect(moves).toHaveLength(1)
    expect(Math.hypot(moves[0]!.x - 1, moves[0]!.z)).toBeLessThanOrEqual(3)
    // Open ground: the chosen cell can walk back, so the return probe must not
    // narrow the normal pickup path. Candidates past the 8-target cap are not
    // probed, so only the evaluated ones carry a verdict.
    expect(result.observed.standQuery?.returnReason).toBeUndefined()
    expect(result.observed.standQuery?.candidateCells
      ?.filter(cell => cell.returnable !== undefined)
      .every(cell => cell.returnable === 'yes')).toBe(true)
  })

  it('reports an unreachable drop without walking to the item position', async () => {
    let moves = 0
    const port = {
      self: () => selfAt(),
      inventory: () => [],
      entities: () => [drop({ x: 1.5, y: 64, z: 0.5 })],
      blockAt: () => null,
      moveTo: async () => { moves += 1; return { state: 'failed', code: 'GOTO_NO_PATH', elapsedMs: 1 } },
    } as unknown as BodyApi

    const result = await pickupNearby(port, target)

    expect(result).toMatchObject({ drops: 1, picked: 0, unreachable: 1 })
    // P1: an item position is not a stand cell, so a dead window means no move.
    expect(moves).toBe(0)
    expect(result.observed.items[0]?.outcome).toBe('unreachable')
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
    } as unknown as BodyApi

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
    } as unknown as BodyApi

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
    } as unknown as BodyApi

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
    } as unknown as BodyApi

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
    } as unknown as BodyApi

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
    } as unknown as BodyApi

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
    } as unknown as BodyApi

    const result = await pickupNearby(port, target)
    expect(result).toMatchObject({ drops: 1, picked: 1, partial: 1, notCollected: 0 })
    expect(result.observed.items[0]?.outcome).toBe('partial')
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
    } as unknown as BodyApi

    const result = await pickupNearby(port, target)
    expect(result).toMatchObject({ drops: 1, picked: 0, gone: 1, merged: 1 })
  })
})

describe('pickup return path', () => {
  it('refuses a 1x1x2 pit drop whose only pickup cell has no way back', async () => {
    let moves = 0
    const port = {
      self: () => selfAt(),
      blockAt: pitWorld([[1, 0]]),
      inventory: () => [],
      entities: () => [drop({ x: 1.5, y: 62, z: 0.5 })],
      moveTo: async () => { moves += 1; return { state: 'ok' as const, elapsedMs: 1 } },
    } as unknown as BodyApi

    const result = await pickupNearby(port, { x: 0, y: 64, z: 0 })

    expect(result).toMatchObject({ drops: 1, picked: 0, unreachable: 0, noReturn: 1 })
    expect(result.observed.items[0]?.outcome).toBe('noReturn')
    // The drop is reachable only by falling in; the body must not move at all.
    expect(moves).toBe(0)
    expect(result.observed.standQuery).toMatchObject({
      returnReason: 'no-return',
      candidates: 1,
      candidateCells: [
        expect.objectContaining({ x: 1, y: 62, z: 0, reachable: 'yes', returnable: 'no' }),
      ],
    })
  })

  it('refuses a 2x2x2 pit drop even though every floor cell can reach it', async () => {
    let moves = 0
    const port = {
      self: () => selfAt(),
      blockAt: pitWorld([[1, 0], [2, 0], [1, 1], [2, 1]]),
      inventory: () => [],
      entities: () => [drop({ x: 1.5, y: 62, z: 0.5 })],
      moveTo: async () => { moves += 1; return { state: 'ok' as const, elapsedMs: 1 } },
    } as unknown as BodyApi

    const result = await pickupNearby(port, { x: 0, y: 64, z: 0 })

    expect(result).toMatchObject({ drops: 1, picked: 0, unreachable: 0, noReturn: 1 })
    expect(moves).toBe(0)
    const stand = result.observed.standQuery
    expect(stand).toMatchObject({ returnReason: 'no-return', candidates: 4 })
    expect(stand?.candidateCells).toHaveLength(4)
    expect(stand?.candidateCells?.every(cell => cell.reachable === 'yes' && cell.returnable === 'no')).toBe(true)
  })

  it('picks up from a 1x1x2 pit when a step gives the floor a way back', async () => {
    const items: Item[] = []
    let drops: EntityInfo[] = [drop({ x: 1.5, y: 62, z: 0.5 })]
    const moves: Vec3[] = []
    const port = {
      self: () => selfAt(),
      blockAt: pitWorld([[1, 0]], true),
      inventory: () => items,
      entities: () => drops,
      moveTo: async (position: Vec3) => {
        moves.push(position)
        items.push({ slot: 36, name: 'cobblestone', count: 1 })
        drops = []
        return { state: 'ok' as const, elapsedMs: 1 }
      },
    } as unknown as BodyApi

    const result = await pickupNearby(port, { x: 0, y: 64, z: 0 })

    expect(result).toMatchObject({ drops: 1, picked: 1, unreachable: 0, noReturn: 0 })
    expect(result.observed.items[0]?.outcome).toBe('collected')
    expect(moves).toEqual([{ x: 1, y: 62, z: 0 }])
    expect(result.observed.standQuery?.candidateCells?.[0]?.returnable).toBe('yes')
    expect(result.observed.standQuery?.returnReason).toBeUndefined()
  })
})

describe('pickup scan options', () => {
  function collectingPort(initial: EntityInfo[], blockAt: (point: Vec3) => BlockInfo | null = groundAt) {
    const items: Item[] = []
    const drops = [...initial]
    const moves: Vec3[] = []
    const port = {
      self: () => selfAt(),
      blockAt,
      inventory: () => items,
      entities: () => drops,
      moveTo: async (target: Vec3) => {
        moves.push(target)
        let best = -1
        let bestDistance = Number.POSITIVE_INFINITY
        drops.forEach((entity, index) => {
          const distance = Math.hypot(entity.position.x - target.x, entity.position.z - target.z)
          if (distance < bestDistance) {
            bestDistance = distance
            best = index
          }
        })
        if (best >= 0) {
          const [picked] = drops.splice(best, 1)
          if (picked?.item !== undefined) {
            items.push({ slot: 36 + items.length, name: picked.item.name, count: picked.item.count })
          }
        }
        return { state: 'ok' as const, elapsedMs: 1 }
      },
    } as unknown as BodyApi
    return { port, drops, items, moves }
  }

  it('limits the scan to the requested radius', async () => {
    const fake = collectingPort([drop({ x: 1.5, y: 64, z: 10.5 })])
    const result = await pickupNearby(fake.port, { x: 0, y: 64, z: 0 }, { radius: 6 })

    expect(result).toMatchObject({ drops: 0, eligible: 0, picked: 0 })
    expect(fake.moves).toHaveLength(0)
  })

  it('processes the nearest drop first even when the adapter returns it last', async () => {
    const fake = collectingPort([
      drop({ x: 5.5, y: 64, z: 0.5 }),
      drop({ x: 3.5, y: 64, z: 0.5 }),
    ])
    const result = await pickupNearby(fake.port, { x: 0, y: 64, z: 0 }, { radius: 8 })

    expect(result).toMatchObject({ drops: 2, picked: 2 })
    expect(fake.moves.length).toBeGreaterThanOrEqual(2)
    expect(fake.moves[0]!.x).toBeLessThan(fake.moves[1]!.x)
  })

  it('filters by item name before applying maxDrops', async () => {
    const fake = collectingPort([
      drop({ x: 3.5, y: 64, z: 0.5 }),
      { ...drop({ x: 5.5, y: 64, z: 0.5 }), item: { name: 'stone', count: 1 } },
    ])
    const result = await pickupNearby(fake.port, { x: 0, y: 64, z: 0 }, { radius: 8, item: 'dirt' })

    expect(result).toMatchObject({ drops: 1, eligible: 1, skippedByCap: 0, picked: 1 })
    expect(fake.drops.map(entity => entity.item?.name)).toEqual(['stone'])
  })

  it('caps processed drops and reports the eligible overflow', async () => {
    const fake = collectingPort([
      drop({ x: 3.5, y: 64, z: 0.5 }),
      drop({ x: 5.5, y: 64, z: 0.5 }),
      drop({ x: 7.5, y: 64, z: 0.5 }),
    ])
    const result = await pickupNearby(fake.port, { x: 0, y: 64, z: 0 }, { radius: 8, maxDrops: 1 })

    expect(result).toMatchObject({ drops: 1, eligible: 3, skippedByCap: 2, picked: 1 })
    expect(fake.drops).toHaveLength(2)
  })

  it('stops at the deadline and marks the drop timedOut', async () => {
    const fake = collectingPort([drop({ x: 0.5, y: 64, z: -2.5 })])
    const result = await pickupNearby(
      fake.port,
      { x: 0, y: 64, z: 0 },
      { timeoutMs: 300 },
    )

    expect(result).toMatchObject({ drops: 1, picked: 0, timedOut: 1, timeoutHit: true })
    expect(result.observed.items[0]?.outcome).toBe('timedOut')
    expect(fake.moves).toHaveLength(0)
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
    } as unknown as BodyApi

    const job = {
      driverId: 'dig', target: { kind: 'point', pos: target },
      params: { ...target, purpose: 'harvest' }, runId: 'run-1', issuedAt: 0,
      budget: { maxTicks: 600, maxWallMs: 30_000 },
    } as unknown as Job
    const handle = createDigDriver().start(job, { body: port, now: () => 0 })
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
    } as unknown as BodyApi

    const job = {
      driverId: 'dig', target: { kind: 'point', pos: target },
      params: { ...target, purpose: 'harvest' }, runId: 'run-1', issuedAt: 0,
      budget: { maxTicks: 600, maxWallMs: 30_000 },
    } as unknown as Job
    const handle = createDigDriver().start(job, { body: port, now: () => 0 })
    for (let index = 0; index < 300 && handle.result().state === 'running'; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    expect(handle.result()).toMatchObject({ state: 'succeeded', observed: { dropDelta: 1 } })
  })
})

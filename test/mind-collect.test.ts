import { describe, expect, it } from 'vitest'

import { createCollectDriver } from '../src/mind/drivers/collect.ts'
import { createCollectOrderGiver } from '../src/mind/givers/collect.ts'
import type { DriverResult, Job, WorldView } from '../src/mind/types.ts'
import type { BlockInfo, BodyApi, EntityInfo, Item, SelfInfo, Vec3 } from '../src/body/api.ts'

const self: SelfInfo = {
  pos: { x: 0.5, y: 64, z: 0.5 },
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

function world(): WorldView {
  return {
    self,
    time: { timeOfDay: 1_000, worldAge: 1 },
    inventory: [],
    blockAt: () => null,
    blocksIn: () => [],
    entitiesIn: () => [],
  }
}

function ground(point: Vec3): BlockInfo | null {
  return point.y === 63
    ? { name: 'stone', loaded: true, solid: true }
    : { name: 'air', loaded: true }
}

function drop(id: string, x: number, item = 'dirt', count = 1): EntityInfo {
  return {
    id,
    name: 'item',
    position: { x, y: 64, z: 0.5 },
    width: 0.25,
    height: 0.25,
    item: { name: item, count },
  }
}

/**
 * Fake port that confirms a pickup whenever moveTo reaches a drop. The body
 * itself does not move; the nearest remaining entity to the move target is the
 * one collected.
 */
function collectPort(
  drops: EntityInfo[],
  options: { full?: boolean; blockAt?: (point: Vec3) => BlockInfo | null } = {},
): { port: BodyApi; items: Item[]; remaining: EntityInfo[]; moves: Vec3[] } {
  const items: Item[] = options.full === true
    ? Array.from({ length: 36 }, (_, index) => ({ slot: 9 + index, name: 'dirt', count: 1 }))
    : []
  const remaining = [...drops]
  const moves: Vec3[] = []
  const blockAt = options.blockAt ?? ground
  const port = {
    self: () => self,
    blockAt,
    inventory: () => items,
    entities: () => remaining,
    moveTo: async (target: Vec3) => {
      moves.push(target)
      let best = -1
      let bestDistance = Number.POSITIVE_INFINITY
      remaining.forEach((entity, index) => {
        const distance = Math.hypot(entity.position.x - target.x, entity.position.z - target.z)
        if (distance < bestDistance) {
          bestDistance = distance
          best = index
        }
      })
      if (best >= 0) {
        const [picked] = remaining.splice(best, 1)
        if (picked?.item !== undefined) {
          items.push({ slot: 36 + items.length, name: picked.item.name, count: picked.item.count })
        }
      }
      return { state: 'ok' as const, elapsedMs: 1 }
    },
  } as unknown as BodyApi
  return { port, items, remaining, moves }
}

function driverResult(
  port: BodyApi,
  params: Record<string, unknown>,
): Promise<DriverResult> {
  const driver = createCollectDriver()
  const job = {
    driverId: driver.id,
    params,
    runId: 'run-collect',
    issuedAt: 0,
    budget: { maxTicks: 600, maxWallMs: 30_000 },
  } as unknown as Job
  const handle = driver.start(job, { body: port, now: () => 1 })
  return new Promise(resolve => {
    const timer = setInterval(() => {
      const result = handle.result()
      if (result.state !== 'running') {
        clearInterval(timer)
        resolve(result)
      }
    }, 2)
  })
}

describe('collect order giver', () => {
  it('maps explicit params and keeps one continuation key', () => {
    const giver = createCollectOrderGiver(() => ({
      order: {
        id: 'ord-collect',
        verb: 'collect',
        params: { radius: 12, item: 'dirt', maxDrops: 3, timeoutMs: 5_000 },
      },
    }))
    expect(giver.find({ now: 0 }, world())).toMatchObject({
      driverId: 'collect',
      target: { kind: 'point', pos: self.pos },
      params: { radius: 12, item: 'dirt', maxDrops: 3, timeoutMs: 5_000 },
      keys: 'order.collect:ord-collect',
      orderId: 'ord-collect',
    })
  })

  it('leaves omitted params to the driver defaults', () => {
    const giver = createCollectOrderGiver(() => ({ order: { id: 'ord-default', verb: 'collect' } }))
    expect(giver.find({ now: 0 }, world())).toMatchObject({
      driverId: 'collect',
      params: {},
      keys: 'order.collect:ord-default',
    })
  })
})

describe('collect driver', () => {
  it('collects two observed drops nearest-first and confirms the inventory delta', async () => {
    const fake = collectPort([drop('drop-far', 5.5), drop('drop-near', 3.5)])
    const result = await driverResult(fake.port, { radius: 8 })

    expect(result).toMatchObject({
      state: 'succeeded',
      observed: {
        kind: 'collect',
        drops: 2,
        collected: 2,
        collectedDrops: 2,
        missed: 0,
        unreachable: 0,
        inventoryDelta: 2,
        timedOut: 0,
      },
    })
    expect(fake.remaining).toHaveLength(0)
    expect(fake.moves.length).toBeGreaterThanOrEqual(2)
    expect(fake.moves[0]!.x).toBeLessThan(fake.moves[1]!.x)
  })

  it('only processes drops matching the item filter', async () => {
    const fake = collectPort([drop('drop-dirt', 3.5, 'dirt'), drop('drop-stone', 5.5, 'stone')])
    const result = await driverResult(fake.port, { radius: 8, item: 'dirt' })

    expect(result).toMatchObject({
      state: 'succeeded',
      observed: { item: 'dirt', drops: 1, collected: 1, inventoryDelta: 1 },
    })
    expect(fake.remaining.map(entity => entity.item?.name)).toEqual(['stone'])
  })

  it('succeeds with drops:0 when nothing is observed', async () => {
    const fake = collectPort([])
    const result = await driverResult(fake.port, {})

    expect(result).toMatchObject({
      state: 'succeeded',
      observed: { drops: 0, collected: 0, missed: 0, unreachable: 0, inventoryDelta: 0 },
    })
    expect(fake.moves).toHaveLength(0)
  })

  it('reports an unreachable drop while keeping the collected count', async () => {
    const solid = { name: 'stone', loaded: true, solid: true }
    const fake = collectPort(
      [drop('drop-a', -2.5), drop('drop-b', 4.5)],
      {
        blockAt: point => point.x >= 2 && point.x <= 6 && point.z >= -2 && point.z <= 2
          ? solid
          : ground(point),
      },
    )
    const result = await driverResult(fake.port, { radius: 8 })

    expect(result).toMatchObject({
      state: 'failed',
      code: 'COLLECT_UNREACHABLE',
      observed: {
        drops: 2,
        collected: 1,
        collectedDrops: 1,
        missed: 0,
        unreachable: 1,
        inventoryDelta: 1,
      },
    })
    const observed = result.observed as {
      failure?: { code?: string; diagnosis?: string; phase?: string }
    }
    expect(observed.failure).toMatchObject({
      code: 'COLLECT_UNREACHABLE',
      diagnosis: 'NO_STAND_CELL',
      phase: 'pickup',
    })
  })

  it('refuses a pit drop whose only pickup cell has no way back', async () => {
    const pit = (point: Vec3): BlockInfo | null => {
      if (point.x === 3 && point.z === 0) {
        return point.y === 61
          ? { name: 'stone', loaded: true, solid: true }
          : { name: 'air', loaded: true }
      }
      return ground(point)
    }
    const inPit = { ...drop('drop-pit', 3.5), position: { x: 3.5, y: 62, z: 0.5 } }
    const fake = collectPort([inPit], { blockAt: pit })
    const result = await driverResult(fake.port, { radius: 8 })

    // The body must not step into the pit at all.
    expect(fake.moves).toHaveLength(0)
    expect(result).toMatchObject({
      state: 'failed',
      code: 'COLLECT_NO_RETURN',
      observed: {
        drops: 1,
        collected: 0,
        collectedDrops: 0,
        missed: 0,
        unreachable: 0,
        noReturn: 1,
      },
    })
    const observed = result.observed as {
      failure?: { code?: string; diagnosis?: string; phase?: string; recovery?: string; cause?: { kind?: string } }
      noReturnDrops?: unknown
      standQuery?: { returnReason?: string }
    }
    expect(observed.failure).toMatchObject({
      code: 'COLLECT_NO_RETURN',
      diagnosis: 'NO_RETURN',
      phase: 'pickup',
      recovery: 'replan',
      cause: { kind: 'world', code: 'COLLECT_NO_RETURN' },
    })
    expect(observed.standQuery?.returnReason).toBe('no-return')
    expect(observed.noReturnDrops).toEqual([
      { id: 'drop-pit', name: 'dirt', count: 1, position: { x: 3.5, y: 62, z: 0.5 } },
    ])
  })

  it('reports a full inventory instead of hiding the drop', async () => {
    const fake = collectPort([drop('drop-in-range', 0.5)], { full: true })
    const result = await driverResult(fake.port, { radius: 8 })

    expect(result).toMatchObject({
      state: 'failed',
      code: 'COLLECT_INVENTORY_FULL',
      observed: { drops: 1, collected: 0, full: 1, missed: 1 },
    })
  })

  it('stops at the deadline with a clear timeout result', async () => {
    const fake = collectPort([drop('drop-in-range', 0.5)])
    const result = await driverResult(fake.port, { radius: 8, timeoutMs: 1_000 })

    expect(result).toMatchObject({
      state: 'failed',
      code: 'COLLECT_TIMEOUT',
      observed: { drops: 1, collected: 0, timedOut: 1, timeoutHit: true, missed: 1 },
    })
  })

  it('reports drops left behind by the maxDrops cap without failing', async () => {
    const fake = collectPort([drop('drop-1', 3.5), drop('drop-2', 5.5), drop('drop-3', 7.5)])
    const result = await driverResult(fake.port, { radius: 8, maxDrops: 1 })

    expect(result).toMatchObject({
      state: 'succeeded',
      observed: { drops: 1, eligible: 3, skippedByCap: 2, collected: 1 },
    })
    expect(fake.remaining).toHaveLength(2)
  })
})

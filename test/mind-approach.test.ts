import { describe, expect, it } from 'vitest'

import { createCheckDriver } from '../src/mind/drivers/check.ts'
import { createCraftDriver } from '../src/mind/drivers/craft.ts'
import { createDigDriver } from '../src/mind/drivers/dig.ts'
import type { Job } from '../src/mind/types.ts'
import type { BlockInfo, ClientPort, Item, Vec3 } from '../src/port/index.ts'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`

function job(driverId: string, params: Record<string, unknown>): Job {
  return {
    driverId,
    target: { kind: 'point', pos: { x: 10, y: 64, z: 0 } },
    params: params as Job['params'],
    runId: 'run-1',
    issuedAt: 0,
    budget: { maxTicks: 600, maxWallMs: 30_000 },
  }
}

describe('interaction approach', () => {
  it('dig moves to the block before equipping and digging', async () => {
    const blocks = new Map<string, BlockInfo>()
    blocks.set('10,64,0', {
      name: 'stone', loaded: true, material: 'mineable/pickaxe', diggable: true,
      harvestTools: ['stone_pickaxe'],
    })
    const items: Item[] = [{ slot: 36, name: 'stone_pickaxe', count: 1 }]
    const moves: Vec3[] = []
    const port = {
      self: () => ({ pos: { x: 0.5, y: 64, z: 0.5 } }),
      blockAt: (p: Vec3) => blocks.get(key(p))
        ?? (p.y === 63 ? { name: 'stone', loaded: true } : { name: 'air', loaded: true }),
      inventory: () => items,
      entities: () => [],
      moveTo: async (target: Vec3) => { moves.push(target); return { state: 'ok', elapsedMs: 1 } },
      equip: async () => ({ state: 'ok', elapsedMs: 1 }),
      dig: async (p: Vec3) => {
        blocks.set(key(p), { name: 'air', loaded: true })
        items.push({ slot: 37, name: 'cobblestone', count: 1 })
        return { state: 'ok', elapsedMs: 1 }
      },
    } as unknown as ClientPort

    const handle = createDigDriver().start(
      job('dig', { x: 10, y: 64, z: 0, purpose: 'harvest' }),
      { port, now: () => 0 },
    )
    for (let index = 0; index < 200 && handle.result().state === 'running'; index += 1) await flush()

    expect(handle.result().state).toBe('succeeded')
    expect(moves).toHaveLength(1)
    expect(Math.hypot(moves[0]!.x - 10, moves[0]!.z)).toBeLessThanOrEqual(4)
  })

  it('check moves to the container before opening it', async () => {
    const moves: Vec3[] = []
    const port = {
      self: () => ({ pos: { x: 0.5, y: 64, z: 0.5 } }),
      blockAt: (p: Vec3) => (p.y === 63 ? { name: 'stone', loaded: true } : { name: 'air', loaded: true }),
      moveTo: async (target: Vec3) => { moves.push(target); return { state: 'ok', elapsedMs: 1 } },
      containerAt: async () => ({ state: 'ok', block: 'chest', items: [] }),
    } as unknown as ClientPort

    const handle = createCheckDriver().start(
      job('check', { x: 10, y: 64, z: 0 }),
      { port, now: () => 0 },
    )
    for (let index = 0; index < 100 && handle.result().state === 'running'; index += 1) await flush()

    expect(handle.result().state).toBe('succeeded')
    expect(moves).toHaveLength(1)
    expect(Math.hypot(moves[0]!.x - 10, moves[0]!.z)).toBeLessThanOrEqual(4)
  })

  it('craft approaches a table only when the provider says one is needed', async () => {
    const moves: Vec3[] = []
    const items: Item[] = []
    let crafts = 0
    const port = {
      self: () => ({ pos: { x: 0.5, y: 64, z: 0.5 } }),
      blockAt: (p: Vec3) => (p.y === 63 ? { name: 'stone', loaded: true } : { name: 'air', loaded: true }),
      blocksIn: () => [{ name: 'crafting_table', loaded: true, pos: { x: 10, y: 64, z: 0 } }],
      inventory: () => items,
      moveTo: async (target: Vec3) => { moves.push(target); return { state: 'ok', elapsedMs: 1 } },
      craft: async () => {
        crafts += 1
        if (crafts === 1) return { state: 'failed', code: 'CRAFT_NO_TABLE', elapsedMs: 1 }
        items.push({ slot: 36, name: 'stick', count: 4 })
        return { state: 'ok', elapsedMs: 1 }
      },
    } as unknown as ClientPort

    const handle = createCraftDriver().start(
      job('craft', { item: 'stick', count: 4 }),
      { port, now: () => 0 },
    )
    for (let index = 0; index < 100 && handle.result().state === 'running'; index += 1) await flush()

    expect(handle.result().state).toBe('succeeded')
    expect(crafts).toBe(2)
    expect(moves).toHaveLength(1)
    expect(Math.hypot(moves[0]!.x - 10, moves[0]!.z)).toBeLessThanOrEqual(4)
  })
})

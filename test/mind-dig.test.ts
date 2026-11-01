import { describe, expect, it } from 'vitest'

import { createDigDriver } from '../src/mind/drivers/dig.ts'
import type { Job } from '../src/mind/types.ts'
import type { BlockInfo, ClientPort, Item, Vec3 } from '../src/port/index.ts'

/**
 * Category: cross-module contract (dig tool selection).
 * Protects: harvest fails fast without a valid tool, clear may use the hand,
 * the driver equips the chosen tool, and a harvest without a drop is reported.
 */

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`
const target = { x: 1, y: 64, z: 0 }

function stone(overrides: Partial<BlockInfo> = {}): BlockInfo {
  return {
    name: 'stone',
    loaded: true,
    pos: target,
    material: 'mineable/pickaxe',
    diggable: true,
    hardness: 1.5,
    harvestTools: ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'],
    ...overrides,
  }
}

function portWith(options: {
  block?: BlockInfo
  inventory?: Item[]
  drops?: Item[]
} = {}): { port: ClientPort; digs: () => number; equips: string[]; blocks: Map<string, BlockInfo> } {
  const blocks = new Map<string, BlockInfo>()
  blocks.set(key(target), options.block ?? stone())
  const items = [...(options.inventory ?? [])]
  const drops = options.drops ?? []
  const equips: string[] = []
  let digs = 0
  const port = {
    self: () => ({ pos: { x: 1.5, y: 64, z: 0.5 } }),
    blockAt: (p: Vec3): BlockInfo | null => {
      const block = blocks.get(key(p))
      if (block !== undefined) return { ...block, pos: p }
      return null
    },
    inventory: () => items,
    equip: async (item: string) => { equips.push(item); return { state: 'ok' as const, elapsedMs: 1 } },
    dig: async (p: Vec3) => {
      digs += 1
      blocks.set(key(p), { name: 'air', loaded: true, pos: p })
      for (const drop of drops) items.push({ ...drop })
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    beginWrite: () => {},
    endWrite: () => {},
  } as unknown as ClientPort
  return { port, digs: () => digs, equips, blocks }
}

async function run(port: ClientPort, purpose: 'clear' | 'harvest'): Promise<{ state: string; code?: string; observed?: unknown }> {
  const driver = createDigDriver()
  const job = { driverId: 'dig', params: { ...target, purpose } } as unknown as Job
  const handle = driver.start(job, { port, now: () => 1 })
  for (let index = 0; index < 100 && handle.result().state === 'running'; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return handle.result() as { state: string; code?: string; observed?: unknown }
}

describe('dig driver tool handling', () => {
  it('equips the chosen tool and reports a harvested drop', async () => {
    const fake = portWith({
      inventory: [{ slot: 36, name: 'stone_pickaxe', count: 1 }],
      drops: [{ slot: 37, name: 'cobblestone', count: 1 }],
    })
    const result = await run(fake.port, 'harvest')

    expect(result).toMatchObject({
      state: 'succeeded',
      observed: { kind: 'dig', purpose: 'harvest', block: 'stone', tool: 'stone_pickaxe', dropDelta: 1 },
    })
    expect(fake.equips).toEqual(['stone_pickaxe'])
    expect(fake.digs()).toBe(1)
  })

  it('fails harvest before digging when no allowed tool is available', async () => {
    const fake = portWith({ inventory: [{ slot: 36, name: 'iron_axe', count: 1 }] })
    const result = await run(fake.port, 'harvest')

    expect(result).toMatchObject({ state: 'failed', code: 'TOOL_INSUFFICIENT' })
    expect(fake.digs()).toBe(0)
  })

  it('lets clear fall back to the hand and succeed', async () => {
    const fake = portWith()
    const result = await run(fake.port, 'clear')

    expect(result).toMatchObject({ state: 'succeeded', observed: { kind: 'dig', purpose: 'clear', tool: null } })
    expect(fake.equips).toEqual([])
    expect(fake.digs()).toBe(1)
  })

  it('reports an air target rather than pretending to harvest', async () => {
    const fake = portWith({ block: { name: 'air', loaded: true, pos: target } })
    const result = await run(fake.port, 'harvest')

    expect(result).toMatchObject({ state: 'failed', code: 'DIG_NO_BLOCK' })
    expect(fake.digs()).toBe(0)
  })

  it('reports an unbreakable block', async () => {
    const fake = portWith({ block: stone({ name: 'bedrock', diggable: false }) })
    const result = await run(fake.port, 'clear')

    expect(result).toMatchObject({ state: 'failed', code: 'BLOCK_UNBREAKABLE' })
    expect(fake.digs()).toBe(0)
  })

  it('reports a zero drop delta as evidence, not a failed dig', async () => {
    const fake = portWith({ inventory: [{ slot: 36, name: 'stone_pickaxe', count: 1 }] })
    const result = await run(fake.port, 'harvest')

    expect(result).toMatchObject({
      state: 'succeeded',
      observed: { kind: 'dig', purpose: 'harvest', dropDelta: 0 },
    })
    expect(fake.digs()).toBe(1)
  })
})

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
  moveFails?: boolean
  start?: Vec3
} = {}): { port: ClientPort; digs: () => number; equips: string[]; blocks: Map<string, BlockInfo> } {
  const blocks = new Map<string, BlockInfo>()
  blocks.set(key(target), options.block ?? stone())
  const items = [...(options.inventory ?? [])]
  const drops = options.drops ?? []
  const equips: string[] = []
  let self = options.start ?? { x: 1.5, y: 64, z: 0.5 }
  let digs = 0
  const port = {
    self: () => ({ pos: { ...self } }),
    blockAt: (p: Vec3): BlockInfo | null => {
      const block = blocks.get(key(p))
      if (block !== undefined) return { ...block, pos: p }
      return null
    },
    inventory: () => items,
    entities: () => [],
    moveTo: async (p: Vec3) => {
      if (options.moveFails === true) return { state: 'failed' as const, code: 'GOTO_NO_PATH', elapsedMs: 1 }
      self = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }
      return { state: 'ok' as const, elapsedMs: 1 }
    },
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

async function runJob(
  port: ClientPort,
  params: Record<string, unknown>,
): Promise<{ state: string; code?: string; observed?: unknown }> {
  const driver = createDigDriver()
  const job = { driverId: 'dig', params } as unknown as Job
  const handle = driver.start(job, { port, now: () => 1 })
  for (let index = 0; index < 2_000 && handle.result().state === 'running'; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return handle.result() as { state: string; code?: string; observed?: unknown }
}

async function run(port: ClientPort, purpose: 'clear' | 'harvest'): Promise<{ state: string; code?: string; observed?: unknown }> {
  return runJob(port, { ...target, purpose })
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

  it('keeps the provider observed data when the dig times out', async () => {
    const fake = portWith()
    const evidence = {
      layer: 'port',
      actId: 'dig',
      epoch: 1,
      elapsedMs: 15_000,
      lastPoll: 'cancelled',
      controlState: 'idle',
      controlRelease: 'confirmed',
      providerCode: null,
    }
    fake.port.dig = async () => ({
      state: 'unknown' as const,
      code: 'CLIENT_TIMEOUT',
      observed: evidence,
      elapsedMs: 15_000,
    })

    const result = await run(fake.port, 'clear')

    expect(result).toMatchObject({ state: 'failed', code: 'CLIENT_TIMEOUT', observed: evidence })
    expect((result.observed as { failure?: unknown }).failure)
      .toMatchObject({ layer: 'port', code: 'CLIENT_TIMEOUT', cause: { kind: 'provider' } })
  })
})

type TunnelFake = ReturnType<typeof portWith>

function tunnelCorridor(
  fake: TunnelFake,
  options: { from: number; to: number; y: number; height: number; stepTo?: number },
): void {
  const start = options.from
  const end = options.to
  // Starting body column.
  fake.blocks.set(`${start},${options.y - 1},0`, stone())
  fake.blocks.set(`${start},${options.y},0`, { name: 'air', loaded: true })
  fake.blocks.set(`${start},${options.y + 1},0`, { name: 'air', loaded: true })
  const direction = Math.sign(end - start)
  for (let x = start + direction; x !== end + direction; x += direction) {
    const feet = x === end && options.stepTo !== undefined ? options.stepTo : options.y
    fake.blocks.set(`${x},${feet - 1},0`, stone())
    for (let layer = 0; layer < options.height; layer += 1) {
      fake.blocks.set(`${x},${feet + layer},0`, stone())
    }
  }
}

describe('dig tunnel', () => {
  it('digs a three-cell horizontal 1x2 corridor and reports a return path', async () => {
    const fake = portWith({ start: { x: 0.5, y: 64, z: 0.5 } })
    tunnelCorridor(fake, { from: 0, to: 3, y: 64, height: 2 })
    const result = await runJob(fake.port, {
      shape: 'tunnel', to: { x: 3, y: 64, z: 0 }, height: 2, purpose: 'clear',
    })

    expect(result).toMatchObject({
      state: 'succeeded',
      observed: {
        kind: 'dig.tunnel',
        shape: 'tunnel',
        planned: 6,
        dug: 6,
        alreadyAir: 0,
        returnable: true,
        path: [
          { x: 0, y: 64, z: 0 },
          { x: 1, y: 64, z: 0 },
          { x: 2, y: 64, z: 0 },
          { x: 3, y: 64, z: 0 },
        ],
        stoppedAt: null,
      },
    })
    expect(fake.digs()).toBe(6)
    expect(fake.blocks.get('1,63,0')?.name).toBe('stone')
  })

  it('digs a one-block step down and a one-block step up', async () => {
    const down = portWith({ start: { x: 0.5, y: 64, z: 0.5 } })
    tunnelCorridor(down, { from: 0, to: 2, y: 64, height: 2, stepTo: 63 })
    // DescendMove's clearance includes the cell two above the landing.
    down.blocks.set('2,65,0', stone())
    const downResult = await runJob(down.port, {
      shape: 'tunnel', to: { x: 2, y: 63, z: 0 }, height: 2, purpose: 'clear',
    })
    expect(downResult).toMatchObject({ state: 'succeeded', observed: { dug: 5, returnable: true } })

    const up = portWith({ start: { x: 0.5, y: 64, z: 0.5 } })
    tunnelCorridor(up, { from: 0, to: 2, y: 64, height: 2, stepTo: 65 })
    // The cell above the previous tunnel cell must be observable; it is not
    // part of the step body but is the "behind" fluid probe for the head layer.
    up.blocks.set('1,66,0', { name: 'air', loaded: true })
    const upResult = await runJob(up.port, {
      shape: 'tunnel', to: { x: 2, y: 65, z: 0 }, height: 2, purpose: 'clear',
    })
    expect(upResult).toMatchObject({ state: 'succeeded', observed: { dug: 4, returnable: true } })
  })

  it('stops before a fluid target with DIG_PARTIAL and does not dig it', async () => {
    const fake = portWith({ start: { x: 0.5, y: 64, z: 0.5 } })
    tunnelCorridor(fake, { from: 0, to: 3, y: 64, height: 2 })
    fake.blocks.set('2,64,0', { name: 'water', loaded: true })
    const result = await runJob(fake.port, {
      shape: 'tunnel', to: { x: 3, y: 64, z: 0 }, height: 2, purpose: 'clear',
    })

    expect(result).toMatchObject({
      state: 'failed',
      code: 'DIG_PARTIAL',
      observed: {
        dug: 2,
        returnable: false,
        stoppedAt: { x: 2, y: 64, z: 0 },
        reason: 'fluid',
        partial: { dug: 2, planned: 6, reason: 'fluid' },
      },
    })
    expect(fake.blocks.get('2,64,0')?.name).toBe('water')
  })

  it('stops at an unloaded cell instead of guessing through it', async () => {
    const fake = portWith({ start: { x: 0.5, y: 64, z: 0.5 } })
    tunnelCorridor(fake, { from: 0, to: 3, y: 64, height: 2 })
    fake.blocks.delete('2,64,0')
    const result = await runJob(fake.port, {
      shape: 'tunnel', to: { x: 3, y: 64, z: 0 }, height: 2, purpose: 'clear',
    })

    expect(result).toMatchObject({
      state: 'failed',
      code: 'DIG_PARTIAL',
      observed: { stoppedAt: { x: 2, y: 64, z: 0 }, reason: 'unloaded' },
    })
  })

  it('rejects a tunnel above maxBlocks without digging', async () => {
    const fake = portWith({ start: { x: 0.5, y: 64, z: 0.5 } })
    const result = await runJob(fake.port, {
      shape: 'tunnel', to: { x: 4, y: 64, z: 0 }, height: 2, maxBlocks: 6, purpose: 'clear',
    })

    expect(result).toMatchObject({ state: 'failed', code: 'DIG_VOLUME_TOO_LARGE' })
    expect(fake.digs()).toBe(0)
  })

  it('rejects diagonal and multi-step tunnel targets', async () => {
    const fake = portWith({ start: { x: 0.5, y: 64, z: 0.5 } })
    expect(await runJob(fake.port, {
      shape: 'tunnel', to: { x: 2, y: 64, z: 1 }, purpose: 'clear',
    })).toMatchObject({ state: 'failed', code: 'BAD_ARGS' })
    expect(await runJob(fake.port, {
      shape: 'tunnel', to: { x: 2, y: 66, z: 0 }, purpose: 'clear',
    })).toMatchObject({ state: 'failed', code: 'BAD_ARGS' })
  })
})

describe('dig volume', () => {
  it('digs a bounded box and reports the planned cells', async () => {
    const fake = portWith()
    for (const [x, z] of [[1, 2], [2, 2], [1, 3], [2, 3]] as const) {
      fake.blocks.set(`${x},64,${z}`, stone())
    }
    const result = await runJob(fake.port, {
      shape: 'box', from: { x: 1, y: 64, z: 2 }, to: { x: 2, y: 64, z: 3 }, purpose: 'clear',
    })
    expect(result).toMatchObject({
      state: 'succeeded',
      observed: { kind: 'dig.volume', planned: 4, dug: 4, alreadyAir: 0, skipped: [] },
    })
    expect(fake.digs()).toBe(4)
  })

  it('reports partial with unreachable cells instead of failing the whole order', async () => {
    const fake = portWith({ moveFails: true })
    for (let z = 2; z <= 6; z += 1) fake.blocks.set(`1,64,${z}`, stone())
    const result = await runJob(fake.port, {
      shape: 'line', from: { x: 1, y: 64, z: 2 }, to: { x: 1, y: 64, z: 6 }, purpose: 'clear',
    })
    expect(result).toMatchObject({
      state: 'failed',
      code: 'DIG_PARTIAL',
      observed: {
        kind: 'dig.volume',
        planned: 5,
        dug: 2,
        partial: { dug: 2, skipped: 3 },
      },
    })
    const skipped = (result.observed as { skipped: Array<{ reason: string }> }).skipped
    expect(skipped.every(entry => entry.reason === 'unreachable')).toBe(true)
  })

  it('never digs the support cell under the body by default', async () => {
    const fake = portWith()
    fake.blocks.set('1,63,0', stone())
    const result = await runJob(fake.port, {
      shape: 'box', from: { x: 1, y: 63, z: 0 }, to: { x: 1, y: 63, z: 0 }, purpose: 'clear',
    })
    expect(result).toMatchObject({
      state: 'failed',
      code: 'DIG_PARTIAL',
      observed: { dug: 0, skipped: [{ reason: 'preserve-floor' }] },
    })
    expect(fake.digs()).toBe(0)
  })

  it('filters by block name and keeps by-name skips', async () => {
    const fake = portWith()
    fake.blocks.set('1,64,2', stone())
    fake.blocks.set('2,64,2', stone({ name: 'dirt' }))
    const result = await runJob(fake.port, {
      shape: 'box',
      from: { x: 1, y: 64, z: 2 },
      to: { x: 2, y: 64, z: 2 },
      only: ['stone'],
      purpose: 'clear',
    })
    expect(result).toMatchObject({
      state: 'failed',
      code: 'DIG_PARTIAL',
      observed: { dug: 1, skipped: [{ x: 2, y: 64, z: 2, reason: 'filtered', code: 'dirt' }] },
    })
  })

  it('rejects a volume above maxBlocks without digging', async () => {
    const fake = portWith()
    const result = await runJob(fake.port, {
      shape: 'box', from: { x: 0, y: 60, z: 0 }, to: { x: 5, y: 64, z: 5 },
    })
    expect(result).toMatchObject({ state: 'failed', code: 'DIG_VOLUME_TOO_LARGE' })
    expect(fake.digs()).toBe(0)
  })
})

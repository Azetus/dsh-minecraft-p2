import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import type { Bot } from 'mineflayer'

import { MineflayerProvider } from '../src/provider/mineflayer.ts'
import type { QueryOutcome } from '../src/core/node-runtime.ts'

type Vec = { x: number; y: number; z: number }

type FakeItem = { name: string; count: number }

function fakeBot(options: {
  health?: number
  inventory?: FakeItem[]
  blocks?: Map<string, string>
  recipes?: unknown[]
} = {}) {
  const controls = new Map<string, boolean>()
  const blocks = options.blocks ?? new Map<string, string>()
  const calls: Array<{ name: string; args: unknown }> = []
  const emitter = new EventEmitter()
  const bot = Object.assign(emitter, {
    entity: { position: { x: 0, y: 64, z: 0 }, onGround: true },
    entities: {} as Record<number, unknown>,
    players: {} as Record<string, unknown>,
    inventory: {
      items: () => options.inventory ?? [],
      slots: [] as Array<FakeItem | null>,
    },
    heldItem: null as FakeItem | null,
    quickBarSlot: 0,
    time: { timeOfDay: 1000, age: 1, doDaylightCycle: true },
    game: { difficulty: 'normal', dimension: 'overworld' },
    health: options.health ?? 20,
    food: 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    isRaining: false,
    thunderState: 0,
    isSleeping: false,
    currentWindow: null as unknown,
    registry: {
      itemsByName: {
        oak_log: { id: 17 },
        oak_planks: { id: 5 },
        crafting_table: { id: 58 },
        stone: { id: 1 },
      },
      items: {
        1: { name: 'stone' },
        5: { name: 'oak_planks' },
        17: { name: 'oak_log' },
        58: { name: 'crafting_table' },
      },
    },
    blockAt: (point: Vec) => {
      const name = blocks.get(`${point.x},${point.y},${point.z}`)
      return name === undefined ? null : { name, position: { x: point.x, y: point.y, z: point.z } }
    },
    findBlock: () => null,
    findBlocks: ({ matching, maxDistance }: { matching: unknown; maxDistance: number }) => {
      const found: Vec[] = []
      for (const [key, name] of blocks) {
        const [x, y, z] = key.split(',').map(Number) as [number, number, number]
        const matches = typeof matching === 'function'
          ? (matching as (block: { name: string }) => boolean)({ name })
          : true
        if (!matches) continue
        if (Math.hypot(x, y - 64, z) > maxDistance) continue
        found.push({ x, y, z })
      }
      return found
    },
    look: async () => {},
    lookAt: async () => {},
    setControlState: (name: string, value: boolean) => { controls.set(name, value) },
    getControlState: (name: string) => controls.get(name) ?? false,
    clearControlStates: () => { controls.clear() },
    respawn: () => { calls.push({ name: 'respawn', args: {} }) },
    toss: async (itemType: number, _metadata: unknown, count: number) => {
      calls.push({ name: 'toss', args: { itemType, count } })
    },
    craft: async (recipe: unknown, count: number) => { calls.push({ name: 'craft', args: { recipe, count } }) },
    recipesAll: () => options.recipes ?? [],
    recipesFor: () => options.recipes ?? [],
    isABed: () => true,
    sleep: async () => { calls.push({ name: 'sleep', args: {} }) },
    activateEntity: async (entity: { id: number }) => { calls.push({ name: 'interact', args: { id: entity.id } }) },
    activateBlock: async (block: { name: string }) => { calls.push({ name: 'activate', args: block.name }) },
    mount: () => { calls.push({ name: 'mount', args: {} }); (bot as unknown as { vehicle: unknown }).vehicle = { id: 9 } },
    dismount: () => { delete (bot as unknown as { vehicle?: unknown }).vehicle },
    openContainer: async () => ({
      slots: [null, { name: 'stone', count: 3 }],
      close: async () => { calls.push({ name: 'close', args: {} }) },
    }),
    openFurnace: async () => ({
      slots: [null, { name: 'iron_ore', count: 2 }],
      fuel: 40,
      progress: 0.5,
      close: async () => { calls.push({ name: 'close', args: {} }) },
    }),
    openVillager: async () => ({ trades: [], close: async () => {} }),
    trade: async () => {},
  })
  return { bot: bot as unknown as Bot, raw: bot, controls, calls }
}

function resolve(query: QueryOutcome): QueryOutcome | Promise<QueryOutcome> {
  return query
}

async function settle(query: QueryOutcome, timeoutMs = 1000): Promise<QueryOutcome> {
  let current: QueryOutcome = await resolve(query)
  const deadline = Date.now() + timeoutMs
  while (current.status === 'pending' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
    current = current.poll()
  }
  return current
}

describe('baseline query operations', () => {
  it('filters entities by maxDistance and reports distance', () => {
    const { bot, raw } = fakeBot()
    ;(raw.entities as Record<number, unknown>)[1] = { id: 1, name: 'cow', type: 'animal', position: { x: 2, y: 64, z: 0 } }
    ;(raw.entities as Record<number, unknown>)[2] = { id: 2, name: 'zombie', type: 'hostile', position: { x: 40, y: 64, z: 0 } }
    const provider = new MineflayerProvider(bot)
    const result = provider.query('entities', { maxDistance: 8 })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected entities')
    expect(result.value).toMatchObject([{ id: 1, name: 'cow', distance: 2 }])
  })

  it('returns equipment slots', () => {
    const { bot, raw } = fakeBot()
    ;(raw.inventory.slots as Array<FakeItem | null>)[5] = { name: 'iron_helmet', count: 1 }
    ;(raw as unknown as { heldItem: FakeItem | null }).heldItem = { name: 'iron_pickaxe', count: 1 }
    const provider = new MineflayerProvider(bot)
    const result = provider.query('equipment')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected equipment')
    expect(result.value).toMatchObject({
      held: { name: 'iron_pickaxe', count: 1 },
      armor: [{ slot: 5, name: 'iron_helmet', count: 1 }],
    })
  })

  it('returns one entity by id and null when missing', () => {
    const { bot, raw } = fakeBot()
    ;(raw.entities as Record<number, unknown>)[7] = { id: 7, name: 'pig', type: 'animal', position: { x: 1, y: 64, z: 1 } }
    const provider = new MineflayerProvider(bot)
    const found = provider.query('entity', { id: 7 })
    expect(found).toMatchObject({ status: 'ok', value: { id: 7, name: 'pig' } })
    expect(provider.query('entity', { id: 8 })).toMatchObject({ status: 'ok', value: null })
  })

  it('computes recipe ingredients and craftability', () => {
    const recipes = [{
      result: { id: 5, count: 4 },
      requiresTable: false,
      delta: [{ id: 17, count: -1 }, { id: 5, count: 4 }],
    }]
    const { bot } = fakeBot({ inventory: [{ name: 'oak_log', count: 2 }], recipes })
    const provider = new MineflayerProvider(bot)
    const result = provider.query('recipe', { item: 'oak_planks' })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected recipe')
    expect(result.value).toMatchObject([{
      result: { item: 'oak_planks', count: 4 },
      requiresTable: false,
      ingredients: [{ item: 'oak_log', count: 1 }],
      craftable: true,
    }])
  })

  it('snapshots a container and closes the window', async () => {
    const blocks = new Map<string, string>([['2,63,0', 'chest']])
    const { bot, calls } = fakeBot({ blocks })
    const provider = new MineflayerProvider(bot)
    const result = await settle(provider.query('container', { x: 2, y: 63, z: 0 }))
    expect(result).toMatchObject({
      status: 'ok',
      value: { kind: 'chest', slots: [{ slot: 1, name: 'stone', count: 3 }] },
    })
    expect(calls.map(call => call.name)).toContain('close')
  })

  it('reports weather state', () => {
    const { bot } = fakeBot()
    const provider = new MineflayerProvider(bot)
    expect(provider.query('weather')).toMatchObject({
      status: 'ok',
      value: { raining: false, thundering: false },
    })
  })
})

describe('baseline control operations', () => {
  it('crafts with a nearby recipe', async () => {
    const recipes = [{ result: { id: 5, count: 4 }, requiresTable: false, delta: [{ id: 17, count: -1 }] }]
    const { bot, calls } = fakeBot({ inventory: [{ name: 'oak_log', count: 2 }], recipes })
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('craft', { item: 'oak_planks', count: 2 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handle.poll().status).toBe('succeeded')
    expect(calls.some(call => call.name === 'craft')).toBe(true)
  })

  it('fails craft for an unknown item', () => {
    const { bot } = fakeBot()
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('craft', { item: 'unobtainium' })
    expect(handle.poll()).toMatchObject({ status: 'failed', error: { code: 'CRAFT_UNKNOWN_RECIPE' } })
  })

  it('respawning waits for health to return', async () => {
    const { bot, raw, calls } = fakeBot({ health: 0 })
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('respawn', {})
    expect(calls.some(call => call.name === 'respawn')).toBe(true)
    ;(raw as unknown as { health: number }).health = 20
    await new Promise(resolve => setTimeout(resolve, 320))
    expect(handle.poll()).toMatchObject({ status: 'succeeded' })
  })

  it('sleeps in a bed and completes after waking', async () => {
    const blocks = new Map<string, string>([['1,63,0', 'red_bed']])
    const { bot, raw } = fakeBot({ blocks })
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('sleep', { x: 1, y: 63, z: 0 })
    ;(raw as unknown as { isSleeping: boolean }).isSleeping = true
    await new Promise(resolve => setTimeout(resolve, 260))
    ;(raw as unknown as { isSleeping: boolean }).isSleeping = false
    await new Promise(resolve => setTimeout(resolve, 260))
    expect(handle.poll()).toMatchObject({ status: 'succeeded' })
  })

  it('fails sleep when the block is not a bed', () => {
    const blocks = new Map<string, string>([['1,63,0', 'stone']])
    const { bot, raw } = fakeBot({ blocks })
    ;(raw as unknown as { isABed: () => boolean }).isABed = () => false
    const provider = new MineflayerProvider(bot)
    expect(provider.start('sleep', { x: 1, y: 63, z: 0 }).poll())
      .toMatchObject({ status: 'failed', error: { code: 'SLEEP_NO_BED' } })
  })

  it('tosses an item from the inventory name', async () => {
    const { bot, calls } = fakeBot({ inventory: [{ name: 'stone', count: 4 }] })
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('toss', { item: 'stone', count: 2 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handle.poll()).toMatchObject({ status: 'succeeded', result: { item: 'stone', count: 2 } })
    expect(calls[0]).toEqual({ name: 'toss', args: { itemType: 1, count: 2 } })
  })

  it('pulses jump when moveTo makes no progress', async () => {
    const { bot, controls } = fakeBot()
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('moveTo', { x: 10, z: 0, tolerance: 0.5, blockedMs: 5000 })
    expect(controls.get('forward')).toBe(true)
    let jumped = false
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 80))
      handle.poll()
      if (controls.get('jump') === true) jumped = true
    }
    expect(jumped).toBe(true)
    handle.stop()
  })
})

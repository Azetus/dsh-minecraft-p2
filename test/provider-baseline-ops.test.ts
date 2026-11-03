import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import type { Bot } from 'mineflayer'

import { MineflayerProvider } from '../src/provider/mineflayer.ts'
import type { ActPoll, QueryOutcome } from '../src/provider/runtime.ts'

type Vec = { x: number; y: number; z: number }

type FakeItem = { name: string; count: number }

function fakeBot(options: {
  health?: number
  inventory?: FakeItem[]
  blocks?: Map<string, string>
  recipes?: unknown[]
  craftError?: unknown
} = {}) {
  const controls = new Map<string, boolean>()
  const blocks = options.blocks ?? new Map<string, string>()
  const calls: Array<{ name: string; args: unknown }> = []
  const itemIds: Record<string, number> = {
    stone: 1,
    oak_planks: 5,
    oak_log: 17,
    crafting_table: 58,
    white_wool: 35,
    torch: 50,
    birch_log: 134,
    coal: 263,
    raw_iron: 264,
    iron_ingot: 265,
    stick: 280,
  }
  const itemNamesById = Object.fromEntries(Object.entries(itemIds).map(([name, id]) => [id, name]))
  const inventory: Array<FakeItem & { type?: number }> = (options.inventory ?? []).map(item => ({
    ...item,
    type: itemIds[item.name] ?? 0,
  }))
  const addItem = (name: string, count: number): void => {
    const existing = inventory.find(item => item.name === name)
    if (existing === undefined) inventory.push({ name, count, type: itemIds[name] ?? 0 })
    else existing.count += count
  }
  const emitter = new EventEmitter()
  const bot = Object.assign(emitter, {
    entity: { position: { x: 0, y: 64, z: 0 }, onGround: true },
    entities: {} as Record<number, unknown>,
    players: {} as Record<string, unknown>,
    inventory: {
      items: () => inventory,
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
    placeBlock: async (reference: { position: Vec }, vector: Vec) => {
      const target = {
        x: reference.position.x + vector.x,
        y: reference.position.y + vector.y,
        z: reference.position.z + vector.z,
      }
      const held = (bot as unknown as { heldItem?: FakeItem | null }).heldItem
      if (held !== null && held !== undefined) blocks.set(`${target.x},${target.y},${target.z}`, held.name)
      calls.push({ name: 'placeBlock', args: { target, vector } })
    },
    setControlState: (name: string, value: boolean) => { controls.set(name, value) },
    getControlState: (name: string) => controls.get(name) ?? false,
    clearControlStates: () => { controls.clear() },
    respawn: () => { calls.push({ name: 'respawn', args: {} }) },
    toss: async (itemType: number, _metadata: unknown, count: number) => {
      calls.push({ name: 'toss', args: { itemType, count } })
    },
    craft: async (recipe: unknown, count: number, table?: unknown) => {
      calls.push({ name: 'craft', args: { recipe, count, table } })
      if (options.craftError !== undefined) throw options.craftError
      const result = (recipe as { result?: { id: number; count: number } } | undefined)?.result
      if (result !== undefined) addItem(itemNamesById[result.id] ?? `item:${result.id}`, result.count)
    },
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
    unequip: async (destination: string) => { calls.push({ name: 'unequip', args: { destination } }) },
    moveVehicle: (left: number, forward: number) => { calls.push({ name: 'moveVehicle', args: { left, forward } }) },
    placeEntity: async (block: { name: string }) => {
      calls.push({ name: 'placeEntity', args: { block: block.name } })
      return { id: 77, name: 'boat' }
    },
    fish: async () => { calls.push({ name: 'fish', args: {} }) },
    consume: async () => { calls.push({ name: 'consume', args: {} }) },
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

async function settleAct(handle: { poll(): ActPoll }, timeoutMs = 1000): Promise<ActPoll> {
  let current = handle.poll()
  const deadline = Date.now() + timeoutMs
  while (current.status === 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
    current = handle.poll()
  }
  return current
}

describe('baseline query operations', () => {
  it('reports movement flags with the position', () => {
    const { bot } = fakeBot()
    const provider = new MineflayerProvider(bot)
    expect(provider.query('position')).toMatchObject({
      status: 'ok',
      value: { x: 0, y: 64, z: 0, onGround: true, yaw: null },
    })
  })
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

  it('filters hostile entities and sorts entities by name or distance', () => {
    const { bot, raw } = fakeBot()
    ;(raw.entities as Record<number, unknown>)[1] = { id: 1, name: 'zombie', type: 'mob', kind: 'Hostile mobs', position: { x: 5, y: 64, z: 0 } }
    ;(raw.entities as Record<number, unknown>)[2] = { id: 2, name: 'cow', type: 'mob', kind: 'Passive mobs', position: { x: 1, y: 64, z: 0 } }
    ;(raw.entities as Record<number, unknown>)[3] = { id: 3, name: 'skeleton', type: 'mob', kind: 'Hostile mobs', position: { x: 3, y: 64, z: 0 } }
    const provider = new MineflayerProvider(bot)

    const hostiles = provider.query('entities', { hostileOnly: true, sort: 'name' })
    expect(hostiles.status).toBe('ok')
    if (hostiles.status !== 'ok') throw new Error('expected hostiles')
    expect(hostiles.value).toMatchObject([{ name: 'skeleton' }, { name: 'zombie' }])

    const farFirst = provider.query('entities', { sort: 'distance', descending: true })
    expect(farFirst.status).toBe('ok')
    if (farFirst.status !== 'ok') throw new Error('expected entities')
    expect(farFirst.value).toMatchObject([{ name: 'zombie' }, { name: 'skeleton' }, { name: 'cow' }])

    const named = provider.query('entities', { name: 'cow' })
    expect(named).toMatchObject({ status: 'ok', value: [{ name: 'cow' }] })
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

  it('keeps only exposed blocks when the exposed filter is requested', () => {
    const blocks = new Map<string, string>([
      ['1,64,0', 'iron_ore'],
      ['5,64,0', 'iron_ore'],
      ['5,65,0', 'air'],
    ])
    const { bot } = fakeBot({ blocks })
    const provider = new MineflayerProvider(bot)
    const buried = provider.query('blocks', { radius: 16, count: 8 })
    expect(buried.status).toBe('ok')
    if (buried.status !== 'ok') throw new Error('expected blocks')
    expect((buried.value as unknown[]).length).toBe(2)
    const exposed = provider.query('blocks', { radius: 16, count: 8, exposed: true })
    expect(exposed.status).toBe('ok')
    if (exposed.status !== 'ok') throw new Error('expected blocks')
    expect(exposed.value).toMatchObject([{ name: 'iron_ore', x: 5, y: 64, z: 0 }])
  })
  it('reports only the container slots, not the player inventory of the window', async () => {
    const blocks = new Map<string, string>([['2,63,0', 'chest']])
    const { bot, raw } = fakeBot({ blocks })
    const slots: Array<{ name: string; count: number } | null> = new Array(90).fill(null)
    slots[0] = { name: 'raw_iron', count: 61 }
    slots[30] = { name: 'iron_ingot', count: 3 }
    slots[81] = { name: 'torch', count: 1 }
    ;(raw as unknown as { openContainer: unknown }).openContainer = async () => ({
      slots,
      // Documented prismarine-windows properties the provider relies on.
      inventoryStart: 27,
      containerItems: () => [{ slot: 0, name: 'raw_iron', count: 61 }],
      close: async () => {},
    })
    const provider = new MineflayerProvider(bot)
    const result = await settle(provider.query('container', { x: 2, y: 63, z: 0 }))
    expect(result).toMatchObject({
      status: 'ok',
      value: { kind: 'chest', containerSlots: 27, slots: [{ slot: 0, name: 'raw_iron', count: 61 }] },
    })
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

describe('baseline placement support', () => {
  it('falls back from the requested up face to a solid side reference', async () => {
    const blocks = new Map<string, string>([
      ['1,64,0', 'air'],
      ['0,64,0', 'stone'],
    ])
    const { bot, raw, calls } = fakeBot({ blocks })
    ;(raw as unknown as { heldItem: FakeItem }).heldItem = { name: 'dirt', count: 1 }
    const provider = new MineflayerProvider(bot)
    const result = await settleAct(provider.start('place', { x: 1, y: 64, z: 0, face: 'up', item: 'dirt' }))

    expect(result).toMatchObject({
      status: 'succeeded',
      result: { name: 'dirt', x: 1, y: 64, z: 0, face: 'east' },
    })
    expect(blocks.get('1,64,0')).toBe('dirt')
    expect(calls.find(call => call.name === 'placeBlock')?.args).toMatchObject({
      target: { x: 1, y: 64, z: 0 },
      vector: { x: 1, y: 0, z: 0 },
    })
  })

  it('reports PLACE_UNSUPPORTED with six-face facts only when no reference is solid', async () => {
    const blocks = new Map<string, string>([['1,64,0', 'air']])
    const { bot, raw } = fakeBot({ blocks })
    ;(raw as unknown as { heldItem: FakeItem }).heldItem = { name: 'dirt', count: 1 }
    const provider = new MineflayerProvider(bot)
    const result = await settleAct(provider.start('place', { x: 1, y: 64, z: 0, face: 'up', item: 'dirt' }))

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('expected placement failure')
    expect(result.error.code).toBe('PLACE_UNSUPPORTED')
    expect(result.error.details).toMatchObject({
      requestedFace: 'up',
      supports: { up: false, down: false, north: false, south: false, east: false, west: false },
    })
  })
})

describe('baseline control operations', () => {
  it('crafts with a nearby recipe', async () => {
    const recipes = [{ result: { id: 5, count: 4 }, requiresTable: false, delta: [{ id: 17, count: -1 }] }]
    const { bot, calls } = fakeBot({ inventory: [{ name: 'oak_log', count: 2 }], recipes })
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('craft', { item: 'oak_planks', count: 2 })
    // The provider settles between crafts, so give the batch time to finish.
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(handle.poll()).toMatchObject({
      status: 'succeeded',
      result: { item: 'oak_planks', requested: 2, crafted: 2, produced: 8 },
    })
    expect(calls.filter(call => call.name === 'craft')).toHaveLength(2)
  })

  it('reports CRAFT_INCOMPLETE when the window transaction never completes', async () => {
    const recipes = [{ result: { id: 5, count: 4 }, requiresTable: false, delta: [{ id: 17, count: -1 }] }]
    const { bot } = fakeBot({ inventory: [{ name: 'oak_log', count: 2 }], recipes, craftError: new Error('updateSlot timeout') })
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('craft', { item: 'oak_planks', count: 1 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handle.poll()).toMatchObject({
      status: 'failed',
      error: {
        code: 'CRAFT_INCOMPLETE',
        details: { item: 'oak_planks', requested: 1, crafted: 0, produced: 0 },
      },
    })
  })

  it('resolves a no-table recipe before consulting a nearby table', async () => {
    const recipe = { result: { id: 5, count: 4 }, requiresTable: false, delta: [{ id: 17, count: -1 }] }
    const { bot, raw, calls } = fakeBot({ inventory: [{ name: 'oak_log', count: 2 }], recipes: [recipe] })
    const lookedAt: unknown[] = []
    ;(raw as unknown as { recipesFor: (...args: unknown[]) => unknown[] }).recipesFor =
      (_type, _meta, _min, table) => {
        lookedAt.push(table)
        return [recipe]
      }
    ;(raw as unknown as { findBlock: () => unknown }).findBlock = () => ({
      name: 'crafting_table',
      position: { x: 0, y: 63, z: 1 },
    })
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('craft', { item: 'oak_planks', count: 1 })
    await new Promise(resolve => setTimeout(resolve, 500))

    expect(lookedAt[0]).toBeNull()
    expect(handle.poll()).toMatchObject({
      status: 'succeeded',
      result: { usedTable: false, requiresTable: false, recipeCount: 1 },
    })
    const craft = calls.find(call => call.name === 'craft')
    expect((craft?.args as { table?: unknown } | undefined)?.table).toBeUndefined()
  })

  it('uses the table recipe only when no no-table recipe is available', async () => {
    const recipe = { result: { id: 5, count: 4 }, requiresTable: true, delta: [{ id: 17, count: -1 }] }
    const { bot, raw, calls } = fakeBot({ inventory: [{ name: 'oak_log', count: 2 }], recipes: [recipe] })
    ;(raw as unknown as { recipesFor: (...args: unknown[]) => unknown[] }).recipesFor =
      (_type, _meta, _min, table) => (table === null ? [] : [recipe])
    ;(raw as unknown as { findBlock: () => unknown }).findBlock = () => ({
      name: 'crafting_table',
      position: { x: 0, y: 63, z: 1 },
    })
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('craft', { item: 'oak_planks', count: 1 })
    await new Promise(resolve => setTimeout(resolve, 500))

    expect(handle.poll()).toMatchObject({
      status: 'succeeded',
      result: { usedTable: true, requiresTable: true },
    })
    const craft = calls.find(call => call.name === 'craft')
    expect((craft?.args as { table?: unknown } | undefined)?.table).toBeDefined()
  })

  it('reports missing ingredients, not a missing table, when a no-table recipe exists', async () => {
    const noTable = { result: { id: 5, count: 4 }, requiresTable: false, delta: [{ id: 17, count: -1 }] }
    const table = { result: { id: 5, count: 4 }, requiresTable: true, delta: [{ id: 17, count: -1 }] }
    const { bot, raw } = fakeBot({ inventory: [], recipes: [noTable, table] })
    ;(raw as unknown as { recipesAll: () => unknown[] }).recipesAll = () => [noTable, table]
    ;(raw as unknown as { recipesFor: () => unknown[] }).recipesFor = () => []
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('craft', { item: 'oak_planks', count: 1 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handle.poll()).toMatchObject({
      status: 'failed',
      error: {
        code: 'CRAFT_NO_INGREDIENTS',
        details: { recipeCount: 2, requiresTable: false },
      },
    })
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

  it('unequips a slot', async () => {
    const { bot, calls } = fakeBot()
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('unequip', { destination: 'head' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handle.poll().status).toBe('succeeded')
    expect(calls).toContainEqual({ name: 'unequip', args: { destination: 'head' } })
  })

  it('places an entity on a support block', async () => {
    const blocks = new Map<string, string>([['1,63,0', 'stone']])
    const { bot, calls } = fakeBot({ blocks })
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('place-entity', { x: 1, y: 64, z: 0 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handle.poll()).toMatchObject({ status: 'succeeded', result: { entityId: 77 } })
    expect(calls.some(call => call.name === 'placeEntity')).toBe(true)
  })

  it('fishes until the op resolves', async () => {
    const { bot, calls } = fakeBot()
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('fish', { timeoutMs: 500 })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(handle.poll()).toMatchObject({ status: 'succeeded' })
    expect(calls.some(call => call.name === 'fish')).toBe(true)
  })

  it('fails consume without a held item and succeeds with one', async () => {
    const empty = fakeBot()
    expect(new MineflayerProvider(empty.bot).start('consume', {}).poll())
      .toMatchObject({ status: 'failed', error: { code: 'USE_NO_ITEM' } })

    const fed = fakeBot()
    ;(fed.raw as unknown as { heldItem: { name: string; count: number } }).heldItem = { name: 'bread', count: 2 }
    const handle = new MineflayerProvider(fed.bot).start('consume', {})
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handle.poll()).toMatchObject({ status: 'succeeded', result: { item: 'bread' } })
  })

  it('finds a crafting table by block id, not item id', async () => {
    const recipes = [{ result: { id: 5, count: 4 }, requiresTable: true, delta: [{ id: 17, count: -3 }] }]
    const { bot, raw, calls } = fakeBot({ inventory: [{ name: 'oak_log', count: 4 }], recipes })
    const registry = (raw as unknown as { registry: Record<string, unknown> }).registry
    registry.blocksByName = { crafting_table: { id: 58 } }
    registry.itemsByName = { ...(registry.itemsByName as Record<string, unknown>), crafting_table: { id: 999 } }
    ;(raw as unknown as { findBlock: (options: { matching: number | number[] }) => unknown }).findBlock = (options) => {
      const matching = Array.isArray(options.matching) ? options.matching : [options.matching]
      return matching.includes(58) ? { name: 'crafting_table', position: { x: 1, y: 63, z: 0 } } : null
    }
    // A table-only recipe: the no-table lookup must come back empty, otherwise
    // the provider would (correctly) prefer the inventory recipe.
    ;(raw as unknown as { recipesFor: (...args: unknown[]) => unknown[] }).recipesFor =
      (_type, _meta, _min, table) => (table === null ? [] : recipes)
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('craft', { item: 'oak_planks', count: 1 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handle.poll()).toMatchObject({ status: 'succeeded' })
    const craftCall = calls.find(call => call.name === 'craft') as { args: { table?: { name?: string } } }
    expect(craftCall.args.table).toMatchObject({ name: 'crafting_table' })
  })
})



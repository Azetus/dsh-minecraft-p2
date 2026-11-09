import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'

import type { MineflayerBodyOptions } from '../src/provider/body.ts'
import type { MineflayerProvider } from '../src/provider/mineflayer.ts'
import { MineflayerBody } from '../src/provider/index.ts'
import type { BodyEvent } from '../src/body/api.ts'
import { FakeActSource, FakeBot, writeToken } from './helpers/mineflayer-fakes.ts'

/**
 * Category: cross-module contract (CONTRACTS §2, TODO M0-03).
 * Protects: every port action maps to exactly one provider act and returns a
 * three-state ActResult; timeouts are `unknown`; stale authority is never
 * reported as success. Failure modes: promise/act errors leak as exceptions,
 * a hung action is reported as failed, an old writer keeps its result.
 */

function createPort(
  source = new FakeActSource(),
  bot = new FakeBot(),
  options: MineflayerBodyOptions = {},
): {
  port: MineflayerBody
  bot: FakeBot
  source: FakeActSource
} {
  const port = new MineflayerBody(bot as unknown as Bot, source as unknown as MineflayerProvider, {
    pollIntervalMs: 2,
    now: () => Date.now(),
    ...options,
  })
  port.beginWrite(writeToken(1))
  return { port, bot, source }
}

describe('mineflayer port actions', () => {
  it('maps every write action onto one bounded provider act', async () => {
    const { port, source, bot } = createPort()
    bot.heldItem = { name: 'dirt', count: 3 }

    expect(await port.moveTo({ x: 1, y: 64, z: 2 }, { range: 2, timeoutMs: 500 }))
      .toMatchObject({ state: 'ok' })
    expect(source.calls.at(-1)).toEqual({ name: 'motion-goto', args: { x: 1, y: 64, z: 2, range: 2, timeoutMs: 500 } })

    expect((await port.combatStep({
      cell: { x: 1, y: 64, z: 2 },
      face: { x: 0, y: 64, z: 0 },
      shield: true,
    })).state).toBe('ok')
    expect(source.calls.at(-1)).toEqual({
      name: 'combat-step',
      args: { x: 1, y: 64, z: 2, faceX: 0, faceZ: 0, shield: true },
    })

    expect((await port.lookAt({ x: 1, y: 64, z: 2 })).state).toBe('ok')
    expect(source.calls.at(-1)?.name).toBe('lookAt')

    expect((await port.dig({ x: 1, y: 64, z: 2 })).state).toBe('ok')
    expect(source.calls.at(-1)?.name).toBe('dig')

    expect((await port.place({ x: 1, y: 64, z: 2 }, 'up', 'dirt')).state).toBe('ok')
    expect(source.calls.at(-1)).toEqual({ name: 'place', args: { x: 1, y: 64, z: 2, face: 'up', item: 'dirt' } })

    expect((await port.useItem()).state).toBe('ok')
    expect(source.calls.at(-1)?.name).toBe('use')

    bot.inventory.slots[45] = { name: 'shield', count: 1 }
    expect(port.offhand()).toEqual({ slot: 45, name: 'shield', count: 1 })
    expect((await port.useItem({ durationMs: 400, offhand: true })).state).toBe('ok')
    expect(source.calls.at(-1)).toEqual({ name: 'use', args: { durationMs: 400, offhand: true } })
    expect((await port.equip('shield', 'offhand')).state).toBe('ok')
    expect(source.calls.at(-1)).toEqual({ name: 'equip', args: { item: 'shield', destination: 'off-hand' } })
    expect((await port.equip('dirt')).state).toBe('ok')
    expect(source.calls.at(-1)).toEqual({ name: 'equip', args: { item: 'dirt' } })
    expect((await port.unequip('offhand')).state).toBe('ok')
    expect(source.calls.at(-1)).toEqual({ name: 'unequip', args: { destination: 'off-hand' } })
    expect((await port.unequip()).state).toBe('ok')
    expect(source.calls.at(-1)).toEqual({ name: 'unequip', args: { destination: 'hand' } })

    expect((await port.useOn({ x: 1, y: 64, z: 2 })).state).toBe('ok')
    expect(source.calls.at(-1)?.name).toBe('activate')

    expect((await port.attack('12')).state).toBe('ok')
    expect(source.calls.at(-1)).toEqual({ name: 'attack', args: { entityId: 12 } })

    expect((await port.sleep({ x: 1, y: 64, z: 2 })).state).toBe('ok')
    expect(source.calls.at(-1)?.name).toBe('sleep')

    port.say('hello')
    expect(bot.chats).toEqual(['hello'])
  })

  it('equips the requested item before placing it', async () => {
    const { port, source, bot } = createPort()
    bot.heldItem = { name: 'stone', count: 1 }
    const order: string[] = []
    source.onStart = name => {
      order.push(name)
      if (name === 'equip') bot.heldItem = { name: 'dirt', count: 3 }
    }

    expect((await port.place({ x: 0, y: 64, z: 0 }, 'up', 'dirt')).state).toBe('ok')
    expect(order).toEqual(['equip', 'place'])
  })

  it('fails EQUIP_FAILED when the held item does not change', async () => {
    const { port } = createPort()
    expect(await port.place({ x: 0, y: 64, z: 0 }, 'up', 'dirt')).toMatchObject({
      state: 'failed',
      code: 'EQUIP_FAILED',
    })
  })

  it('rejects a non-numeric entity id without starting an act', async () => {
    const { port, source } = createPort()
    const before = source.calls.length
    expect(await port.attack('cow')).toMatchObject({ state: 'failed', code: 'INVALID_TARGET' })
    expect(source.calls.length).toBe(before)
  })

  it('exposes adapter harvest metadata for tool selection', () => {
    const { port, bot } = createPort()
    bot.blocks.set('1,64,1', {
      name: 'stone',
      material: 'mineable/pickaxe',
      diggable: true,
      hardness: 1.5,
      harvestTools: { '820': true, '825': true },
    })
    expect(port.blockAt({ x: 1, y: 64, z: 1 })).toMatchObject({
      name: 'stone',
      material: 'mineable/pickaxe',
      diggable: true,
      hardness: 1.5,
      harvestTools: ['wooden_pickaxe', 'stone_pickaxe'],
    })
  })

  it('returns failed with the provider code when an act fails', async () => {
    const { port, source } = createPort()
    source.mode = 'fail'
    expect(await port.dig({ x: 1, y: 64, z: 1 })).toMatchObject({
      state: 'failed',
      code: 'DIG_NO_BLOCK',
    })
  })
})

describe('mineflayer port timeout and authority', () => {
  it('returns ACT_UNCONFIRMED on a non-idempotent timeout and asks the act to stop', async () => {
    const source = new FakeActSource()
    const { port } = createPort(source, new FakeBot(), { timeouts: { dig: 20 } })
    source.mode = 'running'
    const result = await port.dig({ x: 1, y: 64, z: 1 })
    expect(result.state).toBe('unknown')
    expect(result.code).toBe('ACT_UNCONFIRMED')
    expect(source.handles[0]?.stopped).toBe(true)
  })

  it('returns ACT_TIMEOUT for a retry-safe move timeout', async () => {
    const source = new FakeActSource()
    const { port } = createPort(source, new FakeBot(), { timeouts: { moveTo: 20 } })
    source.mode = 'running'
    const result = await port.moveTo({ x: 1, y: 64, z: 1 }, { timeoutMs: 20 })
    expect(result).toMatchObject({ state: 'unknown', code: 'ACT_TIMEOUT' })
    expect(source.handles[0]?.stopped).toBe(true)
  })

  it('carries provider evidence on a non-move timeout instead of an empty observed', async () => {
    const source = new FakeActSource()
    const { port } = createPort(source, new FakeBot(), { timeouts: { dig: 20 } })
    source.mode = 'running'
    const result = await port.dig({ x: 1, y: 64, z: 1 })
    expect(result.observed).toMatchObject({
      layer: 'port',
      actId: 'dig',
      epoch: 1,
      effect: 'unknown',
      retrySafe: false,
      lastPoll: 'cancelled',
      providerCode: null,
      controlState: 'idle',
      controlRelease: 'confirmed',
    })
    expect((result.observed as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('marks a move timeout retry-safe in evidence', async () => {
    const source = new FakeActSource()
    const { port } = createPort(source, new FakeBot(), { timeouts: { moveTo: 20 } })
    source.mode = 'running'
    const result = await port.moveTo({ x: 1, y: 64, z: 1 }, { timeoutMs: 20 })
    expect(result.observed).toMatchObject({ actId: 'motion-goto', effect: 'unknown', retrySafe: true })
  })

  it('normalizes a provider ACT_TIMEOUT on a non-move act to unconfirmed', async () => {
    const source = new FakeActSource()
    const { port } = createPort(source, new FakeBot())
    source.mode = 'fail'
    source.failCode = 'ACT_TIMEOUT'
    expect(await port.dig({ x: 1, y: 64, z: 1 })).toMatchObject({
      state: 'unknown',
      code: 'ACT_UNCONFIRMED',
    })
  })

  it('reports ACTION_DENIED only when a server denial is in the act window', async () => {
    const source = new FakeActSource()
    const bot = new FakeBot()
    const { port } = createPort(source, bot, { timeouts: { dig: 20 } })
    source.mode = 'running'
    const pending = port.dig({ x: 1, y: 64, z: 1 })
    bot.emit('messagestr', 'You do not have permission to do that')
    const result = await pending
    expect(result).toMatchObject({ state: 'failed', code: 'ACTION_DENIED' })
    expect(result.observed).toMatchObject({
      layer: 'port',
      actId: 'dig',
      denial: { text: 'You do not have permission to do that' },
      serverMessages: [{ text: 'You do not have permission to do that' }],
    })
    expect(source.handles[0]?.stopped).toBe(true)
  })

  it('does not classify an unrelated server message as denial', async () => {
    const source = new FakeActSource()
    const bot = new FakeBot()
    const { port } = createPort(source, bot, { timeouts: { dig: 20 } })
    source.mode = 'running'
    const pending = port.dig({ x: 1, y: 64, z: 1 })
    bot.emit('messagestr', 'Welcome to the server')
    expect(await pending).toMatchObject({ state: 'unknown', code: 'ACT_UNCONFIRMED' })
  })

  it('reports STOP_UNCONFIRMED when a non-move stop is not proven released', async () => {
    const source = new FakeActSource()
    const { port } = createPort(source, new FakeBot(), { timeouts: { dig: 20 } })
    source.mode = 'running'
    source.releaseOnStop = false
    const result = await port.dig({ x: 1, y: 64, z: 1 })
    expect(result).toMatchObject({ state: 'unknown', code: 'STOP_UNCONFIRMED' })
    expect(result.observed).toMatchObject({
      actId: 'dig',
      lastPoll: 'running',
      controlState: 'active',
      controlRelease: null,
    })
  })

  it('rejects writes without a token', async () => {
    const source = new FakeActSource()
    const port = new MineflayerBody(new FakeBot() as unknown as Bot, source as unknown as MineflayerProvider, { pollIntervalMs: 2 })
    expect(await port.dig({ x: 1, y: 64, z: 1 })).toMatchObject({ state: 'failed', code: 'STALE_WRITE' })
    expect(source.calls).toHaveLength(0)
  })

  it('drops an in-flight result when a newer authority arrives', async () => {
    const { port, source } = createPort()
    source.mode = 'running'
    const pending = port.dig({ x: 1, y: 64, z: 1 })
    await new Promise(resolve => setTimeout(resolve, 10))
    port.beginWrite(writeToken(2))
    const result = await pending
    expect(result).toMatchObject({ state: 'failed', code: 'STALE_WRITE' })
    expect(source.handles[0]?.stopped).toBe(true)
  })

  it('stops running acts when the writer ends', async () => {
    const { port, source } = createPort()
    source.mode = 'running'
    const pending = port.dig({ x: 1, y: 64, z: 1 })
    await new Promise(resolve => setTimeout(resolve, 10))
    port.endWrite(writeToken(1))
    expect((await pending).state).toBe('failed')
    expect(source.handles[0]?.stopped).toBe(true)
  })
})

describe('mineflayer port reads', () => {
  it('maps self, inventory, time and entities to pure data', () => {
    const { port } = createPort()
    expect(port.self()).toEqual({
      pos: { x: 0, y: 64, z: 0 },
      yaw: 1,
      pitch: 2,
      health: 20,
      food: 18,
      onGround: true,
      inWater: false,
      inLava: false,
    })
    expect(port.inventory()).toEqual([{ slot: 36, name: 'dirt', count: 3 }])
    expect(port.time()).toEqual({ timeOfDay: 6000, worldAge: 1234 })
    expect(port.entities({ min: { x: 0, y: 0, z: 0 }, max: { x: 8, y: 128, z: 8 } }))
      .toEqual([
        { id: '1', name: 'cow', position: { x: 1, y: 64, z: 1 } },
        { id: '3', name: 'unknown', position: { x: 2, y: 64, z: 2 } },
      ])
  })

  it('exposes entity yaw when the adapter has it', () => {
    const { port, bot } = createPort()
    ;(bot.entities as unknown as Record<number, unknown>)[9] = {
      id: 9,
      name: 'zombie',
      type: 'hostile',
      position: { x: 3, y: 64, z: 1 },
      yaw: 1.25,
    }
    expect(port.entities({ min: { x: 0, y: 0, z: 0 }, max: { x: 8, y: 128, z: 8 } }))
      .toContainEqual({
        id: '9',
        name: 'zombie',
        position: { x: 3, y: 64, z: 1 },
        yaw: 1.25,
        type: 'hostile',
      })
  })

  it('resolves a player by tab-list index and an entity by id without a box scan', () => {
    const { port, bot } = createPort()
    const alice = { id: 7, name: 'Alice', username: 'Alice', position: { x: 30, y: 64, z: 0 } }
    ;(bot.entities as unknown as Record<number, unknown>)[7] = alice
    ;(bot as unknown as { players: unknown }).players = {
      Alice: { entity: alice },
      Bob: { entity: null },
    }

    expect(port.playerOnline?.('Alice')).toBe(true)
    expect(port.playerOnline?.('Bob')).toBe(true)
    expect(port.playerOnline?.('Nobody')).toBe(false)
    expect(port.entityByName?.('Alice')).toMatchObject({
      id: '7',
      name: 'Alice',
      username: 'Alice',
      position: { x: 30, y: 64, z: 0 },
    })
    // Online but not tracked: the tab list does not invent a position.
    expect(port.entityByName?.('Bob')).toBeUndefined()
    // Non-player names fall back to the tracked-entity scan.
    expect(port.entityByName?.('cow')).toMatchObject({ id: '1', name: 'cow' })
    expect(port.entityById?.('2')).toMatchObject({ id: '2', name: 'far' })
    expect(port.entityById?.('999')).toBeUndefined()
  })

  it('reads block name and state, and keeps unloaded cells unknown', () => {
    const { port, bot } = createPort()
    bot.blocks.set('0,64,0', { name: 'oak_door', getProperties: () => ({ half: 'lower', open: false }) })
    expect(port.blockAt({ x: 0, y: 64, z: 0 })).toEqual({
      name: 'oak_door',
      state: { half: 'lower', open: 'false' },
      loaded: true,
    })
    expect(port.blockAt({ x: 9, y: 64, z: 9 })).toBeNull()

    const cells = port.blocksIn({ min: { x: 0, y: 64, z: 0 }, max: { x: 1, y: 64, z: 0 } })
    expect(cells).toEqual([
      { name: 'oak_door', state: { half: 'lower', open: 'false' }, loaded: true, pos: { x: 0, y: 64, z: 0 } },
      { name: '', loaded: false, pos: { x: 1, y: 64, z: 0 } },
    ])
  })

  it('finds nearest loaded blocks by name through the id-array fast path', () => {
    const { port, bot } = createPort()
    bot.blocks.set('4,64,0', { name: 'crafting_table', type: 182 })
    bot.blocks.set('1,64,0', { name: 'stone', type: 1 })
    bot.blocks.set('3,64,0', { name: 'stone', type: 1 })

    const stone = port.findBlocks({
      near: { x: 0, y: 64, z: 0 },
      radius: 8,
      names: ['stone'],
      count: 5,
    })
    expect(stone.map(block => block.pos)).toEqual([
      { x: 1, y: 64, z: 0 },
      { x: 3, y: 64, z: 0 },
    ])
    expect(bot.findCalls.at(-1)).toMatchObject({
      point: { x: 0, y: 64, z: 0 },
      matching: [1],
      maxDistance: 8,
      count: 5,
    })

    const table = port.findBlocks({
      near: { x: 0, y: 64, z: 0 },
      radius: 8,
      names: ['minecraft:crafting_table'],
      count: 5,
    })
    expect(table).toMatchObject([{
      name: 'crafting_table',
      loaded: true,
      pos: { x: 4, y: 64, z: 0 },
    }])

    const before = bot.findCalls.length
    expect(port.findBlocks({
      near: { x: 0, y: 64, z: 0 },
      radius: 8,
      names: ['not_a_block'],
      count: 5,
    })).toEqual([])
    expect(bot.findCalls.length).toBe(before)
  })

})

describe('mineflayer port attack speed', () => {
  function setAttackSpeed(
    bot: FakeBot,
    value: number,
    modifiers: Array<{ amount: number; operation: number }>,
  ): void {
    ;(bot.entity as unknown as { attributes?: Record<string, unknown> }).attributes = {
      'generic.attack_speed': { value, modifiers },
    }
  }

  it('applies held-item ADD_VALUE modifiers (sword 1.6, iron axe 0.9)', () => {
    const { port, bot } = createPort()
    setAttackSpeed(bot, 4, [{ amount: -2.4, operation: 0 }])
    expect(port.attackSpeed()).toBeCloseTo(1.6)
    setAttackSpeed(bot, 4, [{ amount: -3.1, operation: 0 }])
    expect(port.attackSpeed()).toBeCloseTo(0.9)
  })

  it('applies ADD_MULTIPLIED_BASE then ADD_MULTIPLIED_TOTAL', () => {
    const { port, bot } = createPort()
    setAttackSpeed(bot, 4, [
      { amount: 0.1, operation: 1 },
      { amount: 0.5, operation: 2 },
    ])
    expect(port.attackSpeed()).toBeCloseTo(6.6)
  })

  it('falls back to the base speed without attributes or with a non-positive result', () => {
    const { port, bot } = createPort()
    expect(port.attackSpeed()).toBe(4)
    setAttackSpeed(bot, 4, [{ amount: -4, operation: 0 }])
    expect(port.attackSpeed()).toBe(4)
  })
})

describe('mineflayer port attack reach', () => {
  function setReach(
    bot: FakeBot,
    value: number,
    modifiers: Array<{ amount: number; operation: number }> = [],
  ): void {
    ;(bot.entity as unknown as { attributes?: Record<string, unknown> }).attributes = {
      'player.entity_interaction_range': { value, modifiers },
    }
  }

  it('reads the player entity interaction range and defaults to 3', () => {
    const { port, bot } = createPort()
    expect(port.attackReach()).toBe(3)
    setReach(bot, 3)
    expect(port.attackReach()).toBeCloseTo(3)
  })

  it('applies held-item reach modifiers', () => {
    const { port, bot } = createPort()
    setReach(bot, 3, [{ amount: 1.5, operation: 0 }])
    expect(port.attackReach()).toBeCloseTo(4.5)
    setReach(bot, 4, [
      { amount: 0.5, operation: 1 },
      { amount: 0.25, operation: 2 },
    ])
    expect(port.attackReach()).toBeCloseTo(7.5)
  })

  it('falls back to 3 without the attribute or with a non-positive value', () => {
    const { port, bot } = createPort()
    expect(port.attackReach()).toBe(3)
    setReach(bot, 0)
    expect(port.attackReach()).toBe(3)
  })
})

describe('mineflayer port events', () => {
  it('forwards chat, damage, death, block updates and collection as data', () => {
    const { port, bot } = createPort()
    const seen: Array<{ event: BodyEvent; payload: unknown }> = []
    for (const event of ['chat', 'damaged', 'died', 'blockUpdated', 'inventoryChanged'] as const) {
      port.on(event, payload => seen.push({ event, payload }))
    }

    bot.emit('chat', 'Steve', 'hello')
    bot.emit('health')
    bot.emit('death')
    bot.emit('blockUpdate', null, { name: 'stone', position: { x: 1, y: 2, z: 3 } })
    bot.emit('playerCollect', bot.entity, {})

    expect(seen).toEqual([
      { event: 'chat', payload: { username: 'Steve', message: 'hello' } },
      { event: 'damaged', payload: { health: 20 } },
      { event: 'died', payload: {} },
      { event: 'blockUpdated', payload: { x: 1, y: 2, z: 3, name: 'stone' } },
      { event: 'inventoryChanged', payload: {} },
    ])
  })
})

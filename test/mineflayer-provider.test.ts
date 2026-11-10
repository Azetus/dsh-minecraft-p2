import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import type { Bot } from 'mineflayer'

import { MineflayerProvider } from '../src/provider/mineflayer.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function fakeBot() {
  const controls = new Map<string, boolean>()
  const bot = Object.assign(new EventEmitter(), {
    entity: {
      position: { x: 1, y: 64, z: 2 },
      onGround: true,
      velocity: { x: 0, y: 0, z: 0 },
    },
    inventory: { items: () => [{ name: 'stone', count: 2 }], slots: [] },
    heldItem: null,
    entities: {
      1: { id: 1, name: 'P2_Bot', type: 'player', position: { x: 1, y: 64, z: 2 } },
      2: { id: 2, name: 'cow', type: 'animal', position: { x: 4, y: 64, z: 2 } },
    },
    time: { timeOfDay: 1000, age: 1, doDaylightCycle: true },
    game: { difficulty: 'peaceful' },
    spawnPoint: { x: 0, y: 70, z: 0 },
    health: 20,
    food: 20,
    blockAt: () => ({ name: 'grass_block', position: { x: 1, y: 63, z: 2 } }),
    look: async () => {},
    setControlState: (name: string, value: boolean) => { controls.set(name, value) },
    getControlState: (name: string) => controls.get(name) ?? false,
    clearControlStates: () => { controls.clear() },
  })
  return { bot: bot as unknown as Bot, controls, emitter: bot }
}

describe('MineflayerProvider pause semantics', () => {
  it('reports a frozen server age as suspended with diagnostics, then resumed', () => {
    const { bot, emitter } = fakeBot()
    const provider = new MineflayerProvider(bot)
    const states: Array<{ suspended: boolean; diagnostics: { verdict: string } }> = []
    provider.onSuspension(state => states.push(state))

    provider.refreshPauseState(0)
    expect(provider.liveStatus().paused).toBe(false)
    // No time packets and no age change: the client is not receiving updates.
    provider.refreshPauseState(1_600)
    expect(provider.liveStatus().paused).toBe(true)
    expect(states.at(-1)?.suspended).toBe(true)
    expect(states.at(-1)?.diagnostics.verdict).toBe('client-stalled')

    // update_time packets keep arriving while the age is frozen: the server is
    // paused, not the connection.
    emitter.emit('time')
    provider.refreshPauseState(1_700)
    expect(provider.liveStatus().pauseDiagnostics?.verdict).toBe('server-paused')

    // Age advancing again is a resume, not a failed action.
    ;(bot as unknown as { time: { age: number } }).time.age = 101
    provider.refreshPauseState(1_800)
    expect(provider.liveStatus().paused).toBe(false)
    expect(states.at(-1)?.suspended).toBe(false)
  })

  it('does not abort on a first sample and keeps counters observable', () => {
    const { bot } = fakeBot()
    const provider = new MineflayerProvider(bot)
    provider.refreshPauseState(0)
    const diagnostics = provider.liveStatus().pauseDiagnostics
    expect(diagnostics).toMatchObject({ ageChanges: 0, verdict: 'running' })
    expect(typeof diagnostics?.eventLoopLagMs).toBe('number')
  })
})

describe('MineflayerProvider', () => {
  it('returns query values with source/freshness metadata', () => {
    const { bot } = fakeBot()
    const provider = new MineflayerProvider(bot)
    const position = provider.query('position')
    expect(position.status).toBe('ok')
    if (position.status !== 'ok') throw new Error('expected position')
    expect(position.value).toMatchObject({ x: 1, y: 64, z: 2, dimension: null })
    expect(position.meta?.source).toBe('query')
    expect(position.meta?.scope).toBe('mineflayer.position')
    expect(typeof position.meta?.validUntil).toBe('number')

    expect(provider.query('inventory').status).toBe('ok')
    expect(provider.query('health').status).toBe('ok')
    expect(provider.query('time').status).toBe('ok')
    expect(provider.query('block', { x: 1, y: 63, z: 2 }).status).toBe('ok')
    expect(provider.query('missing').status).toBe('failed')
  })

  it('returns the read-only spawn view without inventing a bed respawn point', () => {
    const { bot } = fakeBot()
    const provider = new MineflayerProvider(bot)
    const spawn = provider.query('spawn')
    expect(spawn.status).toBe('ok')
    if (spawn.status !== 'ok') throw new Error('expected spawn')
    expect(spawn.value).toMatchObject({
      worldSpawn: { x: 0, y: 70, z: 0 },
      lastSleepBed: null,
      respawnCheck: null,
    })
    ;(bot as unknown as { __p2?: unknown }).__p2 = {
      lastSleepBed: { x: -3, y: 60, z: 4 },
      respawnCheck: { ok: true, position: { x: -3, y: 60, z: 4 } },
    }
    const tracked = provider.query('spawn')
    expect(tracked).toMatchObject({
      status: 'ok',
      value: {
        lastSleepBed: { x: -3, y: 60, z: 4 },
        respawnCheck: { ok: true, position: { x: -3, y: 60, z: 4 } },
      },
    })
  })

  it('reports control state through a bounded act', () => {
    const { bot } = fakeBot()
    const provider = new MineflayerProvider(bot)
    expect(provider.controlState()).toBe('idle')
    const stop = provider.start('stop', {})
    expect(stop.poll().status).toBe('succeeded')
    expect(provider.controlState()).toBe('idle')
  })


  it('fails closed and aborts acts when the server age stalls', () => {
    const { bot } = fakeBot()
    const provider = new MineflayerProvider(bot, { serverIdleMs: 10 })
    const startedAt = Date.now()
    provider.refreshPauseState(startedAt)

    provider.start('stop', {})
    provider.refreshPauseState(startedAt + 20)
    expect(provider.liveStatus().paused).toBe(true)
    expect(provider.query('position')).toMatchObject({ status: 'failed', error: { code: 'GAME_PAUSED' } })
    const time = provider.query('time')
    expect(time.status).toBe('ok')
    if (time.status !== 'ok') throw new Error('expected time')
    expect(time.value).toMatchObject({ paused: true, age: 1 })

    let startError: unknown
    try { provider.start('stop', {}) } catch (error) { startError = error }
    expect(startError).toMatchObject({ code: 'GAME_PAUSED' })

    bot.time.age = 2
    provider.refreshPauseState(startedAt + 30)
    expect(provider.liveStatus().paused).toBe(false)
    const resumed = provider.query('position')
    expect(resumed.status).toBe('ok')
    if (resumed.status !== 'ok') throw new Error('expected resumed position')
    expect(resumed.meta).toMatchObject({ serverAge: 2, paused: false })
  })

  it('fails queries on connection end', () => {
    const { bot, emitter } = fakeBot()
    const provider = new MineflayerProvider(bot)
    emitter.emit('end', 'server closed')
    expect(provider.query('position')).toMatchObject({ status: 'failed' })
    expect(provider.liveStatus().lastDisconnect).toMatchObject({
      kind: 'end',
      reason: 'Mineflayer connection ended: server closed',
    })
  })

  it('keeps a server kick reason instead of the generic socket end', () => {
    const { bot, emitter } = fakeBot()
    const provider = new MineflayerProvider(bot)
    emitter.emit('kicked', 'You logged in from another location')
    emitter.emit('end', 'socketClosed')

    expect(provider.liveStatus()).toMatchObject({
      connected: false,
      lastDisconnect: {
        kind: 'kick',
        reason: 'Mineflayer kicked: You logged in from another location',
      },
    })
  })

  it('records a provider error when no kick arrives', () => {
    const { bot, emitter } = fakeBot()
    const provider = new MineflayerProvider(bot)
    emitter.emit('error', new Error('client timed out after 30000 milliseconds'))

    expect(provider.liveStatus()).toMatchObject({
      connected: false,
      lastDisconnect: {
        kind: 'error',
        reason: 'client timed out after 30000 milliseconds',
      },
    })
  })
})

describe('MineflayerProvider combat input', () => {
  it('sets persistent forward controls when the next cell is clear', async () => {
    const { bot } = fakeBot()
    ;(bot as unknown as { blockAt: (p: { x: number; y: number; z: number }) => unknown }).blockAt = point =>
      point.y < 64
        ? { name: 'stone', boundingBox: 'block' }
        : { name: 'air', boundingBox: 'empty' }
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('combat-input', {
      faceX: 3, faceY: 64, faceZ: 2, forward: true,
    })
    await sleep(100)
    expect(handle.poll().status).toBe('succeeded')
    expect((bot as unknown as { getControlState: (name: string) => boolean }).getControlState('forward')).toBe(true)
    provider.clearControls()
    expect((bot as unknown as { getControlState: (name: string) => boolean }).getControlState('forward')).toBe(false)
  })

  it('refuses an unsafe next cell', async () => {
    const { bot } = fakeBot()
    ;(bot as unknown as { blockAt: () => unknown }).blockAt = () => ({
      name: 'stone',
      boundingBox: 'block',
    })
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('combat-input', {
      faceX: 3, faceY: 64, faceZ: 2, forward: true,
    })
    await sleep(100)
    expect(handle.poll()).toMatchObject({
      status: 'failed',
      error: { code: 'COMBAT_INPUT_BLOCKED' },
    })
  })
})

describe('MineflayerProvider off-hand stance', () => {
  function stanceBot(): {
    bot: Bot
    emitter: EventEmitter
    using: () => boolean
    activations: () => number
    deactivations: () => number
  } {
    const { bot, emitter } = fakeBot()
    let using = false
    let activations = 0
    let deactivations = 0
    ;(bot as unknown as { inventory: { slots: Array<unknown> } }).inventory.slots[45] = {
      name: 'shield',
      count: 1,
    }
    ;(bot as unknown as { activateItem: (offhand?: boolean) => void }).activateItem = () => {
      activations += 1
      using = true
    }
    ;(bot as unknown as { deactivateItem: () => void }).deactivateItem = () => {
      deactivations += 1
      using = false
    }
    ;(bot as unknown as { usingHeldItem: boolean }).usingHeldItem = false
    return {
      bot,
      emitter,
      using: () => using,
      activations: () => activations,
      deactivations: () => deactivations,
    }
  }

  it('holds and releases the off hand idempotently without an act', () => {
    const { bot, using, activations, deactivations } = stanceBot()
    const provider = new MineflayerProvider(bot)

    expect(provider.offhandHold(true)).toEqual({ active: true, item: 'shield' })
    expect(provider.offhandActive()).toBe(true)
    expect(using()).toBe(true)
    expect(provider.offhandHold(true)).toEqual({ active: true, item: 'shield' })
    expect(activations()).toBe(1)

    expect(provider.offhandHold(false)).toEqual({ active: false, item: 'shield' })
    expect(provider.offhandActive()).toBe(false)
    expect(using()).toBe(false)
    expect(deactivations()).toBe(1)
  })

  it('rejects holding an empty off hand', () => {
    const { bot } = stanceBot()
    ;(bot as unknown as { inventory: { slots: Array<unknown> } }).inventory.slots[45] = null
    const provider = new MineflayerProvider(bot)
    expect(() => provider.offhandHold(true)).toThrow(/no off-hand item/u)
  })

  it('does not let a held stance block a step release, and keeps the stance', async () => {
    const { bot, using, deactivations } = stanceBot()
    const provider = new MineflayerProvider(bot)
    provider.offhandHold(true)

    const handle = provider.start('combat-step', {
      x: 2, y: 64, z: 2, faceX: 0, faceZ: 2, shield: false, timeoutMs: 5_000,
    })
    await sleep(30)
    handle.stop()
    for (let index = 0; index < 60 && handle.poll().status === 'running'; index += 1) await sleep(25)

    expect(handle.poll().status).toBe('cancelled')
    expect(provider.offhandActive()).toBe(true)
    expect(using()).toBe(true)
    expect(deactivations()).toBe(0)
  })

  it('releases the stance on death, pause and disconnect', () => {
    const death = stanceBot()
    const deathProvider = new MineflayerProvider(death.bot)
    deathProvider.offhandHold(true)
    death.emitter.emit('death')
    expect(deathProvider.offhandActive()).toBe(false)
    expect(death.using()).toBe(false)

    const paused = stanceBot()
    const pausedProvider = new MineflayerProvider(paused.bot, { serverIdleMs: 10 })
    pausedProvider.offhandHold(true)
    pausedProvider.refreshPauseState(0)
    pausedProvider.refreshPauseState(20)
    expect(pausedProvider.liveStatus().paused).toBe(true)
    expect(pausedProvider.offhandActive()).toBe(false)

    const gone = stanceBot()
    const goneProvider = new MineflayerProvider(gone.bot)
    goneProvider.offhandHold(true)
    gone.emitter.emit('end', 'server closed')
    expect(goneProvider.offhandActive()).toBe(false)
  })
})


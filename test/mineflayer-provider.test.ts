import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import type { Bot } from 'mineflayer'

import { MineflayerProvider } from '../src/provider/mineflayer.ts'

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

  it('runs move and stop acts through the P2 ActHandle surface', async () => {
    const { bot, controls } = fakeBot()
    const provider = new MineflayerProvider(bot)
    const move = provider.start('move', { direction: 'forward', durationMs: 10 })
    expect(move.poll().status).toBe('running')
    expect(controls.get('forward')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(move.poll().status).toBe('succeeded')
    expect(controls.get('forward')).toBe(false)

    const stopped = provider.start('move', { direction: 'forward', durationMs: 1000 })
    stopped.stop()
    expect(stopped.poll().status).toBe('cancelled')
    expect(controls.get('forward')).not.toBe(true)

    const stop = provider.start('stop', {})
    expect(stop.poll().status).toBe('succeeded')
  })

  it('fails closed and aborts acts when the server age stalls', () => {
    const { bot, controls } = fakeBot()
    const provider = new MineflayerProvider(bot, { serverIdleMs: 10 })
    const startedAt = Date.now()
    provider.refreshPauseState(startedAt)

    const move = provider.start('move', { direction: 'forward', durationMs: 1000 })
    provider.refreshPauseState(startedAt + 20)
    expect(provider.liveStatus().paused).toBe(true)
    expect(move.poll()).toMatchObject({ status: 'failed', error: { code: 'GAME_PAUSED' } })
    expect(controls.get('forward')).not.toBe(true)

    const position = provider.query('position')
    expect(position).toMatchObject({ status: 'failed', error: { code: 'GAME_PAUSED' } })
    const time = provider.query('time')
    expect(time.status).toBe('ok')
    if (time.status !== 'ok') throw new Error('expected time')
    expect(time.value).toMatchObject({ paused: true, age: 1 })

    let startError: unknown
    try { provider.start('move', { direction: 'forward' }) } catch (error) { startError = error }
    expect(startError).toMatchObject({ code: 'GAME_PAUSED' })

    bot.time.age = 2
    provider.refreshPauseState(startedAt + 30)
    expect(provider.liveStatus().paused).toBe(false)
    const resumed = provider.query('position')
    expect(resumed.status).toBe('ok')
    if (resumed.status !== 'ok') throw new Error('expected resumed position')
    expect(resumed.meta).toMatchObject({ serverAge: 2, paused: false })
  })

  it('moves toward a target and stops inside tolerance', () => {
    const { bot, controls } = fakeBot()
    const provider = new MineflayerProvider(bot)
    const move = provider.start('moveTo', { x: 3, z: 2, tolerance: 0.5, blockedMs: 1000 })
    expect(controls.get('forward')).toBe(true)
    bot.entity.position.x = 3
    bot.entity.position.z = 2
    expect(move.poll()).toMatchObject({
      status: 'succeeded',
      result: { distance: 0, target: { x: 3, z: 2 } },
    })
    expect(controls.get('forward')).not.toBe(true)
  })

  it('fails moveTo when it makes no progress', async () => {
    const { bot } = fakeBot()
    const provider = new MineflayerProvider(bot)
    const move = provider.start('moveTo', { x: 10, z: 2, blockedMs: 10, timeoutMs: 500 })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(move.poll()).toMatchObject({
      status: 'failed',
      error: { code: 'MOVE_TO_BLOCKED' },
    })
  })

  it('reports control state and marks unconfirmed cleanup best-effort', () => {
    const { bot } = fakeBot()
    const provider = new MineflayerProvider(bot)
    expect(provider.controlState()).toBe('idle')
    const move = provider.start('move', { direction: 'forward', durationMs: 1000 })
    expect(provider.controlState()).toBe('active')
    expect(provider.liveStatus().controlRelease).toBeNull()
    move.stop()
    expect(provider.controlState()).toBe('idle')
    expect(provider.liveStatus().controlRelease).toBe('confirmed')

    ;(bot as unknown as { clearControlStates: () => void }).clearControlStates = () => { throw new Error('cannot clear') }
    const stuck = provider.start('move', { direction: 'forward', durationMs: 1000 })
    stuck.stop()
    expect(provider.controlState()).toBe('unknown')
    expect(provider.liveStatus().controlRelease).toBe('best-effort')

    const { bot: disconnectedBot, emitter } = fakeBot()
    const disconnected = new MineflayerProvider(disconnectedBot)
    disconnected.start('move', { direction: 'forward', durationMs: 1000 })
    emitter.emit('end', 'server closed')
    expect(disconnected.controlState()).toBe('unknown')
  })

  it('fails the active act and queries on connection end', () => {
    const { bot, emitter } = fakeBot()
    const provider = new MineflayerProvider(bot)
    const move = provider.start('move', { direction: 'forward', durationMs: 1000 })
    emitter.emit('end', 'server closed')
    expect(move.poll()).toMatchObject({ status: 'failed' })
    expect(provider.query('position')).toMatchObject({ status: 'failed' })
  })
})


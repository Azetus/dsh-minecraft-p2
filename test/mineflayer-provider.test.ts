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
    inventory: { items: () => [{ name: 'stone', count: 2 }] },
    entities: {
      1: { id: 1, name: 'P2_Bot', type: 'player', position: { x: 1, y: 64, z: 2 } },
      2: { id: 2, name: 'cow', type: 'animal', position: { x: 4, y: 64, z: 2 } },
    },
    time: { timeOfDay: 1000 },
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
    expect(position.value).toEqual({ x: 1, y: 64, z: 2 })
    expect(position.meta?.source).toBe('query')
    expect(position.meta?.scope).toBe('mineflayer.position')
    expect(typeof position.meta?.validUntil).toBe('number')

    expect(provider.query('inventory').status).toBe('ok')
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

  it('fails the active act and queries on connection end', () => {
    const { bot, emitter } = fakeBot()
    const provider = new MineflayerProvider(bot)
    const move = provider.start('move', { direction: 'forward', durationMs: 1000 })
    emitter.emit('end', 'server closed')
    expect(move.poll()).toMatchObject({ status: 'failed' })
    expect(provider.query('position')).toMatchObject({ status: 'failed' })
  })
})

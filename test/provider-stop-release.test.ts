/**
 * M0 acceptance: provider stop is a request, release is an observation.
 *
 * Category: state safety. Protects C1 ("stop semantics must be verified") and
 * RUNTIME §5.1: a cancel flag must never be reported as released while the
 * pathfinder still moves, a craft chain still runs or a bed still sleeps.
 */

import { EventEmitter } from 'node:events'

import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'

import { MineflayerProvider } from '../src/provider/mineflayer.ts'

type FakeOptions = {
  moving?: boolean
  craftDelayMs?: number
}

function fakeBot(options: FakeOptions = {}) {
  const controls = new Map<string, boolean>()
  const inventory: Array<{ name: string; type: number; count: number }> = []
  const state = {
    craftCalls: 0,
    pathfinderStopCalls: 0,
    wakeCalls: 0,
    moving: options.moving ?? true,
    stuckControl: undefined as string | undefined,
  }
  const recipe = { result: { id: 5, count: 4 }, requiresTable: false, delta: [] }
  const bot = Object.assign(new EventEmitter(), {
    entity: {
      position: { x: 1, y: 64, z: 2 },
      onGround: true,
      velocity: { x: 0, y: 0, z: 0 },
    },
    inventory: {
      items: () => inventory,
      count: (type: number) => inventory.filter(item => item.type === type).reduce((sum, item) => sum + item.count, 0),
    },
    heldItem: { name: 'oak_log', type: 17, count: 8 },
    entities: {},
    time: { timeOfDay: 1000, age: 1, doDaylightCycle: true },
    game: { difficulty: 'peaceful' },
    health: 20,
    food: 20,
    isSleeping: false,
    targetDigBlock: { name: 'stone', position: { x: 2, y: 64, z: 2 } },
    currentWindow: null,
    registry: { itemsByName: { oak_planks: { id: 5 }, oak_log: { id: 17 } } },
    blockAt: () => ({ name: 'grass_block', position: { x: 1, y: 63, z: 2 } }),
    look: async () => {},
    lookAt: async () => {},
    setControlState: (name: string, value: boolean) => { controls.set(name, value) },
    getControlState: (name: string) => controls.get(name) ?? false,
    clearControlStates: () => {
      controls.clear()
      if (state.stuckControl !== undefined) controls.set(state.stuckControl, true)
    },
    stopDigging: () => { (bot as unknown as { targetDigBlock: unknown }).targetDigBlock = null },
    wake: async () => {
      state.wakeCalls += 1
      // The server confirms the wake a tick later; that is the release proof.
      await new Promise(resolve => setTimeout(resolve, 5))
      bot.isSleeping = false
    },
    recipesFor: () => [recipe],
    recipesAll: () => [recipe],
    craft: async () => {
      state.craftCalls += 1
      await new Promise(resolve => setTimeout(resolve, options.craftDelayMs ?? 20))
      inventory.push({ name: 'oak_planks', type: 5, count: 4 })
    },
    closeWindow: async () => {},
    _syncWindow: async () => {},
    pathfinder: {
      isMoving: () => state.moving,
      stop: () => {
        state.pathfinderStopCalls += 1
        // Mirrors the library: stop() only sets a flag; the path is cleared on
        // the next physics tick.
      },
    },
  })
  return { bot: bot as unknown as Bot, state, controls }
}

describe('Mineflayer provider release semantics (M0)', () => {
  it('keeps a lazy pathfinder stop unreleased until the path is really gone', () => {
    const { bot, state } = fakeBot({ moving: true })
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('goto', { x: 4, y: 64, z: 4 })
    // Without a live registry the provider cannot path-find, but the raw
    // pathfinder handle is exactly what a real stop has to wait for.
    expect(handle.poll()).toMatchObject({ status: 'failed', error: { code: 'GOTO_UNAVAILABLE' } })

    handle.stop()
    expect(state.pathfinderStopCalls).toBe(1)
    expect(provider.controlState()).toBe('active')
    expect(handle.poll().status).not.toBe('cancelled')

    state.moving = false
    expect(provider.controlState()).toBe('idle')
    expect(handle.poll()).toMatchObject({ status: 'cancelled' })
  })

  it('does not report idle when clearing control states did not take effect', () => {
    const { bot, state, controls } = fakeBot()
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('move', { direction: 'forward', durationMs: 5000 })
    expect(controls.get('forward')).toBe(true)

    state.stuckControl = 'forward'
    handle.stop()
    expect(provider.controlState()).toBe('active')
    expect(handle.poll()).toMatchObject({ status: 'running' })

    state.stuckControl = undefined
    controls.clear()
    expect(handle.poll()).toMatchObject({ status: 'cancelled' })
    expect(provider.controlState()).toBe('idle')
  })

  it('stops the craft chain between recipes instead of finishing the batch', async () => {
    const { bot, state } = fakeBot({ craftDelayMs: 20 })
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('craft', { item: 'oak_planks', count: 5 })
    await delay(35)
    expect(state.craftCalls).toBe(1)

    handle.stop()
    // The first recipe is done and the chain is in its settle window: release
    // is not proven yet, so stop must not claim the act had already stopped.
    expect(provider.controlState()).toBe('active')

    await delay(60)
    expect(handle.poll()).toMatchObject({ status: 'cancelled' })
    expect(state.craftCalls).toBe(1)
    expect(provider.controlState()).toBe('idle')
  })

  it('waits for the bed to actually wake before reporting release', async () => {
    const { bot, state } = fakeBot()
    ;(bot as unknown as { blockAt: () => unknown }).blockAt = () => ({ name: 'white_bed', position: { x: 1, y: 63, z: 2 } })
    bot.isSleeping = true
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('sleep', { x: 1, y: 63, z: 2 })
    handle.stop()
    expect(state.wakeCalls).toBe(1)
    expect(provider.controlState()).toBe('active')
    await delay(5)
    expect(provider.controlState()).toBe('idle')
    expect(handle.poll()).toMatchObject({ status: 'cancelled' })
  })

  it('confirms dig release only after the dig target is cleared', () => {
    const { bot } = fakeBot()
    const provider = new MineflayerProvider(bot)
    const handle = provider.start('dig', { x: 2, y: 64, z: 2 })
    handle.stop()
    expect(provider.controlState()).toBe('idle')
    expect(handle.poll()).toMatchObject({ status: 'cancelled' })
  })
})

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

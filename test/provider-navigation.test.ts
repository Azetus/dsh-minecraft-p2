/**
 * Cross-module contract / state safety: CONTRACTS §2, RUNTIME §4.
 * Real provider + real movement rules; the external pathfinder event stream
 * is controlled to distinguish searching, no path, and cancelled execution.
 */
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import type { Bot } from 'mineflayer'
import type { Block as BlockType } from 'prismarine-block'
import { Vec3 } from 'vec3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MineflayerProvider } from '../src/provider/mineflayer.ts'
import { MineflayerClientPort } from '../src/port/mineflayer/client-port.ts'
import { writeToken } from './helpers/mineflayer-fakes.ts'

const require = createRequire(import.meta.url)
const registry = require('prismarine-registry')('1.21.1')
const Block = require('prismarine-block')(registry)

function navigationBot(options: { realSearch?: boolean; terrain?: (p: Vec3) => string | BlockType | null } = {}) {
  const controls = new Map<string, boolean>()
  const goals: unknown[] = []
  const bot = Object.assign(new EventEmitter(), {
    registry,
    game: { minY: -64, height: 384 },
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, velocity: new Vec3(0, 0, 0) },
    entities: {},
    inventory: { items: () => [] },
    health: 20,
    food: 20,
    blockAt: (pos: Vec3): BlockType | null => {
      const p = pos.floored()
      const value = options.terrain?.(p) ?? (options.terrain === undefined ? (p.y < 64 ? 'stone' : 'air') : null)
      if (value === null) return null
      const block = typeof value === 'string' ? Block.fromStateId(registry.blocksByName[value].defaultState, 0) : value
      block.position = p
      return block
    },
    setControlState: (key: string, value: boolean) => { controls.set(key, value) },
    getControlState: (key: string) => controls.get(key) ?? false,
    clearControlStates: () => controls.clear(),
    pathfinder: {
      goal: null as unknown,
      setMovements: (_movements: unknown) => {},
      setGoal(goal: unknown) { this.goal = goal; goals.push(goal) },
      stop: () => {},
      isMoving: (): boolean => false,
      *getPathFromTo() { yield { result: { status: 'success', path: [], visitedNodes: 1, generatedNodes: 1 } } },
    },
  })
  if (options.realSearch) Object.assign(bot, { loadPlugin: (plugin: (bot: Bot) => void) => plugin(bot as unknown as Bot) })
  const provider = new MineflayerProvider(bot as unknown as Bot)
  return { bot, provider, controls, goals }
}

afterEach(() => vi.useRealTimers())

describe('provider navigation', () => {
  it('rejects an unloaded destination before starting a path', () => {
    const { bot, provider, goals } = navigationBot()
    bot.blockAt = () => null
    const handle = provider.start('goto', { x: 10, y: 64, z: 0 })
    expect(handle.poll()).toMatchObject({ status: 'failed', error: { code: 'GOTO_TARGET_UNLOADED' } })
    expect(goals.filter(goal => goal !== null)).toHaveLength(0)
    handle.stop()
  })

  it('uses definitive noPath instead of an idle heuristic or blind jump', async () => {
    vi.useFakeTimers()
    const { bot, provider, controls } = navigationBot()
    const handle = provider.start('goto', { x: 10, y: 64, z: 0 })
    await vi.advanceTimersByTimeAsync(1)
    bot.emit('path_update', { status: 'noPath', path: [], visitedNodes: 1, generatedNodes: 1 })
    await vi.advanceTimersByTimeAsync(250)
    expect(handle.poll()).toMatchObject({ status: 'failed', error: { code: 'GOTO_NO_PATH' } })
    expect(controls.get('jump')).not.toBe(true)
    handle.stop()
  })

  it('does not mistake an incremental search for a stuck body', async () => {
    vi.useFakeTimers()
    const { bot, provider, controls } = navigationBot()
    const handle = provider.start('goto', { x: 10, y: 64, z: 0 })
    await vi.advanceTimersByTimeAsync(1)
    bot.emit('path_update', { status: 'partial', path: [], visitedNodes: 10, generatedNodes: 20 })
    await vi.advanceTimersByTimeAsync(2100)
    expect(handle.poll().status).toBe('running')
    expect(controls.get('jump')).not.toBe(true)
    expect(controls.get('forward')).not.toBe(true)
    handle.stop()
  })

  it('uses physical displacement even when isMoving remains true, then bounds recovery', async () => {
    vi.useFakeTimers()
    const { bot, provider, goals } = navigationBot()
    bot.pathfinder.isMoving = () => bot.pathfinder.goal !== null
    const handle = provider.start('goto', { x: 10, y: 64, z: 0 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(handle.poll()).toMatchObject({ status: 'failed', error: { code: 'GOTO_STUCK', details: { recoveries: 3 } } })
    expect(goals.filter(goal => goal !== null)).toHaveLength(3)
    expect(bot.pathfinder.goal).toBeNull()
    handle.stop()
  })

  it('cleans timers and listeners so cancellation cannot touch the next writer', async () => {
    vi.useFakeTimers()
    const { bot, provider, controls, goals } = navigationBot()
    const handle = provider.start('goto', { x: 10, y: 64, z: 0 })
    await vi.advanceTimersByTimeAsync(3_100)
    handle.stop()
    const before = goals.length
    controls.set('forward', true)
    bot.emit('path_update', { status: 'success', path: [], visitedNodes: 1, generatedNodes: 1 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(controls.get('forward')).toBe(true)
    expect(goals).toHaveLength(before)
    expect(bot.listenerCount('path_update')).toBe(0)
    expect(handle.poll().status).toBe('cancelled')
  })

  it('replans on same-type block state changes and stops on deadline', async () => {
    vi.useFakeTimers()
    const { bot, provider, goals, controls } = navigationBot()
    const handle = provider.start('goto', { x: 10, y: 64, z: 0, timeoutMs: 500 })
    await vi.advanceTimersByTimeAsync(1)
    bot.emit('blockUpdate', { type: 1, stateId: 1, position: new Vec3(1, 64, 0) },
      { type: 1, stateId: 2, position: new Vec3(1, 64, 0) })
    await vi.advanceTimersByTimeAsync(499)
    expect(goals.filter(goal => goal !== null)).toHaveLength(2)
    expect(handle.poll()).toMatchObject({ status: 'failed', error: { code: 'GOTO_TIMEOUT' } })
    expect(bot.pathfinder.goal).toBeNull()
    expect([...controls.values()].some(Boolean)).toBe(false)
  })

  it('preserves unconfirmed cancellation across the port and refuses another executor', async () => {
    vi.useFakeTimers()
    const { bot, provider } = navigationBot()
    const port = new MineflayerClientPort(bot as unknown as Bot, provider)
    port.beginWrite(writeToken(1))
    const pending = port.moveTo({ x: 10, y: 64, z: 0 })
    await vi.advanceTimersByTimeAsync(1)
    bot.pathfinder.setGoal = () => { throw new Error('cannot release goal') }
    port.endWrite(writeToken(1))
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toMatchObject({ state: 'unknown', code: 'STOP_UNCONFIRMED' })
    expect(() => provider.start('goto', { x: 3, y: 64, z: 0 })).toThrow()
    expect(bot.listenerCount('path_update')).toBe(0)
  })

  it('keeps no-path diagnostics and events across the port', async () => {
    vi.useFakeTimers()
    const { bot, provider } = navigationBot()
    const port = new MineflayerClientPort(bot as unknown as Bot, provider)
    const events: unknown[] = []
    port.on('move.no_path', event => events.push(event))
    port.beginWrite(writeToken(1))
    const pending = port.moveTo({ x: 10, y: 64, z: 0 })
    await vi.advanceTimersByTimeAsync(1)
    bot.emit('path_update', { status: 'noPath', path: [], visitedNodes: 2, generatedNodes: 3 })
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toMatchObject({ state: 'failed', code: 'GOTO_NO_PATH', observed: {
      from: { x: 0.5, y: 64, z: 0.5 }, target: { x: 10, y: 64, z: 0 }, pathStatus: 'noPath',
    } })
    expect(events).toHaveLength(1)
  })

  it('accepts a safe GoalNear endpoint but never completes at a partial prefix', async () => {
    vi.useFakeTimers()
    const { bot, provider } = navigationBot({ terrain: p => p.y < 64 || (p.x === 6 && p.z === 0 && p.y === 64) ? 'stone' : 'air' })
    const handle = provider.start('goto', { x: 6, y: 64, z: 0, range: 1 })
    await vi.advanceTimersByTimeAsync(1)
    bot.entity.position = new Vec3(3.5, 64, 0.5)
    bot.emit('path_update', { status: 'partial', path: [new Vec3(3, 64, 0)], visitedNodes: 1, generatedNodes: 1 })
    await vi.advanceTimersByTimeAsync(100)
    expect(handle.poll().status).toBe('running')
    bot.entity.position = new Vec3(5.5, 64, 0.5)
    await vi.advanceTimersByTimeAsync(100)
    expect(handle.poll()).toMatchObject({ status: 'succeeded', result: { phase: 'arrived' } })
    expect(bot.pathfinder.goal).toBeNull()
  })

  it('stops search at the node budget without calling the target unreachable', async () => {
    vi.useFakeTimers()
    const { bot, provider } = navigationBot()
    bot.pathfinder.getPathFromTo = function * () {
      yield { result: { status: 'partial', path: [], visitedNodes: 12_000, generatedNodes: 12_001 } }
    }
    const port = new MineflayerClientPort(bot as unknown as Bot, provider)
    port.beginWrite(writeToken(1))
    const pending = port.moveTo({ x: 10, y: 64, z: 0 })
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toMatchObject({ state: 'unknown', code: 'GOTO_SEARCH_LIMIT' })
    expect(bot.pathfinder.goal).toBeNull()
  })
})

/** Upstream tripwire: real 1.21.1 registry/collisions and pathfinder 2.4.5 A*.
 * Static block fixtures test our movement policy, not a simulated game/physics.
 */
describe('navigation terrain contract with real A*', () => {
  const flat = (p: Vec3): string | null => Math.abs(p.x) > 12 || Math.abs(p.z) > 4 || p.y < 60 || p.y > 70
    ? null : p.y < 64 ? 'stone' : 'air'
  const cases: Array<{ name: string; terrain: (p: Vec3) => string | BlockType | null; target: Vec3; code?: string; startY?: number }> = [
    { name: 'flat ground', terrain: flat, target: new Vec3(6, 64, 0) },
    { name: 'one-block step', terrain: p => flat(p) === null ? null : p.x >= 2 && p.y === 64 ? 'stone' : flat(p), target: new Vec3(6, 65, 0) },
    { name: 'narrow corridor', terrain: p => p.z !== 0 && p.y >= 64 ? 'stone' : flat(p), target: new Vec3(6, 64, 0) },
    { name: 'one-block pit', terrain: p => p.x === 0 && p.z === 0 && p.y === 63 ? 'air' : flat(p), target: new Vec3(6, 64, 0), startY: 63 },
    { name: 'two-block safe drop', terrain: p => flat(p) === null ? null : p.x >= 3 && p.y >= 62 ? 'air' : flat(p), target: new Vec3(6, 62, 0) },
    { name: 'three-block cliff', terrain: p => flat(p) === null ? null : p.x >= 3 && p.y >= 61 ? 'air' : flat(p), target: new Vec3(6, 61, 0), code: 'GOTO_NO_PATH' },
    { name: 'diagonal drop onto magma', terrain: p => flat(p) === null ? null : p.x === 3 && p.y === 62 ? 'magma_block'
      : p.x >= 3 && p.y >= 63 ? 'air' : flat(p), target: new Vec3(6, 63, 0), code: 'GOTO_NO_PATH' },
    { name: 'one-block-high space', terrain: p => p.y === 65 ? 'stone' : flat(p), target: new Vec3(6, 64, 0), code: 'GOTO_INVALID_TARGET' },
    { name: 'solid target', terrain: p => p.x === 6 && p.y === 64 && p.z === 0 ? 'stone' : flat(p), target: new Vec3(6, 64, 0), code: 'GOTO_INVALID_TARGET' },
    { name: 'unloaded target', terrain: p => p.x >= 6 ? null : flat(p), target: new Vec3(6, 64, 0), code: 'GOTO_TARGET_UNLOADED' },
    { name: 'sealed air pocket', terrain: p => p.x >= 5 && p.x <= 7 && Math.abs(p.z) <= 1 && p.y >= 64 && p.y <= 66
      && !(p.x === 6 && p.z === 0 && p.y < 66) ? 'stone' : flat(p), target: new Vec3(6, 64, 0), code: 'GOTO_NO_PATH' },
    { name: 'unreachable high ground', terrain: p => p.x >= 3 && p.y >= 64 && p.y <= 67 ? 'stone' : flat(p), target: new Vec3(6, 68, 0), code: 'GOTO_NO_PATH' },
    { name: 'lava barrier', terrain: p => p.x === 3 && p.y === 63 ? 'lava' : flat(p), target: new Vec3(6, 64, 0), code: 'GOTO_NO_PATH' },
    { name: 'deep water barrier', terrain: p => p.x >= 3 && p.x <= 5 && p.y >= 60 && p.y <= 64 ? 'water' : flat(p), target: new Vec3(7, 64, 0), code: 'GOTO_NO_PATH' },
    { name: 'closed door needs explicit interaction', terrain: p => p.y >= 64 && p.y <= 66 && p.x === 3
      ? p.z === 0 && p.y < 66
        ? Block.fromProperties(registry.blocksByName.oak_door.id, { facing: 'west', half: p.y === 64 ? 'lower' : 'upper', hinge: 'left', open: false, powered: false }, 0)
        : 'stone'
      : flat(p), target: new Vec3(6, 64, 0), code: 'GOTO_NO_PATH' },
    { name: 'lower slab destination', terrain: p => p.x === 6 && p.y === 63 && p.z === 0
      ? Block.fromProperties(registry.blocksByName.stone_slab.id, { type: 'bottom', waterlogged: false }, 0) : flat(p), target: new Vec3(6, 64, 0) },
    { name: 'stairs', terrain: p => p.x === 2 && p.y === 64
      ? Block.fromProperties(registry.blocksByName.oak_stairs.id, { facing: 'west', half: 'bottom', shape: 'straight', waterlogged: false }, 0)
      : p.x > 2 && p.y === 64 ? 'stone' : flat(p), target: new Vec3(6, 65, 0) },
  ]
  it.each(cases)('$name', async ({ terrain, target, code, startY }) => {
    vi.useFakeTimers()
    const { bot, provider } = navigationBot({ realSearch: true, terrain })
    if (startY !== undefined) bot.entity.position.y = startY
    const handle = provider.start('goto', { ...target, range: 0 })
    await vi.advanceTimersByTimeAsync(300)
    const result = handle.poll()
    if (code !== undefined) {
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed', error: { code } })
      expect((bot as unknown as Bot).pathfinder.goal).toBeNull()
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'running', progress: { phase: 'moving', pathStatus: 'success' } })
    }
    handle.stop()
    bot.emit('end', 'fixture complete')
  })
})

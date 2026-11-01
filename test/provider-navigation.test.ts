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
    heldItem: null,
    world: { raycast: (_from: Vec3, _direction: Vec3, _range: number): BlockType | null => null },
    lookAt: async (_point: Vec3, _force?: boolean): Promise<void> => {},
    supportFeature: () => true,
    swingArm: () => {},
    _client: Object.assign(new EventEmitter(), { write: (_name: string, _data: unknown) => {} }),
    targetDigBlock: null as BlockType | null,
    digTime: (_block: BlockType) => 50,
    canDigBlock: (_block: BlockType) => true,
    dig: async (_block: BlockType, _force?: boolean | 'ignore'): Promise<void> => {},
    stopDigging: () => { bot.targetDigBlock = null },
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

function doorFixture() {
  let open = false
  const fixture = navigationBot({ realSearch: true, terrain: p => {
    if (Math.abs(p.x) > 12 || Math.abs(p.z) > 3 || p.y < 60 || p.y > 70) return null
    if (p.y < 64) return 'stone'
    if (p.x !== 3 || p.y > 66) return 'air'
    if (p.z !== 0 || p.y === 66) return 'stone'
    return Block.fromProperties(registry.blocksByName.oak_door.id,
      { facing: 'west', half: p.y === 64 ? 'lower' : 'upper', hinge: 'left', open, powered: false }, 0)
  } })
  const uses: unknown[] = []
  const raycast = require('prismarine-world/src/worldsync').prototype.raycast
  fixture.bot.world.raycast = (from, direction, range) => raycast.call({ getBlock: fixture.bot.blockAt }, from, direction, range)
  fixture.bot._client.write = (name, data) => { if (name === 'block_place') { uses.push(data); open = !open } }
  return { ...fixture, uses, isOpen: () => open }
}

function digFixture(options: { material?: string; neighbour?: string; ack?: boolean } = {}) {
  let removed = false
  let searches = 0
  const target = new Vec3(1, 65, 0)
  const fixture = navigationBot({ terrain: p => p.equals(target) ? removed ? 'air' : options.material ?? 'dirt'
    : p.equals(target.offset(0, 1, 0)) && options.neighbour !== undefined ? options.neighbour
    : p.y < 64 ? 'stone' : 'air' })
  const digs: number[] = []
  fixture.bot.world.raycast = () => fixture.bot.blockAt(target)
  fixture.bot.pathfinder.getPathFromTo = function * () {
    searches++
    yield { result: { status: removed ? 'success' : 'noPath', path: [], visitedNodes: 1, generatedNodes: 1 } }
  }
  fixture.bot.dig = async (_block, force) => {
    expect(force).toBe('ignore')
    digs.push(searches)
    removed = true
    if (options.ack !== false) fixture.bot._client.emit('block_change', { location: target, type: 0 })
  }
  const args = { x: 6, y: 64, z: 0, range: 0,
    unstickDig: [{ x: target.x, y: target.y, z: target.z, name: options.material ?? 'dirt' }] }
  return { ...fixture, args, digs }
}

describe('provider navigation', () => {
  it('digs an authorized local obstacle only after path and waypoint failures, with server readback events', async () => {
    vi.useFakeTimers()
    const { bot, provider, args, digs } = digFixture()
    const port = new MineflayerClientPort(bot as unknown as Bot, provider)
    const events: unknown[] = []
    port.on('move.unstick-dig', event => events.push(event))
    port.beginWrite(writeToken(1))
    const pending = port.moveTo(args, { range: 0, unstickDig: args.unstickDig })
    await vi.advanceTimersByTimeAsync(500)
    expect(digs).toHaveLength(1)
    expect(digs[0]).toBeGreaterThanOrEqual(3)
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'unstick-dig', state: 'readback', detail: expect.objectContaining({ source: 'block_change' }) })]))
    bot.entity.position = new Vec3(6.5, 64, 0.5)
    await vi.advanceTimersByTimeAsync(150)
    expect((await pending).state).toBe('ok')
    expect(bot._client.listenerCount('block_change')).toBe(0)
  })

  it.each([
    { material: 'chest' }, { material: 'red_bed' }, { material: 'spawner' },
    { neighbour: 'water' }, { neighbour: 'stone' }, { material: 'bedrock' }, { material: 'stone' },
  ])('refuses protected, load-bearing, fluid-boundary or wrong-tool digging: %j', async options => {
    vi.useFakeTimers()
    const { provider, args, digs } = digFixture(options)
    const handle = provider.start('goto', args)
    await vi.advanceTimersByTimeAsync(500)
    expect(digs).toHaveLength(0)
    expect(handle.poll()).toMatchObject({ status: 'failed', error: { code: 'GOTO_STUCK' } })
  })

  it('does not accept optimistic local air as server confirmation', async () => {
    vi.useFakeTimers()
    const { provider, args } = digFixture({ ack: false })
    const handle = provider.start('goto', args)
    await vi.advanceTimersByTimeAsync(1_700)
    expect(handle.poll()).toMatchObject({ status: 'failed', error: { code: 'GOTO_UNSTICK_TIMEOUT' } })
  })

  it('never extends two authorized digs into a tunnel', async () => {
    vi.useFakeTimers()
    const obstacles = [new Vec3(0, 66, 0), new Vec3(1, 65, 0), new Vec3(1, 64, 0)]
    const removed = new Set<string>()
    const { bot, provider } = navigationBot({ terrain: p => obstacles.some(q => p.equals(q)) && !removed.has(p.toString())
      ? 'dirt' : p.y < 64 ? 'stone' : 'air' })
    bot.pathfinder.getPathFromTo = function * () { yield { result: { status: 'noPath', path: [], visitedNodes: 1, generatedNodes: 1 } } }
    bot.world.raycast = () => bot.blockAt(obstacles.find(p => !removed.has(p.toString()))!)
    bot.dig = async block => {
      removed.add(block.position.toString())
      bot._client.emit('block_change', { location: block.position, type: 0 })
    }
    const handle = provider.start('goto', { x: 6, y: 64, z: 0, range: 0,
      unstickDig: obstacles.slice(0, 2).map(p => ({ x: p.x, y: p.y, z: p.z, name: 'dirt' })) })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(removed.size).toBe(2)
    expect(bot.blockAt(obstacles[2]!)?.name).toBe('dirt')
    expect(handle.poll()).toMatchObject({ status: 'failed', error: { code: 'GOTO_STUCK' } })
  })

  it('rejects digging authorization larger than two cells before navigation starts', () => {
    const { provider, args, digs } = digFixture()
    expect(provider.start('goto', { ...args, unstickDig: [args.unstickDig[0]!, args.unstickDig[0]!, args.unstickDig[0]!] }).poll())
      .toMatchObject({ status: 'failed', error: { code: 'BAD_ARGS' } })
    expect(digs).toHaveLength(0)
  })

  it('never digs its footing even when explicitly listed', async () => {
    vi.useFakeTimers()
    const { provider, args, digs } = digFixture()
    args.unstickDig = [{ x: 0, y: 63, z: 0, name: 'stone' }]
    const handle = provider.start('goto', args)
    await vi.advanceTimersByTimeAsync(500)
    expect(digs).toHaveLength(0)
    expect(handle.poll().status).toBe('failed')
  })

  it('fences digging when a delayed look completes after cancellation', async () => {
    vi.useFakeTimers()
    const { bot, provider, args, digs } = digFixture()
    let finishLook!: () => void
    bot.lookAt = () => new Promise(resolve => { finishLook = resolve })
    const handle = provider.start('goto', args)
    await vi.advanceTimersByTimeAsync(100)
    expect(handle.poll()).toMatchObject({ status: 'running', progress: { phase: 'unstick-dig' } })
    handle.stop()
    finishLook()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(digs).toHaveLength(0)
    expect(handle.poll().status).toBe('cancelled')
    expect(bot._client.listenerCount('multi_block_change')).toBe(0)
  })

  it('stops an active dig immediately and ignores its late completion', async () => {
    vi.useFakeTimers()
    const { bot, provider, args, goals, controls } = digFixture()
    let complete!: () => void
    bot.dig = block => { bot.targetDigBlock = block; return new Promise(resolve => { complete = resolve }) }
    const handle = provider.start('goto', args)
    await vi.advanceTimersByTimeAsync(100)
    expect(bot.targetDigBlock).not.toBeNull()
    handle.stop()
    expect(bot.targetDigBlock).toBeNull()
    const count = goals.length
    controls.set('forward', true)
    complete()
    bot._client.emit('block_change', { location: { x: 1, y: 65, z: 0 }, type: 0 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(goals).toHaveLength(count)
    expect(controls.get('forward')).toBe(true)
    expect(handle.poll().status).toBe('cancelled')
  })
  it('opens a route door, reads it back, and closes only its own door after crossing', async () => {
    vi.useFakeTimers()
    const { bot, provider, uses, isOpen } = doorFixture()
    const handle = provider.start('goto', { x: 7, y: 64, z: 0, range: 0 })
    await vi.advanceTimersByTimeAsync(500)
    expect(isOpen()).toBe(true)
    expect(uses).toHaveLength(1)
    expect(handle.poll()).toMatchObject({ status: 'running', progress: { actions: expect.arrayContaining([
      expect.objectContaining({ kind: 'door', state: 'readback', detail: expect.objectContaining({ open: true }) }),
    ]) } })
    bot.entity.position = new Vec3(5.5, 64, 0.5)
    await vi.advanceTimersByTimeAsync(500)
    expect(isOpen()).toBe(false)
    expect(uses).toHaveLength(2)
    handle.stop()
    bot.emit('end', 'fixture complete')
  })

  it('cannot issue a door packet when the look finishes after cancellation', async () => {
    vi.useFakeTimers()
    const { bot, provider, uses } = doorFixture()
    let finishLook!: () => void
    bot.lookAt = () => new Promise(resolve => { finishLook = resolve })
    const handle = provider.start('goto', { x: 7, y: 64, z: 0, range: 0 })
    await vi.advanceTimersByTimeAsync(100)
    expect(handle.poll()).toMatchObject({ status: 'running', progress: { phase: 'door' } })
    handle.stop()
    finishLook()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(uses).toHaveLength(0)
    expect(handle.poll().status).toBe('cancelled')
    bot.emit('end', 'fixture complete')
  })

  it('does not accept an unacknowledged door use as opened', async () => {
    vi.useFakeTimers()
    const { bot, provider } = doorFixture()
    bot._client.write = () => {}
    const handle = provider.start('goto', { x: 7, y: 64, z: 0, range: 0 })
    await vi.advanceTimersByTimeAsync(2_100)
    expect(handle.poll()).toMatchObject({ status: 'failed', error: { code: 'GOTO_DOOR_TIMEOUT' } })
    expect(bot.pathfinder.goal).toBeNull()
    bot.emit('end', 'fixture complete')
  })
  it('reports APPROACH separately when the requested cell is blocked', async () => {
    vi.useFakeTimers()
    const { bot, provider } = navigationBot({ terrain: p => p.y < 64 || (p.x === 6 && p.y === 64 && p.z === 0) ? 'stone' : 'air' })
    const handle = provider.start('goto', { x: 6, y: 64, z: 0, range: 0, approach: true })
    await vi.advanceTimersByTimeAsync(1)
    bot.entity.position = new Vec3(3.5, 64, 0.5)
    await vi.advanceTimersByTimeAsync(100)
    expect(handle.poll()).toMatchObject({ status: 'succeeded', result: {
      approach: true, requested: { x: 6, y: 64, z: 0 }, actual: { x: 3.5, y: 64, z: 0.5 },
      reason: 'no-safe-standing-space',
    } })
    const result = handle.poll()
    if (result.status === 'succeeded') expect((result.result as { fallbackDistance: number }).fallbackDistance).toBeLessThanOrEqual(4.5)
  })

  it('forbids APPROACH when exact is true', () => {
    const { provider } = navigationBot({ terrain: p => p.y < 64 || (p.x === 6 && p.y === 64 && p.z === 0) ? 'stone' : 'air' })
    expect(provider.start('goto', { x: 6, y: 64, z: 0, approach: true, exact: true }).poll())
      .toMatchObject({ status: 'failed', error: { code: 'GOTO_INVALID_TARGET' } })
  })

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
    { name: 'one-cell gap', terrain: p => p.x === 3 && p.y >= 62 && p.y < 64 ? 'air' : flat(p), target: new Vec3(6, 64, 0) },
    { name: 'one-cell gap over a three-block fall', terrain: p => Math.abs(p.x) > 12 || Math.abs(p.z) > 4 || p.y < 60 || p.y > 73
      ? null
      : p.x === 3 && p.y >= 66 && p.y <= 69 ? 'air'
        : p.y === 68 || p.y === 65 ? 'stone' : 'air', target: new Vec3(6, 69, 0), startY: 69 },
    { name: 'one-cell gap over a four-block fall is forbidden', terrain: p => Math.abs(p.x) > 12 || Math.abs(p.z) > 4 || p.y < 60 || p.y > 73
      ? null
      : p.x === 3 && p.y >= 65 && p.y <= 69 ? 'air'
        : p.y === 68 || p.y === 64 ? 'stone' : 'air', target: new Vec3(6, 69, 0), startY: 69, code: 'GOTO_NO_PATH' },
    { name: 'two-cell gap is not enabled', terrain: p => p.x >= 3 && p.x <= 4 && p.y >= 62 && p.y < 64 ? 'air' : flat(p), target: new Vec3(6, 64, 0), code: 'GOTO_NO_PATH' },
    { name: 'gap above lava is forbidden', terrain: p => p.x === 3 && p.y === 62 ? 'lava' : p.x === 3 && p.y === 63 ? 'air' : flat(p), target: new Vec3(6, 64, 0), code: 'GOTO_NO_PATH' },
    { name: 'gap without jump headroom', terrain: p => p.x === 3 && p.y >= 62 && p.y < 64 ? 'air' : p.y === 66 ? 'stone' : flat(p), target: new Vec3(6, 64, 0), code: 'GOTO_NO_PATH' },
    { name: 'one-block step', terrain: p => flat(p) === null ? null : p.x >= 2 && p.y === 64 ? 'stone' : flat(p), target: new Vec3(6, 65, 0) },
    { name: 'narrow corridor', terrain: p => p.z !== 0 && p.y >= 64 ? 'stone' : flat(p), target: new Vec3(6, 64, 0) },
    { name: 'one-block pit', terrain: p => p.x === 0 && p.z === 0 && p.y === 63 ? 'air' : flat(p), target: new Vec3(6, 64, 0), startY: 63 },
    { name: 'two-block safe drop', terrain: p => flat(p) === null ? null : p.x >= 3 && p.y >= 62 ? 'air' : flat(p), target: new Vec3(6, 62, 0) },
    { name: 'three-block safe fall', terrain: p => flat(p) === null ? null : p.x >= 3 && p.y >= 61 ? 'air' : flat(p), target: new Vec3(6, 61, 0) },
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
    { name: 'iron door needs external redstone', terrain: p => p.y >= 64 && p.y <= 66 && p.x === 3
      ? p.z === 0 && p.y < 66
        ? Block.fromProperties(registry.blocksByName.iron_door.id, { facing: 'west', half: p.y === 64 ? 'lower' : 'upper', hinge: 'left', open: false, powered: false }, 0)
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

  it('routes into the fenced cake through its door and gate', async () => {
    vi.useFakeTimers()
    const door = (half: 'lower' | 'upper') => Block.fromProperties(registry.blocksByName.oak_door.id,
      { facing: 'south', half, hinge: 'left', open: false, powered: false }, 0)
    const gate = Block.fromProperties(registry.blocksByName.oak_fence_gate.id,
      { facing: 'north', open: false, in_wall: false, powered: false }, 0)
    const terrain = (p: Vec3): string | BlockType | null => {
      if (p.x < -16 || p.x > 0 || p.z < -24 || p.z > -8 || p.y < 60 || p.y > 75) return null
      if (p.x === -4 && p.y === 67 && p.z === -20) return 'cake'
      if (p.x === -4 && p.y === 66 && p.z === -20) return 'obsidian'
      if (p.x === -4 && p.y === 66 && p.z === -14) return door('lower')
      if (p.x === -4 && p.y === 67 && p.z === -14) return door('upper')
      if (p.x === -4 && p.y === 66 && p.z === -18) return gate
      if (p.y === 66 && (p.x === -6 || p.x === -2) && p.z >= -22 && p.z <= -14) return 'oak_fence'
      if (p.y === 66 && (p.z === -22 || p.z === -14 || p.z === -18) && p.x >= -6 && p.x <= -2) return 'oak_fence'
      if (p.y === 66 && p.x >= -5 && p.x <= -3 && p.z >= -21 && p.z <= -15) return 'short_grass'
      if (p.y <= 65) return 'grass_block'
      return 'air'
    }
    const { bot, provider } = navigationBot({ realSearch: true, terrain })
    bot.entity.position = new Vec3(-9.5, 66, -15.5)
    const handle = provider.start('goto', { x: -4, y: 67, z: -20, range: 1, approach: true })
    await vi.advanceTimersByTimeAsync(300)
    const result = handle.poll()
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'running', progress: { phase: 'moving', pathStatus: 'success' } })
    handle.stop()
    bot.emit('end', 'fixture complete')
  })

  it('walks down a three-block platform with a health-budgeted fall', async () => {
    vi.useFakeTimers()
    const terrain = (p: Vec3): string | null => {
      if (p.y <= 65) return 'stone'
      if (p.x === 0 && p.z === 0 && p.y === 68) return 'stone'
      return 'air'
    }
    const { bot, provider } = navigationBot({ realSearch: true, terrain })
    bot.entity.position = new Vec3(0.5, 69, 0.5)
    const handle = provider.start('goto', { x: 6, y: 66, z: 0, range: 0 })
    await vi.advanceTimersByTimeAsync(300)
    expect(handle.poll(), JSON.stringify(handle.poll())).toMatchObject({
      status: 'running', progress: { safeFallPass: true },
    })
    handle.stop()
    bot.emit('end', 'fixture complete')
  })

  it('only permits a fatal fall when the caller allows that hazard', async () => {
    vi.useFakeTimers()
    const terrain = (p: Vec3): string | null => {
      if (p.y <= 65) return 'stone'
      if (p.x === 0 && p.z === 0 && p.y === 68) return 'stone'
      return 'air'
    }
    const { bot, provider } = navigationBot({ realSearch: true, terrain })
    bot.entity.position = new Vec3(0.5, 69, 0.5)
    bot.health = 3
    const blocked = provider.start('goto', { x: 6, y: 66, z: 0, range: 0 })
    await vi.advanceTimersByTimeAsync(300)
    expect(blocked.poll(), JSON.stringify(blocked.poll())).toMatchObject({ status: 'failed', error: { code: 'GOTO_NO_PATH' } })
    blocked.stop()

    const allowed = provider.start('goto', {
      x: 6, y: 66, z: 0, range: 0,
      hazards: { allow: ['lethal_fall'], reason: 'test' },
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(allowed.poll(), JSON.stringify(allowed.poll())).toMatchObject({
      status: 'running', progress: { hazardPass: true, hazards: { allow: ['lethal_fall'] } },
    })
    allowed.stop()
    bot.emit('end', 'fixture complete')
  })

  it('steps into an allowed void target and terminates on death', async () => {
    vi.useFakeTimers()
    const terrain = (p: Vec3): string | null => {
      if (p.y <= 65) return 'stone'
      if (p.x === 0 && p.z === 0 && p.y === 68) return 'stone'
      return 'air'
    }
    const { bot, provider } = navigationBot({ realSearch: true, terrain })
    bot.entity.position = new Vec3(0.5, 69, 0.5)
    const handle = provider.start('goto', {
      x: 1, y: 69, z: 0, range: 0,
      hazards: { allow: ['void'], reason: 'test' },
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(handle.poll(), JSON.stringify(handle.poll())).toMatchObject({ status: 'running', progress: { phase: 'fatal-step' } })
    bot.emit('death')
    await vi.advanceTimersByTimeAsync(50)
    expect(handle.poll(), JSON.stringify(handle.poll())).toMatchObject({ status: 'failed', error: { code: 'DIED_IN_ALLOWED_HAZARD' } })
    bot.emit('end', 'fixture complete')
  })
})

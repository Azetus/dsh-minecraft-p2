import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import type { Bot } from 'mineflayer'
import { SwimMove } from '../src/motion/execute/index.ts'
import { MotionContextSource } from '../src/motion/mineflayer/context.ts'
import { MotionRun } from '../src/motion/mineflayer/run.ts'
import { createRules, defaultConstraints, initialMoveState, resolveConstraints } from '../src/motion/model/index.ts'
import { FixtureWorld, FULL_CUBE, rawBlock } from './helpers/motion-world.ts'
import { cellKey } from '../src/motion/model/block.ts'
import { COST_INF } from '../src/motion/model/types.ts'
import type { Cell } from '../src/motion/model/types.ts'

/**
 * A one-wide corridor along x: dry bank at x=0 and x=3, a two-deep river at
 * x=1..2. The body starts on the near bank.
 */
function riverBot(): Bot {
  const block = (name: string, shapes: number[][]): unknown => ({
    type: name === 'stone' ? 1 : 0,
    name,
    shapes,
    ...(name === 'stone' ? { hardness: 1.5, diggable: true } : {}),
    getProperties: () => ({}),
  })
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(),
    registry: { blocks: {} },
    entity: { position: { x: 0.5, y: 64, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true },
    health: 20,
    time: { age: 1 },
    entities: {},
    getControlState: () => false,
    setControlState: () => {},
    clearControlStates: () => {},
    look: async () => {},
    blockAt: (p: { x: number; y: number; z: number }) => {
      if (p.z !== 0 || p.x < -1 || p.x > 4 || p.y < 60 || p.y > 66) return null
      if (p.y === 63) return block('stone', [[0, 0, 0, 1, 1, 1]])
      if (p.y === 64 || p.y === 65) {
        return p.x >= 1 && p.x <= 2 ? block('water', []) : block('air', [])
      }
      return block('air', [])
    },
  })
  return bot as unknown as Bot
}

function put(world: FixtureWorld, cell: Cell, name: string, collision = FULL_CUBE): void {
  world.blocks.set(cellKey(cell), rawBlock(name, name === 'water' || name === 'air' ? [] : collision))
}

describe('swim stance', () => {
  it('accepts the surface of deep water only under the swim profile', () => {
    const world = new FixtureWorld()
    put(world, { x: 0, y: 63, z: 0 }, 'stone')
    put(world, { x: 0, y: 64, z: 0 }, 'water')
    put(world, { x: 0, y: 65, z: 0 }, 'water')
    put(world, { x: 0, y: 66, z: 0 }, 'air')
    const wade = createRules(world, resolveConstraints(defaultConstraints(), { waterProfile: 'wade' }))
    const swim = createRules(world, resolveConstraints(defaultConstraints(), { waterProfile: 'swim' }))
    const surface = { x: 0, y: 65, z: 0 }
    // Surface cell: head is air, so the feet may float there.
    expect(wade.standInfo(surface).state).toBe('no')
    expect(swim.standInfo(surface).state).toBe('yes')
    // The submerged cell is never a node.
    expect(swim.standInfo({ x: 0, y: 64, z: 0 }).state).toBe('no')
    // A water cell under a solid ceiling is not a surface. A RuleSet is a
    // snapshot, so the mutation needs a fresh instance.
    put(world, { x: 0, y: 66, z: 0 }, 'stone')
    const covered = createRules(world, resolveConstraints(defaultConstraints(), { waterProfile: 'swim' }))
    expect(covered.standInfo(surface).state).toBe('no')
  })

  it('plans across the river with the default swim profile', () => {
    const run = new MotionRun(riverBot(), { x: 3, y: 64, z: 0 }, 1, 30_000)
    run.start()
    const report = run.report() as { swim?: boolean; waterProfile?: string; pathStatus?: string }
    expect(report.waterProfile).toBe('swim')
    expect(report.swim).toBe(true)
    run.stop()
  })

  it('keeps the dry route dry (water is not preferred over land)', () => {
    const bot = Object.assign(new EventEmitter(), {
      _client: new EventEmitter(),
      registry: { blocks: {} },
      entity: { position: { x: 0.5, y: 64, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true },
      health: 20,
      time: { age: 1 },
      entities: {},
      getControlState: () => false,
      setControlState: () => {},
      clearControlStates: () => {},
      look: async () => {},
      blockAt: (p: { x: number; y: number; z: number }) => {
        if (p.z !== 0 || p.x < -1 || p.x > 4 || p.y < 60 || p.y > 66) return null
        if (p.y === 63) return { type: 1, name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]], hardness: 1.5, diggable: true, getProperties: () => ({}) }
        return { type: 0, name: 'air', shapes: [], getProperties: () => ({}) }
      },
    }) as unknown as Bot
    const run = new MotionRun(bot, { x: 3, y: 64, z: 0 }, 1, 30_000)
    run.start()
    for (let tick = 0; tick < 40; tick += 1) run.tick(Date.now())
    const report = run.report() as { swim?: boolean; path?: unknown[] }
    // The default profile allows water, but a dry corridor must not use it.
    expect(report.swim).toBe(true)
    expect(Array.isArray(report.path) ? report.path.length : 0).toBeGreaterThan(0)
    run.stop()
  })
})

describe('swim move', () => {
  function waterWorld(): FixtureWorld {
    const world = new FixtureWorld()
    // Water surface at y=64 with a dry head cell above, and a bank at x=1.
    for (const x of [-1, 0]) {
      world.blocks.set(cellKey({ x, y: 63, z: 0 }), rawBlock('water', []))
      world.blocks.set(cellKey({ x, y: 64, z: 0 }), rawBlock('water', []))
      world.blocks.set(cellKey({ x, y: 65, z: 0 }), rawBlock('air', []))
    }
    world.blocks.set(cellKey({ x: 1, y: 63, z: 0 }), rawBlock('stone', FULL_CUBE))
    world.blocks.set(cellKey({ x: 1, y: 64, z: 0 }), rawBlock('air', []))
    world.blocks.set(cellKey({ x: 1, y: 65, z: 0 }), rawBlock('air', []))
    world.selfView = { ...world.selfView, pos: { x: 0.5, y: 64.4, z: 0.5 } }
    return world
  }

  function context(world: FixtureWorld, waterProfile: 'wade' | 'swim') {
    const source = new MotionContextSource(world, resolveConstraints(defaultConstraints(), { waterProfile }))
    return source.next()
  }

  it('only exists under the swim profile', () => {
    const world = waterWorld()
    const move = new SwimMove({ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 })
    expect(move.cost(context(world, 'wade'))).toBe(COST_INF)
    expect(move.cost(context(world, 'swim'))).toBe(2.5)
  })

  it('holds forward for the whole edge and jumps when leaving the water', () => {
    const world = waterWorld()
    const move = new SwimMove({ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 })
    const state = initialMoveState(0)
    expect(move.update(state, context(world, 'swim'))).toBe('running')
    expect(world.inputs.get('forward')).toBe(true)
    expect(world.inputs.get('jump')).toBe(true)
  })

  it('does not jump between two water cells while the eye is dry', () => {
    const world = waterWorld()
    world.selfView = { ...world.selfView, pos: { x: -0.6, y: 64.4, z: 0.5 } }
    const move = new SwimMove({ x: -1, y: 64, z: 0 }, { x: 0, y: 64, z: 0 })
    const state = initialMoveState(0)
    expect(move.update(state, context(world, 'swim'))).toBe('running')
    expect(world.inputs.get('forward')).toBe(true)
    expect(world.inputs.get('jump')).toBe(false)
  })

  it('succeeds once the body reaches the bank and releases the inputs', () => {
    const world = waterWorld()
    const move = new SwimMove({ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 })
    const state = initialMoveState(0)
    world.selfView = { ...world.selfView, pos: { x: 1.5, y: 64, z: 0.5 } }
    expect(move.update(state, context(world, 'swim'))).toBe('success')
    expect(world.inputs.get('forward')).toBe(false)
  })
})

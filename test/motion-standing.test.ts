import { EventEmitter } from 'node:events'

import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'

import { standingCell } from '../src/motion/execute/index.ts'
import { MotionRun } from '../src/provider/motion/run.ts'
import { createRules } from '../src/motion/model/rules.ts'
import { defaultConstraints } from '../src/motion/model/types.ts'
import { FULL_CUBE, HALF_CUBE, FixtureWorld, rawBlock } from './helpers/motion-world.ts'

/**
 * Category: cross-module contract (PLAN §6.3 M2).
 * Protects: one standing identity for search start, arrival and executor
 * recovery. Failure modes: a slab/farmland body maps to the block it stands on
 * instead of the feet cell, the feet height flips between two cells at the
 * half-block boundary, and an off-centre body over a step has no node.
 */

function rulesWith(world: FixtureWorld) {
  return createRules(world, defaultConstraints())
}

function clear(world: FixtureWorld, x: number, z: number, feet = 64): void {
  world.blocks.set(`${x},${feet - 1},${z}`, rawBlock('stone', FULL_CUBE))
  world.blocks.set(`${x},${feet},${z}`, rawBlock('air', []))
  world.blocks.set(`${x},${feet + 1},${z}`, rawBlock('air', []))
}

describe('motion standing identity', () => {
  it('maps full ground feet to the feet cell', () => {
    const world = new FixtureWorld()
    clear(world, 0, 0)
    expect(standingCell(rulesWith(world), { x: 0.5, y: 64, z: 0.5 })).toEqual({ x: 0, y: 64, z: 0 })
  })

  it('maps a bottom-slab feet height to the cell above the slab, not the slab itself', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('oak_slab', HALF_CUBE, { type: 'bottom' }))
    world.blocks.set('0,64,0', rawBlock('air', []))
    world.blocks.set('0,65,0', rawBlock('air', []))
    // Physics can report a feet height slightly below the slab top; the node is
    // still the cell above the slab.
    expect(standingCell(rulesWith(world), { x: 0.5, y: 63.499, z: 0.5 })).toEqual({ x: 0, y: 64, z: 0 })
  })

  it('maps farmland feet to the cell above it without using the block cell', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('farmland', [[0, 0, 0, 1, 0.9375, 1] as const]))
    world.blocks.set('0,64,0', rawBlock('air', []))
    world.blocks.set('0,65,0', rawBlock('air', []))
    expect(standingCell(rulesWith(world), { x: 0.5, y: 63.9375, z: 0.5 })).toEqual({ x: 0, y: 64, z: 0 })
  })

  it('falls back to an AABB corner column when the centre column has no stand', () => {
    const world = new FixtureWorld()
    clear(world, 1, 0)
    world.blocks.set('0,63,0', rawBlock('air', []))
    world.blocks.set('0,64,0', rawBlock('air', []))
    world.blocks.set('0,65,0', rawBlock('air', []))
    expect(standingCell(rulesWith(world), { x: 0.85, y: 64, z: 0.5 })).toEqual({ x: 1, y: 64, z: 0 })
  })

  it('keeps the water-surface node', () => {
    const world = new FixtureWorld()
    for (let y = 62; y <= 64; y += 1) world.blocks.set(`0,${y},0`, rawBlock('water', []))
    world.blocks.set('0,65,0', rawBlock('air', []))
    expect(standingCell(rulesWith(world), { x: 0.5, y: 62.2, z: 0.5 })).toEqual({ x: 0, y: 64, z: 0 })
  })
})

function slabBot(): Bot {
  const blocks = new Map<string, { name: string; shapes: number[][]; position: { x: number; y: number; z: number } }>()
  const set = (x: number, y: number, z: number, name: string, shapes: number[][]): void => {
    blocks.set(`${x},${y},${z}`, { name, shapes, position: { x, y, z } })
  }
  set(0, 63, 0, 'oak_slab', [[0, 0, 0, 1, 0.5, 1]])
  set(0, 64, 0, 'air', [])
  set(0, 65, 0, 'air', [])
  for (let z = 1; z <= 2; z += 1) {
    set(0, 63, z, 'stone', [[0, 0, 0, 1, 1, 1]])
    set(0, 64, z, 'air', [])
    set(0, 65, z, 'air', [])
  }
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(),
    registry: { blocks: {} },
    entity: { position: { x: 0.5, y: 63.499, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true },
    health: 20,
    time: { age: 1 },
    entities: {},
    getControlState: () => false,
    clearControlStates: () => {},
    look: async () => {},
    dig: async () => {},
    placeBlock: async () => {},
    activateBlock: async () => {},
    blockAt: (p: { x: number; y: number; z: number }) => blocks.get(`${p.x},${p.y},${p.z}`) ?? null,
  })
  return bot as unknown as Bot
}

describe('MotionRun standing identity', () => {
  it('reports the feet cell above a slab instead of the slab cell', () => {
    const run = new MotionRun(slabBot(), { x: 0, y: 64, z: 2 }, 1, 30_000)
    expect((run.report() as { from: { y: number } }).from.y).toBe(64)
  })

  it('accepts a slab start as already at an exact target cell', () => {
    const run = new MotionRun(slabBot(), { x: 0, y: 64, z: 0 }, 1, 30_000, { arrival: { kind: 'exact' } })
    run.start()
    const result = run.tick(Date.now())
    expect(result).toMatchObject({
      state: 'succeeded',
      observed: {
        arrival: {
          kind: 'exact',
          to: { x: 0, y: 64, z: 0 },
          cell: { x: 0, y: 64, z: 0 },
          feetY: 63.5,
          movedDistance: 0,
        },
      },
    })
  })
})

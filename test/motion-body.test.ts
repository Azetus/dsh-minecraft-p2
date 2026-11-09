import { EventEmitter } from 'node:events'

import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'

import { MotionRun } from '../src/provider/motion/run.ts'
import { createRules } from '../src/motion/model/rules.ts'
import { defaultConstraints } from '../src/motion/model/types.ts'
import { FULL_CUBE, HALF_CUBE, FixtureWorld, rawBlock } from './helpers/motion-world.ts'

/**
 * Category: cross-module contract (PLAN §6.3 M1).
 * Protects: the body truth is the real 0.6x1.8 AABB, so a half-embedded body or
 * a 1-high nook is reported as BODY_OVERLAP with the cells to clear instead of
 * being re-planned forever. Failure modes: overlap invisible at a cell
 * boundary, support counted as a wall, unknown collision claimed as overlap.
 */

function rulesWith(world: FixtureWorld) {
  return createRules(world, defaultConstraints())
}

function clearColumn(world: FixtureWorld, x: number, z: number, feetY = 64): void {
  world.blocks.set(`${x},${feetY - 1},${z}`, rawBlock('stone', FULL_CUBE))
  world.blocks.set(`${x},${feetY},${z}`, rawBlock('air', []))
  world.blocks.set(`${x},${feetY + 1},${z}`, rawBlock('air', []))
}

describe('motion body: real-position AABB overlap', () => {
  it('reports no overlap for a two-high clear column', () => {
    const world = new FixtureWorld()
    clearColumn(world, 0, 0)
    const overlap = rulesWith(world).bodyOverlapAt({ x: 0.5, y: 64, z: 0.5 })
    expect(overlap).toEqual({ blocks: [], unknown: [] })
  })

  it('reports the head block of a one-high nook by name', () => {
    const world = new FixtureWorld()
    clearColumn(world, 0, 0)
    world.blocks.set('0,65,0', rawBlock('stone', FULL_CUBE))
    const overlap = rulesWith(world).bodyOverlapAt({ x: 0.5, y: 64, z: 0.5 })
    expect(overlap.blocks).toEqual([{ x: 0, y: 65, z: 0, name: 'stone' }])
  })

  it('sees a wall in the adjacent column only when the real body crosses the boundary', () => {
    const world = new FixtureWorld()
    clearColumn(world, 0, 0)
    // The neighbouring column is a wall; the body only reaches it off-centre.
    world.blocks.set('1,63,0', rawBlock('stone', FULL_CUBE))
    world.blocks.set('1,64,0', rawBlock('stone', FULL_CUBE))
    world.blocks.set('1,65,0', rawBlock('air', []))

    const centred = rulesWith(world).bodyOverlapAt({ x: 0.5, y: 64, z: 0.5 })
    expect(centred.blocks).toEqual([])

    const offCentre = rulesWith(world).bodyOverlapAt({ x: 0.85, y: 64, z: 0.5 })
    expect(offCentre.blocks).toEqual([{ x: 1, y: 64, z: 0, name: 'stone' }])
  })

  it("does not treat a bottom slab's top as a wall at the derived feet height", () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('oak_slab', HALF_CUBE, { type: 'bottom' }))
    world.blocks.set('0,64,0', rawBlock('air', []))
    world.blocks.set('0,65,0', rawBlock('air', []))
    const overlap = rulesWith(world).bodyOverlapAt({ x: 0.5, y: 63.5, z: 0.5 })
    expect(overlap).toEqual({ blocks: [], unknown: [] })
  })

  it('keeps unloaded cells unknown, never as an overlap', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('stone', FULL_CUBE))
    const overlap = rulesWith(world).bodyOverlapAt({ x: 0.5, y: 64, z: 0.5 })
    expect(overlap.blocks).toEqual([])
    expect(overlap.unknown.length).toBeGreaterThan(0)
  })
})

type FakeBlock = { name: string; shapes: number[][]; position: { x: number; y: number; z: number } }

function embeddedBot(position: { x: number; y: number; z: number }, head: boolean): Bot {
  const blocks = new Map<string, FakeBlock>()
  const set = (x: number, y: number, z: number, name: string, shapes: number[][]): void => {
    blocks.set(`${x},${y},${z}`, { name, shapes, position: { x, y, z } })
  }
  const feetY = Math.floor(position.y)
  const feetX = Math.floor(position.x)
  const feetZ = Math.floor(position.z)
  for (let z = 0; z <= 4; z += 1) {
    for (let x = 0; x <= 1; x += 1) {
      set(x, feetY - 1, z, 'stone', [[0, 0, 0, 1, 1, 1]])
      set(x, feetY, z, 'air', [])
      set(x, feetY + 1, z, 'air', [])
    }
  }
  if (head) set(feetX, feetY + 1, feetZ, 'stone', [[0, 0, 0, 1, 1, 1]])

  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(),
    registry: { blocks: {} },
    entity: { position, velocity: { x: 0, y: 0, z: 0 }, onGround: true },
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

describe('MotionRun: BODY_OVERLAP fail-fast', () => {
  it('fails before planning and names the head cell to clear', () => {
    const run = new MotionRun(embeddedBot({ x: 0.5, y: 64, z: 0.5 }, true), { x: 0, y: 64, z: 3 }, 1, 30_000)
    run.start()
    const result = run.tick(Date.now())
    expect(result).toMatchObject({ state: 'failed', code: 'BODY_OVERLAP' })
    expect(result.observed).toMatchObject({
      detail: 'start-embedded',
      executor: {
        blockedBy: [{ x: 0, y: 65, z: 0, name: 'stone' }],
      },
    })
  })

  it('fails when an off-centre body overlaps the neighbouring column', () => {
    const position = { x: 0.85, y: 64, z: 0.5 }
    const bot = embeddedBot(position, false)
    const wall = {
      name: 'stone',
      shapes: [[0, 0, 0, 1, 1, 1]],
      position: { x: 1, y: 64, z: 0 },
    }
    // The fixture helper only fills the origin column; add the wall column.
    ;(bot as unknown as { blockAt: (p: { x: number; y: number; z: number }) => FakeBlock | null }).blockAt
      = (p: { x: number; y: number; z: number }) => (p.x === 1 && p.y === 64 && p.z === 0
        ? wall
        : p.y === 63 ? { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]], position: p }
          : { name: 'air', shapes: [], position: p })

    const run = new MotionRun(bot, { x: 0, y: 64, z: 3 }, 1, 30_000)
    run.start()
    const result = run.tick(Date.now())
    expect(result).toMatchObject({ state: 'failed', code: 'BODY_OVERLAP' })
    expect(result.observed).toMatchObject({
      executor: {
        blockedBy: [{ x: 1, y: 64, z: 0, name: 'stone' }],
      },
    })
  })

  it('keeps planning when the body is clear', () => {
    const run = new MotionRun(embeddedBot({ x: 0.5, y: 64, z: 0.5 }, false), { x: 0, y: 64, z: 3 }, 1, 30_000)
    run.start()
    const result = run.tick(Date.now())
    expect(result.state).toBe('running')
    run.stop()
  })

  it('waits for a landing before failing an exact goal with an empty path', () => {
    const bot = embeddedBot({ x: 0.5, y: 64, z: 0.5 }, false)
    ;(bot.entity as unknown as { onGround: boolean }).onGround = false
    const run = new MotionRun(bot, { x: 0, y: 64, z: 0 }, 0, 30_000, { arrival: { kind: 'exact' } })
    run.start()
    expect(run.tick(Date.now()).state).toBe('running')

    ;(bot.entity as unknown as { onGround: boolean }).onGround = true
    let result = run.tick(Date.now())
    for (let index = 0; index < 5 && result.state === 'running'; index += 1) {
      result = run.tick(Date.now() + index * 50)
    }
    expect(result.state).toBe('succeeded')
  })
})

describe('MotionRun: exact goal standability', () => {
  it('fails GOAL_NOT_STANDABLE instead of settling one cell below the goal', () => {
    const bot = embeddedBot({ x: 0.5, y: 64, z: 0.5 }, false)
    // Only the start column has a floor; the exact target column is air all the
    // way down, so the goal cannot be stood on.
    ;(bot as unknown as { blockAt: (p: { x: number; y: number; z: number }) => unknown }).blockAt =
      (p: { x: number; y: number; z: number }) => (p.x === 0 && p.z === 0 && p.y === 63
        ? { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]], position: p }
        : { name: 'air', shapes: [], position: p })

    const run = new MotionRun(bot, { x: 0, y: 64, z: 3 }, 1, 30_000, { arrival: { kind: 'exact' } })
    run.start()
    const result = run.tick(Date.now())

    expect(result).toMatchObject({ state: 'failed', code: 'GOAL_NOT_STANDABLE' })
    expect(result.observed).toMatchObject({
      detail: 'goal-not-standable',
      executor: { target: { x: 0, y: 64, z: 3 }, reason: 'no-support' },
    })
  })
})

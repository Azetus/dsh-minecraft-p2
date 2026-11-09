import { EventEmitter } from 'node:events'

import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'

import { MotionRun } from '../src/provider/motion/run.ts'
import { MotionContextSource } from '../src/provider/motion/context.ts'
import { MotionSearch } from '../src/motion/search/index.ts'
import { defaultConstraints, resolveConstraints } from '../src/motion/model/index.ts'
import { FULL_CUBE, FixtureWorld, rawBlock } from './helpers/motion-world.ts'

/**
 * Category: state safety (PLAN §6 Phase 3 T1, narrow pit / jump ceiling).
 * Protects: a body in a one-wide two-high pit reports NO_PATH instead of looping
 * GOTO_STUCK, and a step whose head cell is solid is rejected at planning time
 * instead of failing later with `jump-did-not-land`.
 */

type FakeBlock = { name: string; shapes: number[][]; position: { x: number; y: number; z: number } }

function botAt(position: { x: number; y: number; z: number }, blocks: Map<string, FakeBlock>): Bot {
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

function set(blocks: Map<string, FakeBlock>, x: number, y: number, z: number, name: string): void {
  blocks.set(`${x},${y},${z}`, {
    name,
    shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]],
    position: { x, y, z },
  })
}

function tickUntilDone(run: MotionRun, limit = 200): { state: string; code?: string } {
  let result = run.tick(Date.now())
  for (let index = 0; index < limit && result.state === 'running'; index += 1) {
    result = run.tick(Date.now() + index)
  }
  return result as { state: string; code?: string }
}

describe('narrow pit and jump-ceiling matrices', () => {
  it('reports NO_PATH from a one-wide two-high shaft instead of looping GOTO_STUCK', () => {
    const blocks = new Map<string, FakeBlock>()
    // Floor at 63; a 1x1 shaft with air at 64/65 and walls all around.
    set(blocks, 0, 63, 0, 'stone')
    set(blocks, 0, 64, 0, 'air')
    set(blocks, 0, 65, 0, 'air')
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      set(blocks, dx, 63, dz, 'stone')
      for (let y = 64; y <= 66; y += 1) set(blocks, dx, y, dz, 'stone')
    }
    set(blocks, 0, 66, 0, 'air')
    const run = new MotionRun(botAt({ x: 0.5, y: 64, z: 0.5 }, blocks), { x: 0, y: 64, z: 3 }, 1, 10_000)
    run.start()
    const result = tickUntilDone(run)
    expect(result.state).toBe('failed')
    expect(result.code).toBe('GOTO_NO_PATH')
    run.stop()
  })

  it('plans a scaffold out of 2/3/5-deep pits when placement is authorized', () => {
    for (const depth of [2, 3, 5]) {
      const world = new FixtureWorld()
      const stone = (x: number, y: number, z: number): void => {
        world.blocks.set(`${x},${y},${z}`, rawBlock('stone', FULL_CUBE))
      }
      const air = (x: number, y: number, z: number): void => {
        world.blocks.set(`${x},${y},${z}`, rawBlock('air', []))
      }
      stone(0, 63, 0)
      for (let y = 64; y <= 64 + depth + 1; y += 1) air(0, y, 0)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        stone(dx, 63, dz)
        for (let y = 64; y <= 63 + depth; y += 1) stone(dx, y, dz)
      }
      world.selfView = { ...world.selfView, pos: { x: 0.5, y: 64, z: 0.5 } }
      const source = new MotionContextSource(world, resolveConstraints(defaultConstraints(), {
        allowPlace: true,
        material: 'dirt',
      }))
      const search = new MotionSearch(
        { x: 0, y: 64, z: 0 },
        { x: 0, y: 64 + depth, z: 0 },
        () => source.next(),
        { sliceMs: 50, timeoutMs: 3_000, maxNodes: 20_000 },
      )
      let result = search.step(Date.now())
      let guard = 0
      while (result.status === 'running' && guard < 500) {
        result = search.step(Date.now())
        guard += 1
      }
      expect(result.status, `depth ${depth}`).toBe('success')
      const pillars = result.moves.filter(move => move.kind === 'pillar')
      expect(pillars.length, `depth ${depth}`).toBeGreaterThan(0)
      expect(pillars.flatMap(move => move.toPlace()).length, `depth ${depth}`).toBeGreaterThanOrEqual(depth)
    }
  })

  it('enters a top-open 1x1x2 pit from the surface, but not a covered one', () => {
    const plan = (covered: boolean) => {
      const world = new FixtureWorld()
      const stone = (x: number, y: number, z: number): void => {
        world.blocks.set(`${x},${y},${z}`, rawBlock('stone', FULL_CUBE))
      }
      const air = (x: number, y: number, z: number): void => {
        world.blocks.set(`${x},${y},${z}`, rawBlock('air', []))
      }
      stone(0, 63, 0)
      for (let y = 64; y <= 65; y += 1) air(0, y, 0)
      stone(1, 62, 0)
      for (let y = 63; y <= 66; y += 1) air(1, y, 0)
      for (const [x, z] of [[1, 1], [1, -1], [2, 0]] as const) {
        for (let y = 62; y <= 64; y += 1) stone(x, y, z)
      }
      if (covered) stone(1, 65, 0)
      world.selfView = { ...world.selfView, pos: { x: 0.5, y: 64, z: 0.5 } }
      const source = new MotionContextSource(world)
      const search = new MotionSearch({ x: 0, y: 64, z: 0 }, { x: 1, y: 63, z: 0 }, () => source.next(), {
        sliceMs: 50,
        timeoutMs: 2_000,
        maxNodes: 4_000,
      })
      let result = search.step(Date.now())
      let guard = 0
      while (result.status === 'running' && guard < 200) {
        result = search.step(Date.now())
        guard += 1
      }
      return result
    }

    const open = plan(false)
    expect(open.status).toBe('success')
    expect(open.moves.some(move => move.kind === 'descend')).toBe(true)

    const covered = plan(true)
    expect(covered.status).toBe('noPath')
  })

  it('skips the exact standability precheck only for scaffold placement', () => {
    const blocks = new Map<string, FakeBlock>()
    set(blocks, 0, 63, 0, 'stone')
    set(blocks, 0, 64, 0, 'air')
    set(blocks, 0, 65, 0, 'air')
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      set(blocks, dx, 63, dz, 'stone')
      set(blocks, dx, 64, dz, 'stone')
    }
    const bot = botAt({ x: 0.5, y: 64, z: 0.5 }, blocks)
    const strict = new MotionRun(bot, { x: 0, y: 66, z: 0 }, 0, 10_000, {
      arrival: { kind: 'exact' },
      constraints: { ...defaultConstraints(), allowPlace: true, material: 'dirt' },
    })
    strict.start()
    expect(strict.tick(Date.now())).toMatchObject({ state: 'failed', code: 'GOAL_NOT_STANDABLE' })

    const scaffold = new MotionRun(bot, { x: 0, y: 66, z: 0 }, 0, 10_000, {
      arrival: { kind: 'exact' },
      allowUnsupportedGoal: true,
      constraints: { ...defaultConstraints(), allowPlace: true, material: 'dirt' },
    })
    scaffold.start()
    const result = scaffold.tick(Date.now())
    expect(result.code).not.toBe('GOAL_NOT_STANDABLE')
    scaffold.stop()
  })

  it('rejects a step whose third cell above the takeoff is solid', () => {
    const world = new FixtureWorld()
    const air = (x: number, y: number, z: number): void => { world.blocks.set(`${x},${y},${z}`, rawBlock('air', [])) }
    const stone = (x: number, y: number, z: number): void => { world.blocks.set(`${x},${y},${z}`, rawBlock('stone', FULL_CUBE)) }
    // A one-wide approach: walls on both sides, a wall behind the step, a step
    // at z=2, and a solid third cell above the only takeoff cell (z=1).
    for (let x = -1; x <= 1; x += 1) {
      for (let z = 0; z <= 4; z += 1) {
        stone(x, 63, z)
        for (let y = 64; y <= 67; y += 1) air(x, y, z)
      }
    }
    for (let z = 0; z <= 4; z += 1) {
      for (let y = 64; y <= 67; y += 1) {
        stone(-1, y, z)
        stone(1, y, z)
      }
    }
    for (let y = 64; y <= 67; y += 1) stone(0, y, 3)
    stone(0, 64, 2)
    stone(0, 66, 1)
    world.selfView = { ...world.selfView, pos: { x: 0.5, y: 64, z: 0.5 } }
    const source = new MotionContextSource(world)
    const search = new MotionSearch({ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 2 }, () => source.next(), {
      sliceMs: 50,
      maxNodes: 2_000,
    })
    let result = search.step(Date.now())
    let guard = 0
    while (result.status === 'running' && guard < 200) {
      result = search.step(Date.now())
      guard += 1
    }
    expect(result.status).toBe('noPath')
  })
})

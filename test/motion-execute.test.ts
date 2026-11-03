/**
 * Non-acceptance / 非验收: move state machines, build filtering and executor
 * recovery. These use controlled input and a scripted feet position; they do
 * not simulate Minecraft physics. Live acceptance runs on the real server.
 */
import { describe, expect, it } from 'vitest'

import {
  buildMoves,
  PathExecutor,
  PillarMove,
  TraverseMove,
  AscendMove,
  DescendMove,
  FallMove,
  JUMP_MARGIN,
  JUMP_PEAK,
  ParkourMove,
  reached,
} from '../src/motion/execute/index.ts'
import { MotionContextSource } from '../src/motion/mineflayer/context.ts'
import { defaultConstraints, resolveConstraints, type Cell, type MotionConstraints } from '../src/motion/model/index.ts'
import { matrixFields } from '../src/motion/matrix/index.ts'
import { buildFixture, FixtureWorld, FULL_CUBE, rawBlock } from './helpers/motion-world.ts'

function contextFor(world: FixtureWorld, patch: Partial<MotionConstraints> = {}) {
  return new MotionContextSource(world, resolveConstraints(defaultConstraints(), patch))
}

function movePos(world: FixtureWorld, cell: Cell): void {
  world.selfView = { ...world.selfView, pos: { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 } }
}

function flatWorld(): FixtureWorld {
  const world = new FixtureWorld()
  for (let z = -1; z <= 4; z += 1) {
    for (let x = -1; x <= 1; x += 1) {
      world.blocks.set(`${x},63,${z}`, rawBlock('stone', FULL_CUBE))
      for (let y = 64; y <= 66; y += 1) world.blocks.set(`${x},${y},${z}`, rawBlock('air', []))
    }
  }
  movePos(world, { x: 0, y: 64, z: 0 })
  return world
}

describe('buildMoves: only implemented edges become a path', () => {
  it('accepts cardinal traverse, ascend and fall edges', () => {
    const world = flatWorld()
    world.blocks.set('0,64,3', rawBlock('stone', FULL_CUBE))
    world.blocks.set('0,65,3', rawBlock('air', []))
    const source = contextFor(world)
    const ctx = source.next()
    const traverse = buildMoves([{ x: 0, y: 64, z: 1 }], { x: 0, y: 64, z: 0 }, ctx)
    expect(traverse.ok).toBe(true)
    if (traverse.ok) expect(traverse.moves[0]?.kind).toBe('traverse')

    const ascend = buildMoves([{ x: 0, y: 65, z: 3 }], { x: 0, y: 64, z: 2 }, ctx)
    expect(ascend.ok).toBe(true)
    if (ascend.ok) expect(ascend.moves[0]?.kind).toBe('ascend')

    const fall = buildMoves([{ x: 0, y: 62, z: 2 }], { x: 0, y: 64, z: 2 }, ctx)
    expect(fall.ok).toBe(false)
    if (!fall.ok) expect(['UNSUPPORTED_EDGE', 'EDGE_INFEASIBLE']).toContain(fall.code)
  })

  it('rejects a parkour edge until the constraint allows it', () => {
    const gap = matrixFields({ x: 0, y: 100, z: 0 }).find(field => field.id === 'gap-1')
    expect(gap).toBeDefined()
    if (gap === undefined) return
    const world = buildFixture(gap)
    const source = contextFor(world)
    const start = { x: gap.origin.x, y: gap.origin.y + 1, z: gap.origin.z + 2 }
    const dest = { x: gap.origin.x, y: gap.origin.y + 1, z: gap.origin.z + 4 }
    const blocked = buildMoves([dest], start, source.next())
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.code).toBe('EDGE_INFEASIBLE')

    const allowed = contextFor(world, { allowParkour: true })
    const accepted = buildMoves([dest], start, allowed.next())
    expect(accepted.ok).toBe(true)
    if (accepted.ok) expect(accepted.moves[0]?.kind).toBe('parkour')
  })

  it('rejects a diagonal edge unless explicitly allowed', () => {
    const world = flatWorld()
    const source = contextFor(world)
    const dest = { x: 1, y: 64, z: 1 }
    const blocked = buildMoves([dest], { x: 0, y: 64, z: 0 }, source.next())
    expect(blocked.ok).toBe(false)
    const allowed = contextFor(world, { allowDiagonal: true })
    const accepted = buildMoves([dest], { x: 0, y: 64, z: 0 }, allowed.next())
    expect(accepted.ok).toBe(true)
    if (accepted.ok) expect(accepted.moves[0]?.kind).toBe('diagonal')
  })
})

describe('move state machines', () => {
  it('uses the vanilla 0.45 horizontal waypoint tolerance', () => {
    const world = flatWorld()
    const ctx = contextFor(world).next()
    expect(reached({ x: 0.9, y: 64, z: 0.5 }, { x: 0, y: 64, z: 0 }, ctx)).toBe(true)
    expect(reached({ x: 1.0, y: 64, z: 0.5 }, { x: 0, y: 64, z: 0 }, ctx)).toBe(false)
  })

  it('traverses by looking and holding forward, then releases on arrival', () => {
    const world = flatWorld()
    const source = contextFor(world)
    const move = new TraverseMove({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 1 })
    const ctx = source.next()
    expect(move.cost(ctx)).toBe(1)
    const state = { status: 'running' as const, ticks: 0, startedAt: 0, elapsedMs: 0 }
    expect(move.update(state, ctx)).toBe('running')
    expect(world.inputs.get('forward')).toBe(true)
    movePos(world, { x: 0, y: 64, z: 1 })
    expect(move.update(state, source.next())).toBe('success')
    expect(world.inputs.get('forward')).toBe(false)
  })

  it('opens a closed door before walking into its cell', () => {
    const world = flatWorld()
    world.blocks.set('0,64,1', rawBlock('oak_door', FULL_CUBE, { half: 'lower', open: 'false' }))
    world.blocks.set('0,65,1', rawBlock('oak_door', FULL_CUBE, { half: 'upper', open: 'false' }))
    const source = contextFor(world)
    const move = new TraverseMove({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 1 })
    const state = { status: 'running' as const, ticks: 0, startedAt: 0, elapsedMs: 0 }
    expect(move.cost(source.next())).toBe(1.2)
    move.update(state, source.next())
    expect(world.actions).toContain('use:0,64,1')
    expect(world.inputs.get('forward')).toBe(false)

    world.blocks.set('0,64,1', rawBlock('oak_door', [], { half: 'lower', open: 'true' }))
    world.blocks.set('0,65,1', rawBlock('oak_door', [], { half: 'upper', open: 'true' }))
    move.update(state, source.next())
    expect(world.inputs.get('forward')).toBe(true)
    movePos(world, { x: 0, y: 64, z: 1 })
    expect(move.update(state, source.next())).toBe('success')
  })

  it('approaches and jumps for a one-block step', () => {
    const world = flatWorld()
    world.blocks.set('0,64,2', rawBlock('stone', FULL_CUBE))
    world.blocks.set('0,65,2', rawBlock('air', []))
    const source = contextFor(world)
    const move = new AscendMove({ x: 0, y: 64, z: 1 }, { x: 0, y: 65, z: 2 })
    const state = { status: 'running' as const, ticks: 0, startedAt: 0, elapsedMs: 0 }
    expect(move.cost(source.next())).toBeLessThan(Number.POSITIVE_INFINITY)
    move.update(state, source.next())
    expect(world.inputs.get('forward')).toBe(true)
    expect(world.inputs.get('jump')).not.toBe(true)
    movePos(world, { x: 0, y: 64, z: 1.7 })
    move.update(state, source.next())
    move.update(state, source.next())
    expect(world.inputs.get('jump')).toBe(true)
    movePos(world, { x: 0, y: 65, z: 2 })
    expect(move.update(state, source.next())).toBe('success')
  })

  it('prices a two-block fall and rejects it when maxFall is lower', () => {
    const drop = matrixFields({ x: 0, y: 100, z: 0 }).find(field => field.id === 'drop-2')
    expect(drop).toBeDefined()
    if (drop === undefined) return
    const world = buildFixture(drop)
    const src = { x: drop.start.x, y: drop.start.y, z: drop.start.z + 2 }
    const dest = { x: drop.start.x, y: drop.start.y - 2, z: drop.start.z + 3 }
    const move = new FallMove(src, dest)
    expect(move.cost(contextFor(world).next())).toBeCloseTo(3.5)
    const shallow = contextFor(world, { maxFall: 1 })
    expect(move.cost(shallow.next())).toBe(Number.POSITIVE_INFINITY)
  })

  it('keeps a pillar edge feasible after its first block is placed', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,99,0', rawBlock('stone', FULL_CUBE))
    for (let y = 100; y <= 104; y += 1) world.blocks.set(`0,${y},0`, rawBlock('air', []))
    movePos(world, { x: 0, y: 100, z: 0 })
    const source = contextFor(world, { allowPlace: true, material: 'dirt' })
    const move = new PillarMove({ x: 0, y: 100, z: 0 }, { x: 0, y: 102, z: 0 })
    const state = { status: 'running' as const, ticks: 0, startedAt: 0, elapsedMs: 0 }
    expect(move.cost(source.next())).toBeLessThan(Number.POSITIVE_INFINITY)

    move.update(state, source.next()) // jump
    world.selfView = { ...world.selfView, pos: { x: 0.5, y: 101.02, z: 0.5 }, onGround: false }
    move.update(state, source.next()) // place at y=100
    expect(world.actions.some(action => action.startsWith('place:0,100,0'))).toBe(true)
    // The block update may lag one tick: cost must stay feasible while the
    // move's own readback is still in progress.
    expect(move.cost(source.next())).toBeLessThan(Number.POSITIVE_INFINITY)

    world.blocks.set('0,100,0', rawBlock('dirt', FULL_CUBE))
    world.selfView = { ...world.selfView, pos: { x: 0.5, y: 101.1, z: 0.5 }, onGround: false }
    move.update(state, source.next()) // readback -> land
    // The first block is placed while the body is still airborne: the edge must
    // remain feasible against the cell above the new support.
    expect(move.cost(source.next())).toBeLessThan(Number.POSITIVE_INFINITY)
    world.selfView = { ...world.selfView, pos: { x: 0.5, y: 101, z: 0.5 }, onGround: true }
    move.update(state, source.next()) // advance to level 1 and jump

    // The placed y=100 block must not make the move's own cost infeasible.
    expect(move.cost(source.next())).toBeLessThan(Number.POSITIVE_INFINITY)

    // Reproduce the second placement: y=100 and y=101 are now support, so the
    // original clearance set would contain two of the move's own solid blocks.
    world.selfView = { ...world.selfView, pos: { x: 0.5, y: 102.02, z: 0.5 }, onGround: false }
    move.update(state, source.next()) // place at y=101
    expect(world.actions.some(action => action.startsWith('place:0,101,0'))).toBe(true)
    expect(move.cost(source.next())).toBeLessThan(Number.POSITIVE_INFINITY)
  })
})

describe('PathExecutor', () => {
  function twoStep() {
    const world = flatWorld()
    const source = contextFor(world)
    const moves = [
      new TraverseMove({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 1 }),
      new TraverseMove({ x: 0, y: 64, z: 1 }, { x: 0, y: 64, z: 2 }),
    ]
    return { world, source, moves }
  }

  it('advances through the move list and reports success', () => {
    const { world, source, moves } = twoStep()
    const executor = new PathExecutor(moves, () => source.next())
    expect(executor.tick(0).state).toBe('running')
    movePos(world, { x: 0, y: 64, z: 1 })
    expect(executor.tick(100).state).toBe('running')
    movePos(world, { x: 0, y: 64, z: 2 })
    expect(executor.tick(200).state).toBe('succeeded')
    expect(world.inputs.get('forward') ?? false).toBe(false)
    expect(executor.report().index).toBe(2)
  })

  it('recovers forward when the body is already on a later valid cell', () => {
    const { world, source, moves } = twoStep()
    const executor = new PathExecutor(moves, () => source.next())
    executor.tick(0)
    movePos(world, { x: 0, y: 64, z: 2 })
    executor.tick(100)
    expect(executor.report().recoveries).toBe(1)
    expect(executor.tick(200).state).toBe('succeeded')
  })

  it('resyncs over the whole remaining path, not just four edges ahead', () => {
    const world = flatWorld()
    for (let z = 5; z <= 8; z += 1) {
      world.blocks.set(`0,63,${z}`, rawBlock('stone', FULL_CUBE))
      for (let y = 64; y <= 66; y += 1) world.blocks.set(`0,${y},${z}`, rawBlock('air', []))
    }
    const source = contextFor(world)
    const moves = Array.from({ length: 7 }, (_, index) => new TraverseMove(
      { x: 0, y: 64, z: index },
      { x: 0, y: 64, z: index + 1 },
    ))
    const executor = new PathExecutor(moves, () => source.next())
    executor.tick(0)
    // Pushed seven edges ahead: the old ±4 window would never resync.
    movePos(world, { x: 0, y: 64, z: 7 })
    executor.tick(100)
    expect(executor.report().recoveries).toBe(1)
    expect(executor.report().index).toBe(6)
    expect(executor.tick(200).state).toBe('succeeded')
  })

  it('exposes Baritone-style valid positions for ascend/descend/fall', () => {
    const ascend = new AscendMove({ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 1 })
    expect(ascend.validPositions()).toEqual(expect.arrayContaining([
      { x: 0, y: 65, z: 0 },
      { x: 0, y: 65, z: -1 },
      { x: 0, y: 66, z: -1 },
    ]))
    const descend = new DescendMove({ x: 0, y: 65, z: 1 }, { x: 0, y: 64, z: 2 })
    expect(descend.validPositions()).toEqual(expect.arrayContaining([{ x: 0, y: 65, z: 2 }]))
    const fall = new FallMove({ x: 0, y: 66, z: 0 }, { x: 0, y: 62, z: 1 })
    expect(fall.validPositions()).toEqual(expect.arrayContaining([
      { x: 0, y: 64, z: 1 },
      { x: 0, y: 63, z: 1 },
    ]))
  })

  it('aborts when the current edge stops being feasible', () => {
    const { world, source, moves } = twoStep()
    const executor = new PathExecutor(moves, () => source.next())
    executor.tick(0)
    world.blocks.set('0,63,1', rawBlock('air', []))
    world.blocks.set('0,64,1', rawBlock('air', []))
    const result = executor.tick(100)
    expect(result.state).toBe('failed')
    expect(result.code).toBe('UNREACHABLE')
  })

  it('breaks an explicitly authorized body cell before traversing', () => {
    const world = new class extends FixtureWorld {
      override dig(p: Cell): void {
        super.dig(p)
        this.blocks.set(`${p.x},${p.y},${p.z}`, rawBlock('air', []))
      }
    }()
    for (let z = 0; z <= 1; z += 1) {
      for (let y = 64; y <= 65; y += 1) world.blocks.set(`0,${y},${z}`, rawBlock('air', []))
    }
    world.blocks.set('0,63,0', rawBlock('stone', FULL_CUBE))
    world.blocks.set('0,63,1', rawBlock('stone', FULL_CUBE))
    world.blocks.set('0,64,1', { ...rawBlock('stone', FULL_CUBE), hardness: 2, diggable: true })
    movePos(world, { x: 0, y: 64, z: 0 })
    const source = contextFor(world, {
      allowBreak: true,
      breakTargets: [{ x: 0, y: 64, z: 1, name: 'stone' }],
      allowDoor: true,
    })
    const move = new TraverseMove({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 1 })
    expect(move.cost(source.next())).toBeLessThan(Number.POSITIVE_INFINITY)
    expect(move.toBreak(source.next())).toEqual([{ x: 0, y: 64, z: 1 }])

    const executor = new PathExecutor([move], () => source.next())
    expect(executor.tick(0).state).toBe('running')
    expect(world.actions).toContain('dig:0,64,1')
    expect(executor.tick(1).state).toBe('running')
    movePos(world, { x: 0, y: 64, z: 1 })
    expect(executor.tick(2).state).toBe('succeeded')
  })

  it('refuses to break a cell without an explicit target', () => {
    const world = flatWorld()
    world.blocks.set('0,64,1', { ...rawBlock('stone', FULL_CUBE), hardness: 2, diggable: true })
    const source = contextFor(world, { allowBreak: true })
    const move = new TraverseMove({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 1 })
    expect(move.cost(source.next())).toBe(Number.POSITIVE_INFINITY)
  })

  it('allows a health-budgeted fall only when the budget is supplied', () => {
    const world = new FixtureWorld()
    for (let y = 60; y <= 66; y += 1) world.blocks.set(`1,${y},0`, rawBlock('air', []))
    world.blocks.set('1,59,0', rawBlock('stone', FULL_CUBE))
    movePos(world, { x: 0, y: 64, z: 0 })
    const normal = new FallMove({ x: 0, y: 64, z: 0 }, { x: 1, y: 60, z: 0 })
    expect(normal.cost(contextFor(world).next())).toBe(Number.POSITIVE_INFINITY)
    const safe = contextFor(world, { safeFallBudget: 6 })
    expect(normal.cost(safe.next())).toBeLessThan(Number.POSITIVE_INFINITY)
  })

  it('releases every input on cancel', () => {
    const { world, source, moves } = twoStep()
    const executor = new PathExecutor(moves, () => source.next())
    executor.tick(0)
    executor.cancel()
    expect(executor.report().status).toBe('canceled')
    expect(world.inputs.size).toBe(0)
  })
})

/**
 * M3: every jump-like edge requires the cells the body enters near the apex,
 * not just its destination. The third cell above the takeoff is the one the
 * real failure hit; the set is shared by cost and toBreak.
 */
describe('move clearance: jump apex cells', () => {
  const parkour = (ctx: ReturnType<MotionContextSource['next']>, src: Cell, dest: Cell): number =>
    new ParkourMove(src, dest).cost(ctx)

  it('rejects a parkour takeoff with a solid third cell', () => {
    const world = flatWorld()
    world.blocks.set('0,66,0', rawBlock('stone', FULL_CUBE))
    const ctx = contextFor(world, { allowParkour: true }).next()
    expect(parkour(ctx, { x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 2 })).toBe(Number.POSITIVE_INFINITY)
  })

  it('rejects a parkour landing with a solid third cell', () => {
    const world = flatWorld()
    world.blocks.set('0,66,2', rawBlock('stone', FULL_CUBE))
    const ctx = contextFor(world, { allowParkour: true }).next()
    expect(parkour(ctx, { x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 2 })).toBe(Number.POSITIVE_INFINITY)
  })

  it('rejects a parkour arc whose middle column has a solid third cell', () => {
    const world = flatWorld()
    world.blocks.set('0,66,1', rawBlock('stone', FULL_CUBE))
    const ctx = contextFor(world, { allowParkour: true }).next()
    expect(parkour(ctx, { x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 2 })).toBe(Number.POSITIVE_INFINITY)
  })

  it('shares the same clearance set between cost and toBreak', () => {
    const world = flatWorld()
    world.blocks.set('0,66,0', { ...rawBlock('stone', FULL_CUBE), hardness: 1.5, diggable: true })
    const ctx = contextFor(world, {
      allowParkour: true,
      allowBreak: true,
      breakTargets: [{ x: 0, y: 66, z: 0, name: 'stone' }],
    }).next()
    const move = new ParkourMove({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 2 })
    expect(move.cost(ctx)).toBeLessThan(Number.POSITIVE_INFINITY)
    expect(move.toBreak(ctx)).toEqual([{ x: 0, y: 66, z: 0 }])
  })

  it('keeps a 3-high corridor jumpable for a +1 step', () => {
    const world = flatWorld()
    // The step itself, with src+3 solid: the apex body only clips it above the
    // required +1 rise, so the jump is still feasible.
    world.blocks.set('0,64,1', rawBlock('stone', FULL_CUBE))
    world.blocks.set('0,67,0', rawBlock('stone', FULL_CUBE))
    const ctx = contextFor(world).next()
    expect(new AscendMove({ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 1 }).cost(ctx))
      .toBeLessThan(Number.POSITIVE_INFINITY)
  })
})

/**
 * The two physical thresholds use real feet heights against the vanilla jump
 * peak, not "is the support a full block": farmland -> a 1.0625 rise is
 * possible, a bottom slab / chest is not. These are the rows the reference
 * behaviour distinguishes, and the pure fixture is where both sides are pinned.
 */
describe('partial-support physics thresholds', () => {
  const FARMLAND = [[0, 0, 0, 1, 0.9375, 1] as const]
  const SOUL_SAND = [[0, 0, 0, 1, 0.875, 1] as const]
  const CHEST = [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375] as const]
  const BOTTOM_SLAB = [[0, 0, 0, 1, 0.5, 1] as const]

  /** Feet cell (0,64,0) on `support`; the ascend target is (1,65,0). */
  function stepWorld(name: string, collision: readonly (readonly number[])[]): FixtureWorld {
    const world = flatWorld()
    world.blocks.set('0,63,0', rawBlock(name, collision as never))
    world.blocks.set('1,64,0', rawBlock('stone', FULL_CUBE))
    world.blocks.set('1,65,0', rawBlock('air', []))
    world.blocks.set('1,66,0', rawBlock('air', []))
    // Headroom for the two-level pillar (body cells up to y+1).
    world.blocks.set('0,66,0', rawBlock('air', []))
    world.blocks.set('0,67,0', rawBlock('air', []))
    world.blocks.set('0,68,0', rawBlock('air', []))
    movePos(world, { x: 0, y: 64, z: 0 })
    return world
  }

  function ascendCost(name: string, collision: readonly (readonly number[])[]): number {
    const source = contextFor(stepWorld(name, collision))
    return new AscendMove({ x: 0, y: 64, z: 0 }, { x: 1, y: 65, z: 0 }).cost(source.next())
  }

  function pillarCost(name: string, collision: readonly (readonly number[])[]): number {
    const world = stepWorld(name, collision)
    world.blocks.set('1,64,0', rawBlock('air', []))
    const source = contextFor(world, { allowPlace: true, material: 'dirt' })
    return new PillarMove({ x: 0, y: 64, z: 0 }, { x: 0, y: 66, z: 0 }).cost(source.next())
  }

  it('exposes the jump budget as peak minus margin', () => {
    expect(JUMP_PEAK - JUMP_MARGIN).toBeCloseTo(1.1022, 4)
  })

  it('allows a 1.0625 rise from farmland onto a full block', () => {
    expect(Number.isFinite(ascendCost('farmland', FARMLAND))).toBe(true)
  })

  it('still allows a plain 1.0 rise from a full block', () => {
    expect(Number.isFinite(ascendCost('stone', FULL_CUBE))).toBe(true)
  })

  it('refuses the 1.5 rise from a bottom slab', () => {
    expect(ascendCost('stone_slab', BOTTOM_SLAB)).toBe(Number.POSITIVE_INFINITY)
  })

  it('refuses the 1.125 rise from a chest (margin), not just the impossible band', () => {
    expect(ascendCost('chest', CHEST)).toBe(Number.POSITIVE_INFINITY)
  })

  it('allows pillar from farmland and refuses it from a bottom slab or soul sand', () => {
    expect(Number.isFinite(pillarCost('farmland', FARMLAND))).toBe(true)
    expect(pillarCost('stone_slab', BOTTOM_SLAB)).toBe(Number.POSITIVE_INFINITY)
    // 0.875 sits just under the 0.9078 threshold: the peak clears the cell top
    // by only 0.033, which tick quantisation makes unreliable.
    expect(pillarCost('soul_sand', SOUL_SAND)).toBe(Number.POSITIVE_INFINITY)
  })
})

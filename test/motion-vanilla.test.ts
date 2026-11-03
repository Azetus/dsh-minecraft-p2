import { describe, expect, it } from 'vitest'

import { cellKey } from '../src/motion/model/block.ts'
import type { Cell, CollisionBox, RawBlock } from '../src/motion/model/types.ts'
import { VanillaNodeReader } from '../src/motion/vanilla/classify.ts'
import {
  VANILLA_HORIZONTAL_TOLERANCE,
  VANILLA_STALL_MS,
  WaypointFollower,
} from '../src/motion/vanilla/follow.ts'
import { planVanillaPath, snapGoal, VANILLA_MAX_FALL } from '../src/motion/vanilla/search.ts'
import { riskyFields } from '../src/motion/matrix/risky.ts'
import { buildFixture, FixtureWorld, FULL_CUBE, LADDER_NORTH, SCAFFOLDING_SHAPE, rawBlock } from './helpers/motion-world.ts'

const FENCE: readonly CollisionBox[] = [[0, 0, 0, 1, 1.5, 1] as const]

function put(world: FixtureWorld, cell: Cell, block: RawBlock): void {
  world.blocks.set(cellKey(cell), block)
}

function air(world: FixtureWorld, from: Cell, to: Cell): void {
  for (let x = from.x; x <= to.x; x += 1) {
    for (let y = from.y; y <= to.y; y += 1) {
      for (let z = from.z; z <= to.z; z += 1) {
        put(world, { x, y, z }, rawBlock('air', []))
      }
    }
  }
}

function floor(world: FixtureWorld, from: Cell, to: Cell, name = 'stone'): void {
  for (let x = from.x; x <= to.x; x += 1) {
    for (let z = from.z; z <= to.z; z += 1) {
      put(world, { x, y: from.y, z }, rawBlock(name, FULL_CUBE))
    }
  }
}

function readerFor(world: FixtureWorld): VanillaNodeReader {
  return new VanillaNodeReader(world)
}

/** A one-wide corridor along x: air at y 64..65, floor at 63, unloaded elsewhere. */
function corridor(): FixtureWorld {
  const world = new FixtureWorld()
  air(world, { x: -1, y: 64, z: 0 }, { x: 4, y: 65, z: 0 })
  floor(world, { x: -1, y: 63, z: 0 }, { x: 4, y: 63, z: 0 })
  world.selfView = { ...world.selfView, pos: { x: 0.5, y: 64, z: 0.5 } }
  return world
}

describe('vanilla node reader', () => {
  it('classifies the five node kinds and rejects unloaded cells', () => {
    const world = corridor()
    put(world, { x: 1, y: 64, z: 0 }, rawBlock('oak_door', FULL_CUBE, { open: 'false' }))
    put(world, { x: 2, y: 64, z: 0 }, rawBlock('oak_door', FULL_CUBE, { open: 'true' }))
    put(world, { x: 3, y: 64, z: 0 }, rawBlock('iron_door', FULL_CUBE, { open: 'false' }))
    put(world, { x: 4, y: 64, z: 0 }, rawBlock('ladder', LADDER_NORTH))
    put(world, { x: -1, y: 64, z: 0 }, rawBlock('lava', []))
    const reader = readerFor(world)

    expect(reader.node({ x: 0, y: 64, z: 0 })?.kind).toBe('walkable')
    expect(reader.node({ x: 1, y: 64, z: 0 })?.kind).toBe('door')
    expect(reader.node({ x: 2, y: 64, z: 0 })?.kind).toBe('walkable')
    expect(reader.node({ x: 3, y: 64, z: 0 })).toBeUndefined()
    expect(reader.node({ x: 4, y: 64, z: 0 })?.kind).toBe('climbable')
    expect(reader.node({ x: -1, y: 64, z: 0 })).toBeUndefined()
    expect(reader.node({ x: 0, y: 64, z: 5 })).toBeUndefined()
  })

  it('treats only the water surface as a node (no diving)', () => {
    const world = new FixtureWorld()
    air(world, { x: 0, y: 65, z: 0 }, { x: 0, y: 65, z: 0 })
    put(world, { x: 0, y: 64, z: 0 }, rawBlock('water', []))
    put(world, { x: 0, y: 63, z: 0 }, rawBlock('stone', FULL_CUBE))
    expect(readerFor(world).node({ x: 0, y: 64, z: 0 })?.kind).toBe('water')
    air(world, { x: 1, y: 66, z: 0 }, { x: 1, y: 66, z: 0 })
    put(world, { x: 1, y: 65, z: 0 }, rawBlock('water', []))
    put(world, { x: 1, y: 64, z: 0 }, rawBlock('water', []))
    expect(readerFor(world).node({ x: 1, y: 65, z: 0 })?.kind).toBe('water')
    expect(readerFor(world).node({ x: 1, y: 64, z: 0 })).toBeUndefined()
  })

  it('rejects supports taller than one block (fences) and hazards', () => {
    const world = corridor()
    put(world, { x: 2, y: 63, z: 0 }, rawBlock('oak_fence', FENCE))
    put(world, { x: 2, y: 64, z: 0 }, rawBlock('air', []))
    put(world, { x: 2, y: 65, z: 0 }, rawBlock('air', []))
    put(world, { x: 3, y: 64, z: 0 }, rawBlock('sweet_berry_bush', FULL_CUBE))
    const reader = readerFor(world)
    expect(reader.node({ x: 2, y: 64, z: 0 })).toBeUndefined()
    expect(reader.node({ x: 3, y: 64, z: 0 })).toBeUndefined()
  })

  it('keeps scaffolding inside/side pass deferred for the vanilla graph', () => {
    const world = corridor()
    put(world, { x: 2, y: 64, z: 0 }, rawBlock('scaffolding', SCAFFOLDING_SHAPE))
    const reader = readerFor(world)
    expect(reader.node({ x: 2, y: 64, z: 0 })).toBeUndefined()
    expect(reader.passable({ x: 2, y: 64, z: 0 })).toBe(false)
  })
})

describe('vanilla goal snapping', () => {
  it('snaps an air goal to the cell above the first ground below it', () => {
    const world = corridor()
    air(world, { x: 2, y: 66, z: 0 }, { x: 2, y: 70, z: 0 })
    expect(snapGoal(readerFor(world), { x: 2, y: 70, z: 0 })).toEqual({ x: 2, y: 64, z: 0 })
  })

  it('snaps a solid goal to the cell above it and keeps a water goal', () => {
    const world = corridor()
    const reader = readerFor(world)
    expect(snapGoal(reader, { x: 2, y: 63, z: 0 })).toEqual({ x: 2, y: 64, z: 0 })
    put(world, { x: 2, y: 64, z: 0 }, rawBlock('water', []))
    expect(snapGoal(reader, { x: 2, y: 64, z: 0 })).toEqual({ x: 2, y: 64, z: 0 })
  })

  it('returns undefined for an unloaded goal', () => {
    const world = corridor()
    expect(snapGoal(readerFor(world), { x: 40, y: 64, z: 0 })).toBeUndefined()
  })
})

describe('vanilla planning', () => {
  it('uses vanilla fall budget 3', () => {
    expect(VANILLA_MAX_FALL).toBe(3)
  })

  it('walks a straight corridor and reports exact success', () => {
    const world = corridor()
    const plan = planVanillaPath(readerFor(world), { x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 0 })
    expect(plan.status).toBe('success')
    expect(plan.reached).toBe(true)
    expect(plan.closest).toBe(0)
    expect(plan.waypoints).toEqual([
      { x: 1, y: 64, z: 0 },
      { x: 2, y: 64, z: 0 },
      { x: 3, y: 64, z: 0 },
    ])
  })

  it('walks the snapped goal when the request is an air cell', () => {
    const world = corridor()
    air(world, { x: 3, y: 66, z: 0 }, { x: 3, y: 68, z: 0 })
    const plan = planVanillaPath(readerFor(world), { x: 0, y: 64, z: 0 }, { x: 3, y: 68, z: 0 })
    expect(plan.status).toBe('success')
    expect(plan.goalAdjustedTo).toEqual({ x: 3, y: 64, z: 0 })
    expect(plan.waypoints.at(-1)).toEqual({ x: 3, y: 64, z: 0 })
  })

  it('accepts a 3-deep drop but not a 4-deep one', () => {
    const ok = new FixtureWorld()
    air(ok, { x: 0, y: 61, z: 0 }, { x: 2, y: 65, z: 0 })
    floor(ok, { x: 0, y: 63, z: 0 }, { x: 0, y: 63, z: 0 })
    floor(ok, { x: 1, y: 60, z: 0 }, { x: 2, y: 60, z: 0 })
    ok.selfView = { ...ok.selfView, pos: { x: 0.5, y: 64, z: 0.5 } }
    const plan = planVanillaPath(readerFor(ok), { x: 0, y: 64, z: 0 }, { x: 2, y: 61, z: 0 })
    expect(plan.status).toBe('success')
    expect(plan.waypoints.at(-1)).toEqual({ x: 2, y: 61, z: 0 })

    const tooDeep = new FixtureWorld()
    air(tooDeep, { x: 0, y: 60, z: 0 }, { x: 2, y: 65, z: 0 })
    floor(tooDeep, { x: 0, y: 63, z: 0 }, { x: 0, y: 63, z: 0 })
    floor(tooDeep, { x: 1, y: 59, z: 0 }, { x: 2, y: 59, z: 0 })
    tooDeep.selfView = { ...tooDeep.selfView, pos: { x: 0.5, y: 64, z: 0.5 } }
    const blocked = planVanillaPath(readerFor(tooDeep), { x: 0, y: 64, z: 0 }, { x: 2, y: 60, z: 0 })
    expect(blocked.reached).toBe(false)
    expect(blocked.waypoints).toEqual([])
    expect(blocked.closest).toBeGreaterThan(0)
  })

  it('crosses a two-deep river along the surface', () => {
    const world = corridor()
    floor(world, { x: 1, y: 63, z: 0 }, { x: 2, y: 63, z: 0 }, 'air')
    put(world, { x: 1, y: 63, z: 0 }, rawBlock('water', []))
    put(world, { x: 2, y: 63, z: 0 }, rawBlock('water', []))
    put(world, { x: 1, y: 64, z: 0 }, rawBlock('water', []))
    put(world, { x: 2, y: 64, z: 0 }, rawBlock('water', []))
    const reader = readerFor(world)
    const plan = planVanillaPath(reader, { x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 0 })
    expect(plan.status).toBe('success')
    expect(plan.waypoints.map(cell => reader.node(cell)?.kind)).toContain('water')
  })

  it('plans the risky water+ladder bank exit', () => {
    const field = riskyFields({ x: 0, y: 100, z: 0 }).find(item => item.id === 'risky-water-ladder')
    expect(field).toBeDefined()
    const world = buildFixture(field!)
    const plan = planVanillaPath(readerFor(world), field!.start, field!.goal, { maxDistance: 32 })
    expect(plan.reached).toBe(true)
    expect(plan.waypoints.length).toBeGreaterThan(0)
  })

  it('opens a closed wooden door on the way and refuses a locked one', () => {
    const open = corridor()
    put(open, { x: 2, y: 64, z: 0 }, rawBlock('oak_door', FULL_CUBE, { open: 'false' }))
    put(open, { x: 2, y: 65, z: 0 }, rawBlock('oak_door', FULL_CUBE, { open: 'false' }))
    expect(planVanillaPath(readerFor(open), { x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }).reached).toBe(true)

    const locked = corridor()
    put(locked, { x: 2, y: 64, z: 0 }, rawBlock('iron_door', FULL_CUBE, { open: 'false' }))
    put(locked, { x: 2, y: 65, z: 0 }, rawBlock('iron_door', FULL_CUBE, { open: 'false' }))
    const plan = planVanillaPath(readerFor(locked), { x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 0 })
    expect(plan.reached).toBe(false)
    expect(plan.waypoints).toEqual([{ x: 1, y: 64, z: 0 }])
    expect(plan.closest).toBe(2)
  })

  it('returns the best-so-far prefix when the goal is walled off', () => {
    const world = corridor()
    put(world, { x: 2, y: 64, z: 0 }, rawBlock('stone', FULL_CUBE))
    put(world, { x: 2, y: 65, z: 0 }, rawBlock('stone', FULL_CUBE))
    const plan = planVanillaPath(readerFor(world), { x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 0 })
    expect(plan.status).toBe('partial')
    expect(plan.reached).toBe(false)
    expect(plan.waypoints).toEqual([{ x: 1, y: 64, z: 0 }])
    expect(plan.closest).toBe(2)
  })
})

describe('vanilla follower', () => {
  it('advances to the waypoint with vanilla tolerance and succeeds', () => {
    const world = corridor()
    const follower = new WaypointFollower(world, readerFor(world), [{ x: 0, y: 64, z: 1 }])
    put(world, { x: 0, y: 64, z: 1 }, rawBlock('air', []))
    put(world, { x: 0, y: 63, z: 1 }, rawBlock('stone', FULL_CUBE))
    world.selfView = { ...world.selfView, pos: { x: 0.5, y: 64, z: 0.5 } }
    expect(follower.tick(0).status).toBe('running')
    world.selfView = { ...world.selfView, pos: { x: 0.5, y: 64, z: 1 + VANILLA_HORIZONTAL_TOLERANCE - 0.01 } }
    expect(follower.tick(100).status).toBe('running')
    expect(follower.tick(200).status).toBe('succeeded')
    expect(world.inputs.get('forward')).not.toBe(true)
  })

  it('reports VANILLA_STUCK after the vanilla stall window', () => {
    const world = corridor()
    const follower = new WaypointFollower(world, readerFor(world), [{ x: 0, y: 64, z: 2 }])
    expect(follower.tick(0).status).toBe('running')
    const stalled = follower.tick(VANILLA_STALL_MS + 1)
    expect(stalled).toEqual({ status: 'failed', code: 'VANILLA_STUCK' })
  })

  it('clicks a door node and jumps when the next node is a block up', () => {
    const world = corridor()
    put(world, { x: 1, y: 64, z: 0 }, rawBlock('oak_door', FULL_CUBE, { open: 'false' }))
    put(world, { x: 1, y: 65, z: 0 }, rawBlock('oak_door', FULL_CUBE, { open: 'false' }))
    const doorFollower = new WaypointFollower(world, readerFor(world), [{ x: 1, y: 64, z: 0 }])
    doorFollower.tick(0)
    expect(world.actions).toContain('use:1,64,0')

    const up = corridor()
    put(up, { x: 1, y: 64, z: 0 }, rawBlock('stone', FULL_CUBE))
    put(up, { x: 1, y: 65, z: 0 }, rawBlock('air', []))
    const upFollower = new WaypointFollower(up, readerFor(up), [{ x: 1, y: 65, z: 0 }])
    upFollower.tick(0)
    expect(up.inputs.get('jump')).toBe(true)
  })
})

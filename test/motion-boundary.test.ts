/**
 * Non-acceptance / 非验收: boundary terrain matrix as a pure model regression.
 * The live script is the acceptance; this suite pins the planner verdict per
 * stage and the geometry/label facts the rows depend on.
 */
import { describe, expect, it } from 'vitest'

import { boundaryFields, matrixCommands } from '../src/motion/matrix/index.ts'
import type { BoundaryField, BoundaryStage } from '../src/motion/matrix/index.ts'
import { MotionContextSource } from '../src/provider/motion/context.ts'
import {
  createRules,
  defaultConstraints,
  resolveConstraints,
  supportTopAt,
  topSurfaceAt,
  type MotionConstraints,
} from '../src/motion/model/index.ts'
import { MotionSearch } from '../src/motion/search/index.ts'
import { buildFixture } from './helpers/motion-world.ts'

const ORIGIN = { x: 0, y: 100, z: 0 }
const fields = boundaryFields(ORIGIN)

/** Replayable stage constraints; see boundary.ts. */
const STAGES: Record<BoundaryStage, Partial<MotionConstraints>> = {
  guards: { waterProfile: 'none', allowClimb: false },
  climb: { waterProfile: 'none', allowClimb: true },
  wade: { waterProfile: 'wade', allowClimb: true },
  swim: { waterProfile: 'swim', allowClimb: true },
}

function constraintsFor(field: BoundaryField, stage: BoundaryStage): MotionConstraints {
  return resolveConstraints(defaultConstraints(), {
    ...STAGES[stage],
    ...(field.authorization?.allowParkour === true ? { allowParkour: true } : {}),
    ...(field.authorization?.allowPlace === true ? { allowPlace: true } : {}),
    ...(field.authorization?.material === undefined ? {} : { material: field.authorization.material }),
  })
}

function solve(field: BoundaryField, stage: BoundaryStage) {
  const world = buildFixture(field)
  const source = new MotionContextSource(world, constraintsFor(field, stage))
  const search = new MotionSearch(field.start, field.goal, () => source.next(), {
    sliceMs: 50,
    timeoutMs: 2_000,
    maxNodes: 20_000,
  })
  let result = search.step(Date.now())
  let guard = 0
  while (result.status === 'running' && guard < 2_000) {
    result = search.step(Date.now())
    guard += 1
  }
  return { result, world }
}

function expectedStatus(field: BoundaryField, stage: BoundaryStage): 'success' | 'noPath' {
  return field.expect[stage].state === 'succeeded' ? 'success' : 'noPath'
}

describe('boundary matrix shape', () => {
  it('defines every required boundary group in a stable order', () => {
    const ids = fields.map(field => field.id)
    expect(ids).toEqual([
      'water-wade-1', 'water-deep-2', 'water-fall-2', 'waterlogged-top-slab',
      'waterlogged-bottom-slab', 'water-ladder',
      'water-ladder-exit', 'water-ladder-shallow', 'water-ladder-no-ladder',
      'ladder-up', 'ladder-down', 'ladder-beside', 'ladder-top-step-up', 'vine-up', 'ladder-second-floor',
      'scaffold-stand', 'scaffold-step-over', 'scaffold-top-down', 'scaffold-beside',
      'scaffold-through', 'scaffold-place', 'scaffold-stack',
      'slab-bottom-step', 'slab-top-step', 'stair-up', 'stair-down',
      'slab-ascend-impossible', 'slab-ascend-bottom-to-bottom', 'slab-pillar',
      'slab-fall-onto', 'slab-parkour-from',
      'farmland-step', 'farmland-pillar', 'stair-pillar',
      'lava-beside-slab', 'lava-step-into',
    'swim-lake-5wide', 'swim-fall-2deep',
    ])
  })

  it('builds commands with one clear, fills and setblocks', () => {
    const commands = matrixCommands(fields[0]!)
    expect(commands[0]).toMatch(/^\/fill .* air$/u)
    expect(commands.some(command => command.startsWith('/setblock') && command.includes('water'))).toBe(true)
  })

  it('every start cell is standable in its own stage', () => {
    for (const field of fields) {
      const world = buildFixture(field)
      for (const stage of ['guards', 'climb', 'wade', 'swim'] as const) {
        const rules = createRules(world, constraintsFor(field, stage))
        expect(rules.standInfo(field.start).state, `${field.id} start (${stage})`).toBe('yes')
      }
    }
  })

  it('keeps stairs unstandable at the centre sample and standable over the footprint', () => {
    const stairs = fields.find(field => field.id === 'stair-up')!
    const world = buildFixture(stairs)
    const rules = createRules(world, resolveConstraints(defaultConstraints(), STAGES.wade))
    const block = world.blockAt({ x: 0, y: 101, z: 3 })
    expect(block).not.toBeNull()
    if (block === null) return
    const classified = { ...block, tags: ['solid'] as const }
    // This is the pre-fix measurement that made stairs unstandable.
    expect(topSurfaceAt(classified, 0.5, 0.5)).toBe(0.5)
    expect(supportTopAt(classified)).toBe(1)
    const info = rules.standInfo({ x: 0, y: 102, z: 3 })
    expect(info.state).toBe('yes')
    if (info.state === 'yes') expect(info.feetY).toBe(102)
  })

  it('treats a ladder cell as body-passable but not standable', () => {
    const ladder = fields.find(field => field.id === 'ladder-up')!
    const world = buildFixture(ladder)
    const rules = createRules(world, resolveConstraints(defaultConstraints(), STAGES.climb))
    expect(rules.isClimbable({ x: 0, y: 102, z: 0 })).toBe('yes')
    expect(rules.canWalkThrough({ x: 0, y: 102, z: 0 })).toBe('yes')
    expect(rules.standInfo({ x: 0, y: 102, z: 0 }).state).toBe('no')
  })

  it('keeps scaffolding top walkable but body-impassable', () => {
    const scaffold = fields.find(field => field.id === 'scaffold-stand')!
    const world = buildFixture(scaffold)
    const rules = createRules(world, resolveConstraints(defaultConstraints(), STAGES.wade))
    const block = { x: 0, y: 101, z: 3 }
    expect(rules.canWalkOn(block)).toBe('yes')
    // The body cannot occupy the scaffolding cell (its top plate is in the way),
    // which is exactly why a scaffolding wall is not a climbable column for us.
    expect(rules.canWalkThrough(block)).toBe('no')
    expect(rules.isClimbable(block)).toBe('yes')
    expect(rules.standInfo({ x: 0, y: 102, z: 3 }).state).toBe('yes')
  })

  it('steps over one scaffolding block but does not pass through a wall', () => {
    const over = fields.find(field => field.id === 'scaffold-step-over')!
    const overResult = solve(over, 'wade').result
    expect(overResult.status).toBe('success')
    if (overResult.status === 'success') {
      const kinds = overResult.moves.map(move => move.kind)
      expect(kinds).toContain('ascend')
      expect(kinds).toContain('descend')
    }

    const through = fields.find(field => field.id === 'scaffold-through')!
    expect(solve(through, 'wade').result.status).toBe('noPath')
  })

  it('closes every fluid cell until the wade profile is on', () => {
    const wade = fields.find(field => field.id === 'water-wade-1')!
    const world = buildFixture(wade)
    const dry = createRules(world, resolveConstraints(defaultConstraints(), STAGES.climb))
    const wet = createRules(world, resolveConstraints(defaultConstraints(), STAGES.wade))
    const cell = { x: 0, y: 100, z: 3 }
    expect(dry.standInfo(cell).state).toBe('no')
    expect(dry.canWalkThrough(cell)).toBe('no')
    expect(wet.standInfo(cell).state).toBe('yes')
    expect(wet.canWalkThrough(cell)).toBe('yes')
    // Deep water stays closed in every stage.
    const deep = fields.find(field => field.id === 'water-deep-2')!
    const deepWorld = buildFixture(deep)
    const deepRules = createRules(deepWorld, resolveConstraints(defaultConstraints(), STAGES.wade))
    expect(deepRules.standInfo({ x: 0, y: 100, z: 3 }).state).toBe('no')
  })
})

describe('boundary matrix planner verdicts', () => {
  for (const stage of ['guards', 'climb', 'wade', 'swim'] as const) {
    describe(`stage ${stage}`, () => {
      for (const field of fields) {
        if (field.verifiedBy === 'executor') {
          // Plans fine, fails in the world: the live run owns this row.
          continue
        }
        it(`${field.id}: ${field.expect[stage].state}`, () => {
          const { result } = solve(field, stage)
          expect(result.status, `${field.id} (${stage})`).toBe(expectedStatus(field, stage))
        })
      }
    })
  }
})

describe('water replanning', () => {
  it('plans from the middle of the lake to the far bank', () => {
    const field = boundaryFields({ x: 0, y: 100, z: 0 }).find(field => field.id === 'swim-lake-5wide')!
    const world = buildFixture(field)
    const source = new MotionContextSource(world, resolveConstraints(defaultConstraints(), { waterProfile: 'swim' }))
    // The body floats at the surface mid-lake, so the feet cell is the surface.
    const start = { x: field.start.x, y: field.start.y - 1, z: field.start.z + 4 }
    const search = new MotionSearch(start, field.goal, () => source.next(), { sliceMs: 50, timeoutMs: 2_000, maxNodes: 20_000 })
    let result = search.step(Date.now())
    let guard = 0
    while (result.status === 'running' && guard < 2_000) {
      result = search.step(Date.now())
      guard += 1
    }
    expect(result.status, JSON.stringify({ start, goal: field.goal })).toBe('success')
  })
})

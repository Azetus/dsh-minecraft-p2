import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  countItem,
  evaluatePlan,
  instantiatePlan,
  loadPlanTemplates,
  matchesExpected,
} from '../src/mind/plan.ts'
import type { PlanTemplate, WorkItem } from '../src/mind/plan.ts'
import type { BlockInfo, Item, SelfInfo } from '../src/body/api.ts'
import { SnapshotWorld } from '../src/mind/world.ts'

/**
 * Category: state/data (todo M2-01, CONTRACTS §8).
 * Protects: four-state evaluation, name+state subset matching, dependency
 * ordering, and "one bad cell never hides the other work items".
 */

function self(overrides: Partial<SelfInfo> = {}): SelfInfo {
  return {
    pos: { x: 0.5, y: 64, z: 0.5 },
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    onGround: true,
    inWater: false,
    inLava: false,
    ...overrides,
  }
}

function world(options: {
  blocks?: BlockInfo[]
  inventory?: Item[]
  self?: Partial<SelfInfo>
  stale?: boolean
} = {}): SnapshotWorld {
  return new SnapshotWorld({
    self: self(options.self),
    time: { timeOfDay: 1000, worldAge: 100 },
    entities: [],
    blocks: options.blocks ?? [],
    inventory: options.inventory ?? [],
    ...(options.stale === true ? { stale: true } : {}),
  })
}

function block(name: string, x: number, y: number, z: number, state?: Record<string, string>): BlockInfo {
  return { name, loaded: true, pos: { x, y, z }, ...(state === undefined ? {} : { state }) }
}

function items(list: WorkItem[], extras: Partial<PlanTemplate> = {}): PlanTemplate {
  return {
    id: 'test-plan',
    version: 1,
    size: [3, 2, 3],
    materialPolicy: {},
    workItems: list,
    ...extras,
  }
}

function planOf(workItems: WorkItem[], origin = { x: 0, y: 64, z: 0 }) {
  return instantiatePlan(items(workItems), 'ord-1', origin)
}

const dirt: Item = { slot: 36, name: 'dirt', count: 3 }

describe('plan templates', () => {
  it('loads the shipped dig-room template', () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'content', 'plans', 'dig-room-3x3x2.json'), 'utf8'))
    const loaded = loadPlanTemplates({ 'dig-room-3x3x2': raw })
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    const template = loaded.templates.get('dig-room-3x3x2')
    expect(template?.workItems).toHaveLength(19)
    expect(template?.size).toEqual([3, 2, 3])
  })

  it('rejects duplicate ids, unknown dependencies, cycles and missing expected blocks', () => {
    const cases: unknown[] = [
      { ...items([{ id: 'a', kind: 'clear', at: [0, 0, 0] }, { id: 'a', kind: 'clear', at: [1, 0, 0] }]) },
      { ...items([{ id: 'a', kind: 'clear', at: [0, 0, 0], after: ['missing'] }]) },
      {
        ...items([
          { id: 'a', kind: 'clear', at: [0, 0, 0], after: ['b'] },
          { id: 'b', kind: 'clear', at: [1, 0, 0], after: ['a'] },
        ]),
      },
      { ...items([{ id: 'a', kind: 'place', at: [0, 0, 0] }]) },
      { ...items([{ id: 'a', kind: 'clear', at: [0, 0, 0] }]), verify: { kind: 'sealed-room', min: [0, 0, 0], max: [1, 1, 1] }, extra: true },
    ]
    for (const value of cases) {
      const loaded = loadPlanTemplates({ bad: value })
      expect(loaded.ok).toBe(false)
      if (!loaded.ok) expect(loaded.error.code).toBe('DEFINITION_ERROR')
    }
  })
})

describe('work item evaluation', () => {
  it('matches name plus a state subset', () => {
    expect(matchesExpected(block('oak_door', 0, 64, 0, { half: 'lower', open: 'false' }), {
      name: 'oak_door', state: { half: 'lower' },
    })).toBe(true)
    expect(matchesExpected(block('oak_door', 0, 64, 0, { half: 'upper' }), {
      name: 'oak_door', state: { half: 'lower' },
    })).toBe(false)
    expect(matchesExpected(block('oak_door', 0, 64, 0), { name: 'minecraft:oak_door' })).toBe(true)
  })

  it('reports clear as satisfied, executable, blocked or unknown', () => {
    const plan = planOf([{ id: 'c', kind: 'clear', at: [1, 0, 0] }])
    const air = world({ blocks: [block('stone', 1, 63, 0), block('air', 1, 64, 0)] })
    expect(evaluatePlan(plan, air).states.get('c')).toEqual({ kind: 'satisfied' })

    const stone = world({ blocks: [block('stone', 1, 63, 0), block('stone', 1, 64, 0)] })
    expect(evaluatePlan(plan, stone).next?.state).toEqual({ kind: 'executable', driverId: 'clear' })

    const far = world({
      blocks: [block('stone', 20, 63, 0), block('stone', 20, 64, 0)],
      self: { pos: { x: 0.5, y: 64, z: 0.5 } },
    })
    const farPlan = planOf([{ id: 'c', kind: 'clear', at: [20, 0, 0] }])
    expect(evaluatePlan(farPlan, far).states.get('c')).toEqual({ kind: 'blocked', reason: 'UNREACHABLE' })

    const missing = world({ blocks: [] })
    expect(evaluatePlan(plan, missing).states.get('c')).toEqual({ kind: 'unknown' })
  })

  it('reports place material/support/attempt states in order', () => {
    const place: WorkItem = {
      id: 'p', kind: 'place', at: [1, 0, 0], expected: { name: 'dirt' },
    }
    const ground = [block('stone', 1, 63, 0), block('air', 1, 64, 0)]
    const plan = planOf([place])

    expect(evaluatePlan(plan, world({ blocks: ground })).states.get('p'))
      .toEqual({ kind: 'blocked', reason: 'NO_MATERIAL' })
    expect(evaluatePlan(plan, world({ blocks: ground, inventory: [dirt] })).states.get('p'))
      .toEqual({ kind: 'executable', driverId: 'place' })
    // A non-air target is an attempt, not a pre-blocked conflict: the server
    // decides. This includes fluid targets such as water.
    expect(evaluatePlan(plan, world({ blocks: [block('stone', 1, 63, 0), block('stone', 1, 64, 0)], inventory: [dirt] })).states.get('p'))
      .toEqual({ kind: 'executable', driverId: 'place' })
    expect(evaluatePlan(plan, world({ blocks: [block('stone', 1, 63, 0), block('water', 1, 64, 0)], inventory: [dirt] })).states.get('p'))
      .toEqual({ kind: 'executable', driverId: 'place' })
    expect(evaluatePlan(plan, world({ blocks: [block('air', 1, 63, 0), block('air', 1, 64, 0)], inventory: [dirt] })).states.get('p'))
      .toEqual({ kind: 'blocked', reason: 'NO_SUPPORT' })
    expect(evaluatePlan(plan, world({ blocks: ground, inventory: [dirt], stale: true })).states.get('p'))
      .toEqual({ kind: 'unknown' })
  })

  it('honours dependencies and lets a blocked cell leave other work executable', () => {
    const plan = planOf([
      { id: 'bad', kind: 'place', at: [1, 0, 0], expected: { name: 'diamond_block' } },
      { id: 'good', kind: 'place', at: [2, 0, 0], expected: { name: 'dirt' }, after: ['bad'] },
    ])
    const ground = [
      block('stone', 1, 63, 0), block('air', 1, 64, 0),
      block('stone', 2, 63, 0), block('air', 2, 64, 0),
    ]
    const evaluation = evaluatePlan(plan, world({ blocks: ground, inventory: [dirt] }))
    expect(evaluation.states.get('bad')).toEqual({ kind: 'blocked', reason: 'NO_MATERIAL' })
    expect(evaluation.states.get('good')).toEqual({ kind: 'blocked', reason: 'CONFLICT' })
    expect(evaluation.next).toBeUndefined()
    expect(evaluation.blocked).toBe(true)

    const plan2 = planOf([
      { id: 'bad', kind: 'place', at: [1, 0, 0], expected: { name: 'diamond_block' } },
      { id: 'good', kind: 'place', at: [2, 0, 0], expected: { name: 'dirt' } },
    ])
    const evaluation2 = evaluatePlan(plan2, world({ blocks: ground, inventory: [dirt] }))
    expect(evaluation2.states.get('bad')).toEqual({ kind: 'blocked', reason: 'NO_MATERIAL' })
    expect(evaluation2.next).toMatchObject({ item: { id: 'good' }, state: { kind: 'executable' } })
    expect(evaluation2.blocked).toBe(false)
  })

  it('orders enter/prepare by standability and current position', () => {
    const plan = planOf([{ id: 'e', kind: 'enter', at: [1, 0, 0] }])
    const standable = [block('stone', 1, 63, 0), block('air', 1, 64, 0), block('air', 1, 65, 0)]
    expect(evaluatePlan(plan, world({
      blocks: standable,
      self: { pos: { x: 3.5, y: 64, z: 0.5 } },
    })).next?.state).toEqual({ kind: 'executable', driverId: 'enter' })
    expect(evaluatePlan(plan, world({ blocks: standable, self: { pos: { x: 1.5, y: 64, z: 0.5 } } })).states.get('e'))
      .toEqual({ kind: 'satisfied' })
    expect(evaluatePlan(plan, world({ blocks: [block('stone', 1, 63, 0), block('stone', 1, 64, 0)] })).states.get('e'))
      .toEqual({ kind: 'blocked', reason: 'NO_STAND' })
  })

  it('moves a solid conflict to blocked when the policy says clear', () => {
    const plan = planOf([{ id: 'p', kind: 'place', at: [1, 0, 0], expected: { name: 'dirt' } }])
    const occupied = world({
      blocks: [block('stone', 1, 63, 0), block('stone', 1, 64, 0)],
      inventory: [dirt],
    })
    expect(evaluatePlan(plan, occupied, { mode: 'clear' }).states.get('p'))
      .toEqual({ kind: 'blocked', reason: 'CONFLICT' })
    // Water is still an attempt, not a clear conflict.
    expect(evaluatePlan(plan, world({
      blocks: [block('stone', 1, 63, 0), block('water', 1, 64, 0)],
      inventory: [dirt],
    }), { mode: 'clear' }).states.get('p'))
      .toEqual({ kind: 'executable', driverId: 'place' })
  })

  it('counts inventory items by normalized name', () => {
    expect(countItem([
      { slot: 1, name: 'dirt', count: 2 },
      { slot: 2, name: 'minecraft:dirt', count: 3 },
      { slot: 3, name: 'stone', count: 9 },
    ], 'dirt')).toBe(5)
  })
})

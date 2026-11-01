import { describe, expect, it } from 'vitest'

import { createPlanGiver } from '../src/mind/givers/plan.ts'
import { instantiatePlan } from '../src/mind/plan.ts'
import type { PlanTemplate, WorkItem } from '../src/mind/plan.ts'
import type { EvalCtx } from '../src/mind/types.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { BlockInfo, Item, SelfInfo } from '../src/port/index.ts'

/**
 * Category: cross-module contract (todo M2-02).
 * Protects: the plan giver returns the first executable work item, keeps all
 * work items in play, and hands off reach-only problems without selecting a
 * different target.
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

function world(options: { blocks?: BlockInfo[]; inventory?: Item[]; self?: Partial<SelfInfo> } = {}): SnapshotWorld {
  return new SnapshotWorld({
    self: self(options.self),
    time: { timeOfDay: 1000, worldAge: 1 },
    entities: [],
    blocks: options.blocks ?? [],
    inventory: options.inventory ?? [],
  })
}

function block(name: string, x: number, y: number, z: number): BlockInfo {
  return { name, loaded: true, pos: { x, y, z } }
}

/** A walkable floor around the origin; a placement needs a real stance. */
function floor(): BlockInfo[] {
  const blocks: BlockInfo[] = []
  for (let x = -1; x <= 3; x += 1) {
    for (let z = -1; z <= 1; z += 1) {
      blocks.push(block('stone', x, 63, z))
      blocks.push(block('air', x, 64, z))
      blocks.push(block('air', x, 65, z))
    }
  }
  return blocks
}

function template(workItems: WorkItem[]): PlanTemplate {
  return { id: 'p', version: 1, size: [3, 2, 3], materialPolicy: {}, workItems }
}

const dirt: Item = { slot: 36, name: 'dirt', count: 4 }
const origin = { x: 0, y: 64, z: 0 }

describe('plan giver', () => {
  it('returns null without a plan', () => {
    expect(createPlanGiver().find({ now: 0 }, world())).toBeNull()
  })

  it('selects the first executable place with absolute coordinates and item', () => {
    const plan = instantiatePlan(template([
      { id: 'w1', kind: 'place', at: [1, 0, 0], expected: { name: 'dirt' } },
    ]), 'ord-1', origin)
    const ctx: EvalCtx = { now: 0, plan }
    const result = createPlanGiver().find(ctx, world({
      blocks: [...floor(), block('stone', 1, 63, 0)],
      inventory: [dirt],
    })) as unknown as { driverId: string; params: { x: number; y: number; z: number; item: string }; keys: string }
    expect(result.driverId).toBe('place')
    expect(result.params).toMatchObject({ x: 1, y: 64, z: 0, item: 'dirt' })
    expect(result.keys).toBe('plan:plan-ord-1-p:w1')
  })

  it('selects a clear item when it is first', () => {
    const plan = instantiatePlan(template([
      { id: 'c1', kind: 'clear', at: [1, 0, 0] },
      { id: 'p1', kind: 'place', at: [2, 0, 0], expected: { name: 'dirt' } },
    ]), 'ord-1', origin)
    const result = createPlanGiver().find({ now: 0, plan }, world({
      blocks: [block('stone', 1, 63, 0), block('stone', 1, 64, 0),
        block('stone', 2, 63, 0), block('air', 2, 64, 0)],
      inventory: [dirt],
    })) as unknown as { driverId: string }
    expect(result.driverId).toBe('clear')
  })

  it('hands off a reach-only problem with interaction reach', () => {
    const plan = instantiatePlan(template([
      { id: 'far', kind: 'clear', at: [20, 0, 0] },
    ]), 'ord-1', origin)
    const blocks: BlockInfo[] = []
    for (let x = 18; x <= 22; x += 1) {
      for (let z = -2; z <= 2; z += 1) {
        blocks.push(block('stone', x, 63, z))
        blocks.push(block('air', x, 64, z))
        blocks.push(block('air', x, 65, z))
      }
    }
    blocks.push(block('stone', 20, 64, 0))
    const result = createPlanGiver().find({ now: 0, plan }, world({ blocks })) as unknown as {
      driverId: string
      reason: string
      target: { pos: { x: number; y: number; z: number } }
      params: { range: number; intent: string }
    }
    expect(result.driverId).toBe('move')
    expect(result.reason).toContain('reach far')
    expect(Math.hypot(result.target.pos.x - 20, result.target.pos.z - 0)).toBeLessThanOrEqual(3)
    expect(result.params).toMatchObject({ range: 0 })
  })

  it('does not walk at an unloaded work item; it reports the observation gap', () => {
    const plan = instantiatePlan(template([
      { id: 'far', kind: 'clear', at: [30, 0, 0] },
    ]), 'ord-1', origin)
    const giver = createPlanGiver()
    // The first evaluation requests a targeted re-read and yields no job.
    expect(giver.find({ now: 0, plan }, world())).toBeNull()
    const result = giver.find({ now: 0, plan }, world()) as unknown as {
      kind: string
      reason: string
      data: { items: Array<{ workItemId: string; reason: string }> }
    }
    expect(result.kind).toBe('hold')
    expect(result.reason).toBe('PLAN_BLOCKED')
    expect(result.data.items[0]?.reason).toBe('UNKNOWN')
  })

  it('returns null when every work item is satisfied', () => {
    const plan = instantiatePlan(template([
      { id: 'c1', kind: 'clear', at: [1, 0, 0] },
    ]), 'ord-1', origin)
    expect(createPlanGiver().find({ now: 0, plan }, world({
      blocks: [block('stone', 1, 63, 0), block('air', 1, 64, 0)],
    }))).toBeNull()
  })

  it('hands off a clear for a solid conflict when the policy allows it', () => {
    const plan = instantiatePlan(template([
      { id: 'p', kind: 'place', at: [1, 0, 0], expected: { name: 'dirt' } },
    ]), 'ord-1', origin)
    const result = createPlanGiver().find({
      now: 0,
      plan,
      conflictPolicy: { mode: 'clear' },
    }, world({
      blocks: [block('stone', 1, 63, 0), block('stone', 1, 64, 0)],
      inventory: [dirt],
    })) as unknown as { driverId: string; reason: string; params: { x: number; y: number; z: number } }
    expect(result.driverId).toBe('clear')
    expect(result.reason).toContain('clear conflict p')
    expect(result.params).toEqual({ x: 1, y: 64, z: 0 })
  })

  it('returns a silent hold when every work item is blocked', () => {
    const plan = instantiatePlan(template([
      { id: 'p', kind: 'place', at: [1, 0, 0], expected: { name: 'dirt' } },
    ]), 'ord-1', origin)
    const result = createPlanGiver().find({
      now: 0,
      plan,
      conflictPolicy: { mode: 'clear' },
    }, world({
      blocks: [block('stone', 1, 63, 0), block('chest', 1, 64, 0)],
      inventory: [dirt],
    }))
    expect(result).toMatchObject({ kind: 'hold', reason: 'PLAN_BLOCKED', notify: false })
  })

  it('does not hide a later executable item behind a blocked one', () => {
    const plan = instantiatePlan(template([
      { id: 'blocked', kind: 'place', at: [1, 0, 0], expected: { name: 'diamond_block' } },
      { id: 'next', kind: 'place', at: [2, 0, 0], expected: { name: 'dirt' } },
    ]), 'ord-1', origin)
    const result = createPlanGiver().find({ now: 0, plan }, world({
      blocks: [
        ...floor(),
        block('stone', 1, 63, 0), block('air', 1, 64, 0),
        block('stone', 2, 63, 0), block('air', 2, 64, 0),
      ],
      inventory: [dirt],
    })) as unknown as { keys: string }
    expect(result.keys).toBe('plan:plan-ord-1-p:next')
  })
})

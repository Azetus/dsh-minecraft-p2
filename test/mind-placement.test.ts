import { describe, expect, it } from 'vitest'

import { buildStage, currentStage, stageItems, stageSummaries } from '../src/mind/build-stage.ts'
import { evaluatePlan, instantiatePlan } from '../src/mind/plan.ts'
import type { PlanTemplate, WorkItem } from '../src/mind/plan.ts'
import { PlanItemLedger, placementStances, stepAsideStances } from '../src/mind/placement.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { BlockInfo, SelfInfo } from '../src/body/api.ts'

/**
 * Category: cross-module contract (B1 placement stance ledger).
 * Protects: the stance pool is complete, a failed stance is scoped to one work
 * item, a block is cleared when the world changes, and stages are a barrier.
 */

const self: SelfInfo = {
  pos: { x: 0.5, y: 64, z: 0.5 },
  yaw: 0,
  pitch: 0,
  health: 20,
  food: 20,
  onGround: true,
  inWater: false,
  inLava: false,
}

function block(name: string, x: number, y: number, z: number): BlockInfo {
  return { name, loaded: true, pos: { x, y, z } }
}

function world(extra: BlockInfo[] = [], pos = self.pos): SnapshotWorld {
  const blocks: BlockInfo[] = []
  for (let x = -3; x <= 5; x += 1) {
    for (let z = -2; z <= 2; z += 1) {
      blocks.push(block('stone', x, 63, z))
      blocks.push(block('air', x, 64, z))
      blocks.push(block('air', x, 65, z))
    }
  }
  blocks.push(...extra)
  return new SnapshotWorld({
    self: { ...self, pos },
    time: { timeOfDay: 1000, worldAge: 1 },
    entities: [],
    blocks,
    inventory: [{ slot: 36, name: 'dirt', count: 64 }],
  })
}

const origin = { x: 0, y: 64, z: 0 }

function template(workItems: WorkItem[]): PlanTemplate {
  return { id: 'p', version: 1, size: [4, 2, 3], materialPolicy: {}, workItems }
}

describe('placement stances', () => {
  it('allows an unplaced future target as a temporary stand', () => {
    const plan = instantiatePlan(template([
      { id: 'a', kind: 'place', at: [2, 0, 0], expected: { name: 'dirt' } },
      { id: 'b', kind: 'place', at: [3, 0, 0], expected: { name: 'dirt' } },
    ]), 'ord-1', origin)
    const choices = placementStances(plan, world(), plan.workItems[0]!, 2)
    expect(choices.some(choice => choice.stance.x === 3 && choice.stance.y === 64 && choice.stance.z === 0)).toBe(true)
  })

  it('excludes a target that is already solid', () => {
    const plan = instantiatePlan(template([
      { id: 'a', kind: 'place', at: [2, 0, 0], expected: { name: 'dirt' } },
      { id: 'b', kind: 'place', at: [3, 0, 0], expected: { name: 'dirt' } },
    ]), 'ord-1', origin)
    const choices = placementStances(plan, world([block('dirt', 3, 64, 0)]), plan.workItems[0]!, 2)
    expect(choices.some(choice => choice.stance.x === 3 && choice.stance.y === 64 && choice.stance.z === 0)).toBe(false)
  })

  it('keeps a failed stance for one item out of another item pool', () => {
    const plan = instantiatePlan(template([
      { id: 'a', kind: 'place', at: [2, 0, 0], expected: { name: 'dirt' } },
      { id: 'b', kind: 'place', at: [0, 0, 0], expected: { name: 'dirt' } },
    ]), 'ord-1', origin)
    const w = world()
    const ledger = new PlanItemLedger()
    const a = plan.workItems[0]!
    const b = plan.workItems[1]!
    ledger.entry(plan, a, 2, { x: 2, y: 64, z: 0 }, w)
    ledger.entry(plan, b, 2, { x: 0, y: 64, z: 0 }, w)
    const stance = { x: 1, y: 64, z: 0 }
    ledger.record(plan, a, stance, { ok: false, code: 'PLACE_FAILED' }, w)
    ledger.record(plan, a, stance, { ok: false, code: 'PLACE_FAILED' }, w)

    expect([...ledger.failedStances(plan, a)]).toContain('1,64,0')
    expect([...ledger.failedStances(plan, b)]).not.toContain('1,64,0')
    expect(placementStances(plan, w, b, 2).some(choice => choice.stance.x === 1 && choice.stance.y === 64)).toBe(true)
  })

  it('blocks an item after three distinct stances fail, and clears on world change', () => {
    const plan = instantiatePlan(template([
      { id: 'a', kind: 'place', at: [2, 0, 0], expected: { name: 'dirt' } },
    ]), 'ord-1', origin)
    const w = world()
    const ledger = new PlanItemLedger()
    const item = plan.workItems[0]!
    ledger.entry(plan, item, 2, { x: 2, y: 64, z: 0 }, w)
    for (const stance of [{ x: 1, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }, { x: 2, y: 64, z: 1 }]) {
      ledger.record(plan, item, stance, { ok: false, code: 'PLACE_FAILED' }, w)
      ledger.record(plan, item, stance, { ok: false, code: 'PLACE_FAILED' }, w)
    }
    expect(ledger.blocked(plan, item)?.reason).toBe('NO_PLACE_STANCE')

    // A wall/floor change near the item makes the earlier failure stale.
    const changed = world([block('dirt', 2, 63, 0)])
    ledger.entry(plan, item, 2, { x: 2, y: 64, z: 0 }, changed)
    expect(ledger.blocked(plan, item)).toBeUndefined()
  })

  it('steps aside to a cell that is not another pending target', () => {
    const plan = instantiatePlan(template([
      { id: 'a', kind: 'place', at: [1, 0, 0], expected: { name: 'dirt' } },
      { id: 'b', kind: 'place', at: [2, 0, 0], expected: { name: 'dirt' } },
    ]), 'ord-1', origin)
    const choices = stepAsideStances(plan, world([], { x: 1.5, y: 64, z: 0.5 }), plan.workItems[0]!, 2)
    expect(choices.length).toBeGreaterThan(0)
    const stance = choices[0]!.stance
    expect([`1,64,0`, `2,64,0`]).not.toContain(`${stance.x},${stance.y},${stance.z}`)
  })
})

describe('build stages', () => {
  const workItems: WorkItem[] = [
    { id: 'floor', kind: 'place', at: [0, 0, 0], expected: { name: 'dirt' } },
    { id: 'lower', kind: 'place', at: [0, 1, 0], expected: { name: 'dirt' } },
    { id: 'upper', kind: 'place', at: [0, 3, 0], expected: { name: 'dirt' } },
    { id: 'furniture', kind: 'place', at: [1, 1, 1], expected: { name: 'red_bed' } },
    { id: 'door', kind: 'place', at: [0, 1, -1], expected: { name: 'oak_door' } },
  ]
  const plan = instantiatePlan({
    id: 'staged',
    version: 1,
    size: [2, 2, 2],
    materialPolicy: {},
    workItems,
    verify: { kind: 'usable-room', min: [1, 1, 1], max: [1, 2, 1] },
  }, 'ord-stage', origin)
  const deferred = new Set(['door'])

  it('orders floor, lower shell, upper shell, interior and the deferred entrance', () => {
    expect(buildStage(plan, workItems[0]!, deferred)).toBe(1)
    expect(buildStage(plan, workItems[1]!, deferred)).toBe(2)
    expect(buildStage(plan, workItems[2]!, deferred)).toBe(3)
    expect(buildStage(plan, workItems[3]!, deferred)).toBe(4)
    expect(buildStage(plan, workItems[4]!, deferred)).toBe(5)
  })

  it('never advances past an unfinished stage', () => {
    const w = world()
    const evaluation = evaluatePlan(plan, w)
    const summaries = stageSummaries(plan, deferred, evaluation.states)
    expect(currentStage(plan, deferred, evaluation.states)).toBe(1)
    expect(stageItems(plan, deferred, 1).map(item => item.id)).toEqual(['floor'])
    expect(summaries[0]?.done).toBe(false)
    expect(summaries[1]?.done).toBe(false)
  })
})

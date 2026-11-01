import { describe, expect, it } from 'vitest'

import { planBuildAccess } from '../src/mind/build-access.ts'
import { blueprintPlan, parseBlueprint } from '../src/mind/blueprint.ts'
import { instantiatePlan } from '../src/mind/plan.ts'
import type { PlanTemplate, WorkItem } from '../src/mind/plan.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { BlockInfo, SelfInfo } from '../src/port/index.ts'

const self: SelfInfo = {
  pos: { x: 0.5, y: 64, z: -3.5 },
  yaw: 0,
  pitch: 0,
  health: 20,
  food: 20,
  onGround: true,
  inWater: false,
  inLava: false,
}

function shellItems(): WorkItem[] {
  const items: WorkItem[] = []
  for (let x = -1; x <= 2; x += 1) {
    for (let y = 63; y <= 66; y += 1) {
      for (let z = -1; z <= 2; z += 1) {
        const inside = x >= 0 && x <= 1 && y >= 64 && y <= 65 && z >= 0 && z <= 1
        if (inside) continue
        items.push({
          id: `b:${x},${y},${z}`,
          kind: 'place',
          at: [x, y - 64, z],
          expected: { name: 'mystery_block' },
        })
      }
    }
  }
  return items
}

function template(items: WorkItem[]): PlanTemplate {
  return {
    id: 'room',
    version: 1,
    size: [2, 2, 2],
    materialPolicy: {},
    workItems: items,
    verify: { kind: 'sealed-room', min: [0, 0, 0], max: [1, 1, 1] },
  }
}

function world(): SnapshotWorld {
  const blocks: BlockInfo[] = []
  for (let x = -3; x <= 4; x += 1) {
    for (let z = -5; z <= 4; z += 1) {
      blocks.push({ name: 'stone', loaded: true, solid: true, pos: { x, y: 63, z } })
      blocks.push({ name: 'air', loaded: true, solid: false, pos: { x, y: 64, z } })
      blocks.push({ name: 'air', loaded: true, solid: false, pos: { x, y: 65, z } })
    }
  }
  return new SnapshotWorld({
    self,
    time: { timeOfDay: 1000, worldAge: 1 },
    entities: [],
    blocks,
    inventory: [],
  })
}

describe('build access planner', () => {
  it('derives a temporary two-cell entrance from geometry and work items', () => {
    const plan = instantiatePlan(template(shellItems()), 'ord-room', { x: 0, y: 64, z: 0 })
    const access = planBuildAccess(plan, world(), self.pos)
    expect(access.blocked).toBeUndefined()
    expect(access.deferred.size).toBe(2)
    expect([...access.deferred].every(id => id.startsWith('b:'))).toBe(true)
    expect(access.entrance?.feet.y).toBe(64)
    expect(access.entrance?.head.y).toBe(65)
  })

  it('does not defer when the entrance column is already air', () => {
    const items = shellItems().filter(item => {
      const [, y, z] = item.id.split(',')
      return !(item.id.startsWith('b:0,') && y === '64' && z === '-1')
        && !(item.id.startsWith('b:0,') && y === '65' && z === '-1')
    })
    const plan = instantiatePlan(template(items), 'ord-open', { x: 0, y: 64, z: 0 })
    const access = planBuildAccess(plan, world(), self.pos)
    expect(access.blocked).toBeUndefined()
    expect(access.deferred.size).toBe(0)
  })

  it('does not plan access for a plan without a verifier', () => {
    const plain = template(shellItems())
    delete plain.verify
    const plan = instantiatePlan(plain, 'ord-plain', { x: 0, y: 64, z: 0 })
    expect(planBuildAccess(plan, world(), self.pos)).toEqual({ deferred: new Set() })
  })

  it('works when a blueprint origin is the geometry corner, not the interior corner', () => {
    const blocks: Array<{ x: number; y: number; z: number; name: string; state?: Record<string, string> }> = []
    for (let x = -1; x <= 2; x += 1) {
      for (let y = 120; y <= 123; y += 1) {
        for (let z = -1; z <= 2; z += 1) {
          const inside = x >= 0 && x <= 1 && y >= 121 && y <= 122 && z >= 0 && z <= 1
          if (inside) continue
          const door = x === 0 && z === -1 && (y === 121 || y === 122)
          blocks.push({ x, y, z, name: door ? 'oak_door' : 'mystery_block' })
        }
      }
    }
    blocks.push({ x: 1, y: 121, z: 1, name: 'red_bed', state: { part: 'foot' } })
    blocks.push({ x: 1, y: 121, z: 0, name: 'red_bed', state: { part: 'head' } })
    blocks.push({ x: 0, y: 120, z: -2, name: 'mystery_block' })
    const parsed = parseBlueprint({
      blocks,
      verify: {
        kind: 'usable-room',
        min: { x: 0, y: 121, z: 0 },
        max: { x: 1, y: 122, z: 1 },
        door: { x: 0, y: 121, z: -1 },
        bed: { x: 1, y: 121, z: 1 },
      },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const plan = blueprintPlan(parsed.blueprint, 'ord-blueprint')
    const access = planBuildAccess(plan, world(), self.pos)
    expect(plan.origin).toEqual({ x: -1, y: 120, z: -2 })
    expect(access.blocked).toBeUndefined()
    // The door is one grouped work item (lower + upper), so deferring the
    // entrance defers that single item, not two independent placements.
    expect(access.deferred.size).toBe(1)
    expect([...access.deferred]).toEqual(['b:0,121,-1'])
    const door = plan.workItems.find(item => access.deferred.has(item.id))
    expect(door?.cells?.map(cell => cell.at)).toEqual([[1, 2, 1]])
    expect(access.entrance?.inside).toEqual({ x: 0, y: 121, z: 0 })
  })
})

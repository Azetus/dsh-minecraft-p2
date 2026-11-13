import { describe, expect, it } from 'vitest'

import { planSafeExits } from '../src/mind/build-access.ts'
import { createPlanGiver } from '../src/mind/givers/plan.ts'
import { instantiatePlan } from '../src/mind/plan.ts'
import type { PlanTemplate, WorkItem } from '../src/mind/plan.ts'
import { canReachSafeExit } from '../src/mind/placement.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { BlockInfo, Item, SelfInfo, Vec3 } from '../src/body/api.ts'

/**
 * Category: state safety (B1 build access).
 * Protects: a placement stance must be able to reach a frozen safe exit after
 * the trial cells are placed. This is the guard against wall-top/one-way
 * stances and against closing the last opening from inside.
 */

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`

function block(name: string, p: Vec3): BlockInfo {
  return { name, loaded: true, pos: p }
}

function self(pos: Vec3): SelfInfo {
  return {
    pos,
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    onGround: true,
    inWater: false,
    inLava: false,
  }
}

function world(blocks: BlockInfo[], pos: Vec3 = { x: 0.5, y: 64, z: 0.5 }, inventory: Item[] = []): SnapshotWorld {
  return new SnapshotWorld({
    self: self(pos),
    time: { timeOfDay: 1000, worldAge: 1 },
    entities: [],
    blocks,
    inventory,
  })
}

function flatFloor(minX: number, maxX: number, minZ: number, maxZ: number, top = 63): BlockInfo[] {
  const blocks: BlockInfo[] = []
  for (let x = minX; x <= maxX; x += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      blocks.push(block('stone', { x, y: top, z }))
      for (let y = top + 1; y <= top + 4; y += 1) blocks.push(block('air', { x, y, z }))
    }
  }
  return blocks
}

function template(workItems: WorkItem[]): PlanTemplate {
  return { id: 'p', version: 1, size: [3, 2, 3], materialPolicy: {}, workItems }
}

describe('build access', () => {
  it('excludes a blueprint cell from the safe exits and prefers exterior cells', () => {
    const plan = instantiatePlan(template([
      { id: 'under-body', kind: 'place', at: [0, 0, 0], expected: { name: 'dirt' } },
    ]), 'ord-1', { x: 0, y: 64, z: 0 })
    const w = world(flatFloor(-3, 3, -3, 3), { x: 0.5, y: 64, z: 0.5 })
    const exits = planSafeExits(plan, w, w.self.pos)
    expect(exits.length).toBeGreaterThan(0)
    expect(exits.some(exit => key(exit.cell) === '0,64,0')).toBe(false)
    expect(exits.some(exit => exit.exterior)).toBe(true)
  })

  it('rejects a stance that would close the last opening', () => {
    const blocks = flatFloor(-2, 2, -2, 2)
    // A 2-high 3x3 ring with one 2-high opening at (0,64,-1)/(0,65,-1);
    // the body is inside. A one-high ring could be jumped over.
    for (let y = 64; y <= 65; y += 1) {
      for (let x = -1; x <= 1; x += 1) {
        for (let z = -1; z <= 1; z += 1) {
          if (x === 0 && z === 0) continue
          if (x === 0 && z === -1) continue // the only opening
          blocks.push(block('stone', { x, y, z }))
        }
      }
    }
    const w = world(blocks, { x: 0.5, y: 64, z: 0.5 })
    const exits = [{ cell: { x: 0, y: 64, z: -2 }, exterior: true }]
    expect(canReachSafeExit(w, { x: 0, y: 64, z: 0 }, [], exits)).toBe('yes')
    expect(canReachSafeExit(w, { x: 0, y: 64, z: 0 }, [
      { x: 0, y: 64, z: -1 },
      { x: 0, y: 65, z: -1 },
    ], exits)).toBe('no')
  })

  it('does not offer a wall-top stance that cannot get down', () => {
    const blocks = flatFloor(-3, 3, -3, 3)
    blocks.push(block('stone', { x: 0, y: 64, z: 0 }))
    blocks.push(block('stone', { x: 0, y: 65, z: 0 }))
    blocks.push(block('stone', { x: 0, y: 66, z: 0 }))
    const w = world(blocks, { x: 0.5, y: 64, z: -1.5 }, [
      { slot: 36, name: 'dirt', count: 8 },
    ])
    const plan = instantiatePlan(template([
      { id: 'side', kind: 'place', at: [1, 2, 0], expected: { name: 'dirt' } },
    ]), 'ord-wall', { x: 0, y: 64, z: 0 })
    plan.safeExits = planSafeExits(plan, w, w.self.pos)
    expect(plan.safeExits.length).toBeGreaterThan(0)

    const result = createPlanGiver().find({ now: 0, plan }, w) as unknown as {
      driverId: string
      params: { stands?: Vec3[] }
    }
    expect(result.driverId).toBe('place')
    const stands = result.params.stands ?? []
    expect(stands.some(stand => stand.x === 0 && stand.y === 67 && stand.z === 0)).toBe(false)
    expect(canReachSafeExit(w, { x: 0, y: 67, z: 0 }, [{ x: 1, y: 66, z: 0 }], plan.safeExits))
      .not.toBe('yes')
  })
})

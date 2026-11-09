import { describe, expect, it } from 'vitest'

import { instantiatePlan } from '../src/mind/plan.ts'
import type { PlanTemplate } from '../src/mind/plan.ts'
import { verifyBlueprint } from '../src/mind/verify/blueprint.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { BlockInfo, SelfInfo } from '../src/body/api.ts'

/**
 * Category: data (M3-03 final geometry).
 * Protects: accepted placements are not assumed permanent; the final
 * verifier refutes a missing block and reports insufficient when unloaded.
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

const template: PlanTemplate = {
  id: 'blueprint',
  version: 1,
  size: [2, 1, 1],
  materialPolicy: {},
  workItems: [
    { id: 'a', kind: 'place', at: [0, 0, 0], expected: { name: 'dirt' } },
    { id: 'b', kind: 'place', at: [1, 0, 0], expected: { name: 'dirt' } },
  ],
}

const plan = instantiatePlan(template, 'ord-bp', { x: 0, y: 64, z: 0 })

function world(blocks: BlockInfo[]): SnapshotWorld {
  return new SnapshotWorld({
    self,
    time: { timeOfDay: 1000, worldAge: 1 },
    entities: [],
    blocks,
    inventory: [],
  })
}

const both = [
  { name: 'dirt', loaded: true, pos: { x: 0, y: 64, z: 0 } },
  { name: 'dirt', loaded: true, pos: { x: 1, y: 64, z: 0 } },
]

describe('blueprint verifier', () => {
  it('confirms when every expected block is still present', () => {
    expect(verifyBlueprint(plan, world(both)).state).toBe('confirmed')
  })

  it('refutes a block that was accepted but later disappeared', () => {
    const result = verifyBlueprint(plan, world([
      { name: 'dirt', loaded: true, pos: { x: 0, y: 64, z: 0 } },
      { name: 'air', loaded: true, pos: { x: 1, y: 64, z: 0 } },
    ]))
    expect(result.state).toBe('refuted')
    expect(result.at).toEqual({ x: 1, y: 64, z: 0 })
  })

  it('returns insufficient when a target is not loaded', () => {
    const result = verifyBlueprint(plan, world([
      { name: 'dirt', loaded: true, pos: { x: 0, y: 64, z: 0 } },
    ]))
    expect(result.state).toBe('insufficient')
  })
})

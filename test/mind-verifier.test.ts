import { describe, expect, it } from 'vitest'

import { instantiatePlan } from '../src/mind/plan.ts'
import type { PlanTemplate, VerifySpec } from '../src/mind/plan.ts'
import { verifySealedRoom } from '../src/mind/verify/sealed-room.ts'
import type { BlockInfo, SelfInfo } from '../src/body/api.ts'
import { SnapshotWorld } from '../src/mind/world.ts'

/**
 * Category: data/evidence (todo M2-04).
 * Protects: a hole is never confirmed, and an unloaded room is insufficient —
 * not a quiet success.
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
  id: 'room',
  version: 1,
  size: [3, 2, 3],
  materialPolicy: {},
  workItems: [{ id: 'w', kind: 'clear', at: [0, 0, 0] }],
  verify: { kind: 'sealed-room', min: [0, 0, 0], max: [2, 1, 2] },
}

const plan = instantiatePlan(template, 'ord-1', { x: 0, y: 64, z: 0 })
const spec: VerifySpec = template.verify ?? { kind: 'sealed-room', min: [0, 0, 0], max: [2, 1, 2] }

function roomBlocks(omit?: { x: number; y: number; z: number }): BlockInfo[] {
  const blocks: BlockInfo[] = []
  for (let x = -1; x <= 3; x += 1) {
    for (let y = 63; y <= 66; y += 1) {
      for (let z = -1; z <= 3; z += 1) {
        const interior = x >= 0 && x <= 2 && y >= 64 && y <= 65 && z >= 0 && z <= 2
        if (omit !== undefined && omit.x === x && omit.y === y && omit.z === z) continue
        blocks.push({ name: interior ? 'air' : 'stone', loaded: true, pos: { x, y, z } })
      }
    }
  }
  return blocks
}

function world(blocks: BlockInfo[]): SnapshotWorld {
  return new SnapshotWorld({
    self,
    time: { timeOfDay: 1000, worldAge: 1 },
    entities: [],
    blocks,
    inventory: [],
  })
}

describe('sealed-room verifier', () => {
  it('confirms a sealed 3x3x2 room', () => {
    expect(verifySealedRoom(plan, spec, world(roomBlocks()))).toEqual({ state: 'confirmed' })
  })

  it('refutes a one-block hole in the shell', () => {
    const blocks = roomBlocks()
    const index = blocks.findIndex(block => block.pos?.x === 0 && block.pos.y === 63 && block.pos.z === 0)
    blocks[index] = { name: 'air', loaded: true, pos: { x: 0, y: 63, z: 0 } }
    const result = verifySealedRoom(plan, spec, world(blocks))
    expect(result.state).toBe('refuted')
    expect(result.at).toEqual({ x: 0, y: 63, z: 0 })
  })

  it('refutes an obstructed interior', () => {
    const blocks = roomBlocks()
    const index = blocks.findIndex(block => block.pos?.x === 1 && block.pos.y === 64 && block.pos.z === 1)
    blocks[index] = { name: 'dirt', loaded: true, pos: { x: 1, y: 64, z: 1 } }
    expect(verifySealedRoom(plan, spec, world(blocks)).state).toBe('refuted')
  })

  it('returns insufficient for an unloaded shell cell', () => {
    const result = verifySealedRoom(plan, spec, world(roomBlocks({ x: 3, y: 64, z: 0 })))
    expect(result.state).toBe('insufficient')
  })
})


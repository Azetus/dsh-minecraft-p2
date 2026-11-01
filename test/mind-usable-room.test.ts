import { describe, expect, it } from 'vitest'

import { instantiatePlan } from '../src/mind/plan.ts'
import type { PlanTemplate } from '../src/mind/plan.ts'
import { verifyUsableRoom } from '../src/mind/verify/usable-room.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { BlockInfo, SelfInfo } from '../src/port/index.ts'

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
  workItems: [
    { id: 'door', kind: 'place', at: [1, 0, -1], expected: { name: 'oak_door' } },
    { id: 'bed', kind: 'place', at: [0, 0, 0], expected: { name: 'red_bed' } },
  ],
  verify: { kind: 'usable-room', min: [0, 0, 0], max: [2, 1, 2], door: [1, 0, -1], bed: [0, 0, 0] },
}

const plan = instantiatePlan(template, 'ord-room', { x: 0, y: 64, z: 0 })

function roomBlocks(): BlockInfo[] {
  const blocks: BlockInfo[] = []
  for (let x = -1; x <= 3; x += 1) {
    for (let y = 63; y <= 66; y += 1) {
      for (let z = -1; z <= 3; z += 1) {
        const interior = x >= 0 && x <= 2 && y >= 64 && y <= 65 && z >= 0 && z <= 2
        if (interior) blocks.push({ name: 'air', loaded: true, pos: { x, y, z } })
        else blocks.push({ name: 'stone', loaded: true, pos: { x, y, z } })
      }
    }
  }
  for (const at of [
    { x: 1, y: 64, z: -1 },
    { x: 1, y: 65, z: -1 },
    { x: 0, y: 64, z: 0 },
  ]) {
    const index = blocks.findIndex(block => block.pos?.x === at.x && block.pos.y === at.y && block.pos.z === at.z)
    if (index >= 0) blocks[index] = {
      name: at.x === 0 ? 'red_bed' : 'oak_door',
      loaded: true,
      pos: at,
    }
  }
  // Outside the door needs a floor and two air cells to stand.
  for (const at of [
    { x: 1, y: 63, z: -2 },
    { x: 1, y: 64, z: -2 },
    { x: 1, y: 65, z: -2 },
  ]) {
    const index = blocks.findIndex(block => block.pos?.x === at.x && block.pos.y === at.y && block.pos.z === at.z)
    const block = { name: at.y === 63 ? 'stone' : 'air', loaded: true, pos: at }
    if (index >= 0) blocks[index] = block
    else blocks.push(block)
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

describe('usable-room verifier', () => {
  it('confirms a room with a door, standable floor and usable bed', () => {
    const result = verifyUsableRoom(plan, template.verify as Extract<typeof template.verify, { kind: 'usable-room' }>, world(roomBlocks()))
    expect(result).toEqual({ state: 'confirmed' })
  })

  it('refutes a missing entrance door', () => {
    const blocks = roomBlocks().map(block => block.pos?.x === 1 && block.pos?.z === -1 && block.pos.y >= 64
      ? { ...block, name: 'air' }
      : block)
    const result = verifyUsableRoom(plan, template.verify as Extract<typeof template.verify, { kind: 'usable-room' }>, world(blocks))
    expect(result.state).toBe('refuted')
    expect(result.detail).toContain('door')
    expect(result.workItemId).toBe('door')
  })

  it('refutes a sealed shell with no opening', () => {
    const blocks = roomBlocks().map(block => block.name === 'oak_door' ? { ...block, name: 'stone' } : block)
    const result = verifyUsableRoom(plan, template.verify as Extract<typeof template.verify, { kind: 'usable-room' }>, world(blocks))
    expect(result.state).toBe('refuted')
    expect(result.detail).toContain('door')
  })
})

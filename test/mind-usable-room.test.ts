import { describe, expect, it } from 'vitest'

import { instantiatePlan } from '../src/mind/plan.ts'
import type { PlanTemplate } from '../src/mind/plan.ts'
import { verifyUsableRoom } from '../src/mind/verify/usable-room.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { BlockInfo, SelfInfo } from '../src/body/api.ts'

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

/**
 * A door and a bed are one two-cell placement each. The template declares both
 * cells; the verifier's `door`/`bed` anchor is the lower/foot cell.
 */
const template: PlanTemplate = {
  id: 'room',
  version: 1,
  size: [3, 2, 3],
  materialPolicy: {},
  workItems: [
    {
      id: 'door',
      kind: 'place',
      at: [1, 0, -1],
      expected: { name: 'oak_door', state: { half: 'lower' } },
      cells: [{ at: [1, 1, -1], expected: { name: 'oak_door', state: { half: 'upper' } } }],
    },
    {
      id: 'bed',
      kind: 'place',
      at: [0, 0, 2],
      expected: { name: 'red_bed', state: { part: 'foot' } },
      cells: [{ at: [1, 0, 2], expected: { name: 'red_bed', state: { part: 'head' } } }],
    },
  ],
  verify: { kind: 'usable-room', min: [0, 0, 0], max: [2, 1, 2], door: [1, 0, -1], bed: [0, 0, 2] },
}

const plan = instantiatePlan(template, 'ord-room', { x: 0, y: 64, z: 0 })
const spec = template.verify as Extract<typeof template.verify, { kind: 'usable-room' }>

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
  const set = (at: { x: number; y: number; z: number }, name: string, state?: Record<string, string>): void => {
    const index = blocks.findIndex(block => block.pos?.x === at.x && block.pos.y === at.y && block.pos.z === at.z)
    const block: BlockInfo = { name, loaded: true, pos: at, ...(state === undefined ? {} : { state }) }
    if (index >= 0) blocks[index] = block
    else blocks.push(block)
  }
  set({ x: 1, y: 64, z: -1 }, 'oak_door', { half: 'lower', facing: 'north', open: 'false' })
  set({ x: 1, y: 65, z: -1 }, 'oak_door', { half: 'upper', facing: 'north', open: 'false' })
  set({ x: 0, y: 64, z: 2 }, 'red_bed', { part: 'foot', facing: 'south' })
  set({ x: 1, y: 64, z: 2 }, 'red_bed', { part: 'head', facing: 'south' })
  // Outside the door needs a floor and two air cells to stand.
  for (const at of [
    { x: 1, y: 63, z: -2 },
    { x: 1, y: 64, z: -2 },
    { x: 1, y: 65, z: -2 },
  ]) {
    set(at, at.y === 63 ? 'stone' : 'air')
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

function withoutState(block: BlockInfo): BlockInfo {
  const { state: _state, ...rest } = block
  return rest
}

describe('usable-room verifier', () => {
  it('confirms a room with a two-cell door, standable floor and usable bed', () => {
    const result = verifyUsableRoom(plan, spec, world(roomBlocks()))
    expect(result).toEqual({ state: 'confirmed' })
  })

  it('refutes a missing entrance door', () => {
    const blocks = roomBlocks().map(block => block.pos?.x === 1 && block.pos?.z === -1 && block.pos.y >= 64
      ? { ...block, name: 'air' }
      : block)
    const result = verifyUsableRoom(plan, spec, world(blocks))
    expect(result.state).toBe('refuted')
    expect(result.detail).toContain('door')
    expect(result.workItemId).toBe('door')
  })

  it('refutes a sealed shell with no opening', () => {
    const blocks = roomBlocks().map(block => block.name === 'oak_door' ? { ...block, name: 'stone' } : block)
    const result = verifyUsableRoom(plan, spec, world(blocks))
    expect(result.state).toBe('refuted')
    expect(result.detail).toContain('door')
  })

  it('refutes a door whose halves or facing disagree', () => {
    const blocks = roomBlocks().map(block => block.pos?.x === 1 && block.pos?.z === -1 && block.pos.y === 65
      ? { ...block, state: { half: 'upper', facing: 'south', open: 'false' } }
      : block)
    const result = verifyUsableRoom(plan, spec, world(blocks))
    expect(result.state).toBe('refuted')
    expect(result.detail).toContain('facing')
  })

  it('reports missing block state as insufficient, not a pass', () => {
    const blocks = roomBlocks().map(block => block.name === 'red_bed' ? withoutState(block) : block)
    const result = verifyUsableRoom(plan, spec, world(blocks))
    expect(result.state).toBe('insufficient')
    expect(result.detail).toContain('part')
  })

  it('refutes a bed whose head cell is still air', () => {
    const blocks = roomBlocks().map(block => block.pos?.x === 1 && block.pos?.z === 2 && block.pos.y === 64
      ? { name: 'air', loaded: true, pos: block.pos }
      : block)
    const result = verifyUsableRoom(plan, spec, world(blocks))
    expect(result.state).toBe('refuted')
    expect(result.detail).toContain('bed')
  })

  it('refutes a bed without head space', () => {
    const blocks = roomBlocks().map(block => block.pos?.x === 1 && block.pos?.z === 2 && block.pos.y === 65
      ? { ...block, name: 'stone' }
      : block)
    const result = verifyUsableRoom(plan, spec, world(blocks))
    expect(result.state).toBe('refuted')
    expect(result.detail).toContain('head space')
  })
})

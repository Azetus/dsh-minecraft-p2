import { describe, expect, it } from 'vitest'

import { AreaResourceIndex } from '../src/mind/area.ts'
import { createMaterialGiver } from '../src/mind/givers/material.ts'
import { materialSources, planShortage } from '../src/mind/materials.ts'
import { instantiatePlan } from '../src/mind/plan.ts'
import type { PlanTemplate } from '../src/mind/plan.ts'
import type { EvalCtx } from '../src/mind/types.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { BlockInfo, Box, ClientPort, Item, SelfInfo, Vec3 } from '../src/port/index.ts'

/**
 * Category: cross-module contract (M3-03 material policy).
 * Protects: BOM shortfall, source mapping, and that auto-gather only selects
 * a source; it never bypasses the material ledger or invents items.
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

const plan = instantiatePlan(template, 'ord-mat', { x: 0, y: 64, z: 0 })

function world(options: { blocks?: BlockInfo[]; inventory?: Item[] } = {}): SnapshotWorld {
  return new SnapshotWorld({
    self,
    time: { timeOfDay: 1000, worldAge: 1 },
    entities: [],
    blocks: options.blocks ?? [],
    inventory: options.inventory ?? [],
  })
}

describe('material shortage', () => {
  it('subtracts satisfied blocks and inventory', () => {
    const shortage = planShortage(plan, world({
      blocks: [
        { name: 'dirt', loaded: true, pos: { x: 0, y: 64, z: 0 } },
        { name: 'air', loaded: true, pos: { x: 1, y: 64, z: 0 } },
      ],
      inventory: [{ slot: 36, name: 'dirt', count: 1 }],
    }))
    expect(shortage.required).toEqual({ dirt: 2 })
    expect(shortage.needed).toEqual({ dirt: 1 })
    expect(shortage.missing).toEqual({})
  })

  it('reports a real deficit', () => {
    const shortage = planShortage(plan, world())
    expect(shortage.missing).toEqual({ dirt: 2 })
  })

  it('maps only explicitly supported sources', () => {
    expect(materialSources('dirt')).toContain('grass_block')
    expect(materialSources('minecraft:oak_log')).toContain('oak_log')
    expect(materialSources('oak_door')).toEqual([])
  })
})

describe('material giver', () => {
  it('selects a nearby source block when auto-gather is enabled', () => {
    const ctx: EvalCtx = { now: 0, plan, materialPolicy: { mode: 'auto-gather' } }
    const result = createMaterialGiver().find(ctx, world({
      blocks: [
        { name: 'grass_block', loaded: true, pos: { x: 2, y: 64, z: 0 } },
        { name: 'air', loaded: true, pos: { x: 0, y: 64, z: 0 } },
        { name: 'air', loaded: true, pos: { x: 1, y: 64, z: 0 } },
      ],
    })) as unknown as { driverId: string; keys: string; params: { x: number; y: number; z: number } }
    expect(result.driverId).toBe('clear')
    expect(result.keys).toContain('gather:dirt')
    expect(result.params).toEqual({ x: 2, y: 64, z: 0 })
  })

  it('does nothing for require-all or a non-source item', () => {
    expect(createMaterialGiver().find({ now: 0, plan, materialPolicy: { mode: 'require-all' } }, world({
      blocks: [{ name: 'grass_block', loaded: true, pos: { x: 2, y: 64, z: 0 } }],
    }))).toBeNull()

    const doorPlan = instantiatePlan({
      ...template,
      workItems: [{ id: 'door', kind: 'place', at: [0, 0, 0], expected: { name: 'oak_door' } }],
    }, 'ord-door', { x: 0, y: 64, z: 0 })
    expect(createMaterialGiver().find({
      now: 0,
      plan: doorPlan,
      materialPolicy: { mode: 'auto-gather' },
    }, world({ blocks: [{ name: 'oak_log', loaded: true, pos: { x: 2, y: 64, z: 0 } }] }))).toBeNull()
  })

  it('stops at the auto-gather budget', () => {
    const result = createMaterialGiver().find({
      now: 0,
      plan,
      materialPolicy: { mode: 'auto-gather', maxGatherBlocks: 2 },
      gatherCount: 2,
    }, world({
      blocks: [{ name: 'grass_block', loaded: true, pos: { x: 2, y: 64, z: 0 } }],
    }))
    expect(result).toBeNull()
  })

  it('finds a source beyond the 6-block snapshot through the area index', () => {
    const source = { name: 'grass_block', loaded: true, pos: { x: 20, y: 64, z: 0 } }
    const port = {
      blocksIn: (box: Box) => [source, { name: 'stone', loaded: true, pos: { x: 30, y: 64, z: 0 } }]
        .filter(block => inside(block.pos, box)) as BlockInfo[],
    } as unknown as ClientPort
    const area = new AreaResourceIndex(port, { radius: 32, vertical: 8, chunkBudget: 4 })
    const giver = createMaterialGiver(area)
    let result: unknown = null
    for (let now = 0; now < 20 && result === null; now += 1) {
      result = giver.find({ now, plan, materialPolicy: { mode: 'auto-gather' } }, world())
    }
    expect(result).toMatchObject({
      driverId: 'move',
      reason: 'gather dirt',
      target: { kind: 'point', pos: source.pos },
    })
  })
})

function inside(point: Vec3, box: Box): boolean {
  return point.x >= box.min.x && point.x <= box.max.x
    && point.y >= box.min.y && point.y <= box.max.y
    && point.z >= box.min.z && point.z <= box.max.z
}

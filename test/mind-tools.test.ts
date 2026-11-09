import { describe, expect, it } from 'vitest'

import { chooseTool, chooseWeapon } from '../src/mind/tools.ts'
import type { BlockInfo, Item } from '../src/body/api.ts'

const pickaxes: Item[] = [
  { slot: 36, name: 'wooden_pickaxe', count: 1 },
  { slot: 37, name: 'stone_pickaxe', count: 1 },
  { slot: 38, name: 'diamond_pickaxe', count: 1 },
]

function stone(overrides: Partial<BlockInfo> = {}): BlockInfo {
  return {
    name: 'stone',
    loaded: true,
    material: 'mineable/pickaxe',
    diggable: true,
    hardness: 1.5,
    harvestTools: ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe', 'golden_pickaxe'],
    ...overrides,
  }
}

describe('weapon selection', () => {
  it('prefers the highest-tier sword, then axe, and ignores non-melee items', () => {
    expect(chooseWeapon([
      { slot: 36, name: 'wooden_sword', count: 1 },
      { slot: 37, name: 'diamond_axe', count: 1 },
      { slot: 38, name: 'iron_sword', count: 1 },
      { slot: 39, name: 'netherite_sword', count: 1 },
      { slot: 40, name: 'bow', count: 1 },
    ])).toBe('netherite_sword')
    expect(chooseWeapon([{ slot: 36, name: 'stone_axe', count: 1 }])).toBe('stone_axe')
    expect(chooseWeapon([{ slot: 36, name: 'bow', count: 1 }])).toBeUndefined()
    expect(chooseWeapon([])).toBeUndefined()
  })
})

describe('tool selection', () => {
  it('picks the highest-tier allowed tool', () => {
    expect(chooseTool(stone(), pickaxes, 'harvest')).toEqual({ item: 'diamond_pickaxe' })
  })

  it('fails harvest when no allowed tool is present', () => {
    expect(chooseTool(stone(), [{ slot: 36, name: 'iron_axe', count: 1 }], 'harvest'))
      .toEqual({ error: 'TOOL_INSUFFICIENT' })
  })

  it('lets clear fall back to the hand without an allowed tool', () => {
    expect(chooseTool(stone(), [{ slot: 36, name: 'iron_axe', count: 1 }], 'clear')).toEqual({})
  })

  it('uses hand when the harvest set is empty', () => {
    expect(chooseTool(stone({ name: 'dirt', material: 'mineable/shovel', harvestTools: [] }), [], 'harvest')).toEqual({})
  })

  it('refuses an unbreakable block', () => {
    expect(chooseTool(stone({ name: 'bedrock', diggable: false }), pickaxes, 'clear'))
      .toEqual({ error: 'BLOCK_UNBREAKABLE' })
  })

  it('uses a matching class for speed when harvest metadata is absent', () => {
    const unknown = stone({ name: 'modded_stone' })
    delete unknown.harvestTools
    expect(chooseTool(unknown, [{ slot: 36, name: 'stone_pickaxe', count: 1 }], 'harvest'))
      .toEqual({ item: 'stone_pickaxe' })
    expect(chooseTool(unknown, [], 'harvest')).toEqual({})
  })
})

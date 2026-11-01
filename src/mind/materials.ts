import type { PlanInstance } from './plan.ts'
import { countItem, itemPosition, matchesExpected } from './plan.ts'
import type { WorldView } from './types.ts'

export type MaterialShortage = {
  required: Record<string, number>
  needed: Record<string, number>
  missing: Record<string, number>
}

/**
 * Bill of materials for a plan against one snapshot. Already-satisfied blocks
 * need no material; unknown cells are counted as needed (conservative).
 */
export function planShortage(plan: PlanInstance, world: WorldView): MaterialShortage {
  const required: Record<string, number> = {}
  const needed: Record<string, number> = {}
  for (const item of plan.workItems) {
    if (item.expected === undefined) continue
    const name = item.expected.name
    required[name] = (required[name] ?? 0) + 1
    const block = world.blockAt(itemPosition(plan, item))
    if (block !== null && block.loaded && matchesExpected(block, item.expected)) continue
    needed[name] = (needed[name] ?? 0) + 1
  }
  const missing: Record<string, number> = {}
  for (const [name, count] of Object.entries(needed)) {
    const shortage = count - countItem(world.inventory, name)
    if (shortage > 0) missing[name] = shortage
  }
  return { required, needed, missing }
}

/**
 * Material sources P2Mind may dig for. Entries are deliberately explicit:
 * crafting and non-obtainable items (e.g. doors) have no source and therefore
 * remain blocked when auto-gather is requested.
 */
const SOURCES: Record<string, string[]> = {
  dirt: ['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt'],
  grass_block: ['grass_block'],
  cobblestone: ['stone', 'cobblestone'],
  sand: ['sand', 'red_sand'],
  gravel: ['gravel'],
  clay_ball: ['clay'],
  oak_log: ['oak_log', 'oak_wood', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'],
  oak_planks: ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  raw_iron: ['iron_ore', 'deepslate_iron_ore'],
  raw_copper: ['copper_ore', 'deepslate_copper_ore'],
}

export function materialSources(item: string): string[] {
  return SOURCES[item.replace(/^minecraft:/u, '')] ?? []
}

/** Every block name the area index needs to retain. */
export function sourceNames(): string[] {
  return [...new Set(Object.values(SOURCES).flat())]
}

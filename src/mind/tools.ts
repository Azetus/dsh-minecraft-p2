import type { BlockInfo, Item } from '../body/api.ts'

export type DigPurpose = 'clear' | 'harvest'

export type ToolChoice = {
  /** Item to equip before the action; absent means hand/current item. */
  item?: string
  error?: 'TOOL_INSUFFICIENT' | 'BLOCK_UNBREAKABLE'
}

const TOOL_RANK: Record<string, number> = {
  netherite: 6,
  diamond: 5,
  iron: 4,
  stone: 3,
  golden: 2,
  gold: 2,
  wooden: 1,
  wood: 1,
}

const MATERIAL_TOOL: Record<string, string> = {
  'mineable/pickaxe': 'pickaxe',
  'mineable/axe': 'axe',
  'mineable/shovel': 'shovel',
  'mineable/hoe': 'hoe',
  'mineable/shears': 'shears',
  'mineable/sword': 'sword',
}

/**
 * Pick the strongest held-item weapon for melee. Swords beat axes at the same
 * tier; bows/crossbows are not selected because the attack driver only swings.
 */
export function chooseWeapon(inventory: Item[]): string | undefined {
  let best: string | undefined
  let bestScore = -1
  for (const item of inventory) {
    const name = normalize(item.name)
    const weaponClass = name.endsWith('_sword')
      ? 3
      : name.endsWith('_axe') ? 2 : undefined
    if (weaponClass === undefined) continue
    const score = rank(name) * 10 + weaponClass
    if (score > bestScore) {
      best = name
      bestScore = score
    }
  }
  return best
}

/**
 * Choose a held item for one already-selected block. `harvest` must have an
 * allowed tool when the adapter reports a non-empty harvest set; `clear` may
 * fall back to the hand because it only needs the block gone.
 *
 * The driver never picks a different target here.
 */
export function chooseTool(block: BlockInfo, inventory: Item[], purpose: DigPurpose): ToolChoice {
  if (block.diggable === false) return { error: 'BLOCK_UNBREAKABLE' }

  const required = block.harvestTools
  if (required !== undefined && required.length > 0) {
    const allowed = required.map(normalize)
    const available = inventory.filter(item => allowed.includes(normalize(item.name)))
    if (available.length === 0) {
      return purpose === 'harvest' ? { error: 'TOOL_INSUFFICIENT' } : {}
    }
    return { item: bestTool(available) }
  }

  // No authoritative harvest set: use a matching class for speed if present,
  // but do not forbid the hand. The provider's dig result remains the evidence.
  const toolClass = block.material === undefined ? undefined : MATERIAL_TOOL[block.material]
  if (toolClass === undefined) return {}
  const matching = inventory.filter(item => {
    const name = normalize(item.name)
    return name.endsWith(`_${toolClass}`) || name === toolClass
  })
  return matching.length === 0 ? {} : { item: bestTool(matching) }
}

function bestTool(items: Item[]): string {
  let best = normalize(items[0]?.name ?? '')
  let bestRank = rank(best)
  for (const item of items.slice(1)) {
    const name = normalize(item.name)
    const value = rank(name)
    if (value > bestRank) {
      best = name
      bestRank = value
    }
  }
  return best
}

function rank(name: string): number {
  const prefix = name.split('_')[0] ?? ''
  return TOOL_RANK[prefix] ?? 0
}

function normalize(name: string): string {
  return name.replace(/^minecraft:/u, '')
}

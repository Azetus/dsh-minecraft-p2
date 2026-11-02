import type { BlockClassifier, BlockTag, RawBlock } from '../types.ts'

/**
 * The one place that knows vanilla block names. Rules never import this table;
 * they consume its tags. Replacing the classifier (another content set, a
 * server with different blocks) requires no rule or planner change.
 *
 * Collision geometry is deliberately not produced here: it always comes from
 * the adapter's block state, so a classifier cannot turn a solid block into air.
 */

export const HAZARD_NAMES: ReadonlySet<string> = new Set([
  'lava',
  'fire',
  'soul_fire',
  'magma_block',
  'cactus',
  'sweet_berry_bush',
  'campfire',
  'soul_campfire',
  'powder_snow',
  'wither_rose',
  'nether_portal',
  'end_portal',
  'pointed_dripstone',
])

export const CLIMBABLE: ReadonlySet<string> = new Set([
  'ladder',
  'vine',
  'scaffolding',
  'twisting_vines',
  'twisting_vines_plant',
  'weeping_vines',
  'weeping_vines_plant',
  'cave_vines',
  'cave_vines_plant',
])

export const REPLACEABLE: ReadonlySet<string> = new Set([
  'air',
  'cave_air',
  'void_air',
  'water',
  'lava',
  'short_grass',
  'tall_grass',
  'fern',
  'large_fern',
  'dead_bush',
  'bush',
  'snow',
  'fire',
  'soul_fire',
  'light',
  'structure_void',
  'seagrass',
  'tall_seagrass',
  'kelp',
  'kelp_plant',
  'sugar_cane',
  'wheat',
  'carrots',
  'potatoes',
  'beetroots',
])

export const LIQUIDS: ReadonlySet<string> = new Set(['water', 'bubble_column'])

export const AIR_NAMES: ReadonlySet<string> = new Set(['air', 'cave_air', 'void_air'])

/** Legacy geometry fallback only for adapters that omit collision shapes. */
export const LEGACY_SOLID_NAMES: ReadonlySet<string> = new Set([
  'stone', 'dirt', 'grass_block', 'cobblestone', 'deepslate', 'sand', 'gravel',
])

export function isLegacySolidName(name: string): boolean {
  return LEGACY_SOLID_NAMES.has(name) || /_(planks|log)$/u.test(name)
}

function canonical(name: string): string {
  return name.replace(/^minecraft:/u, '')
}

/**
 * Tag-first vanilla semantics. Server block tags are authoritative when
 * present; the small name tables are the offline / tags-not-ready fallback and
 * cover categories tags do not express (hazards, iron locks, magma).
 */
export const vanillaClassifier: BlockClassifier = {
  classify(block: RawBlock): readonly BlockTag[] {
    const name = canonical(block.name)
    const tags: BlockTag[] = []
    const server = block.serverTags
    const tagsKnown = server !== undefined
    const has = (tag: string): boolean => server?.has(`minecraft:${tag}`) === true || server?.has(tag) === true

    if (tagsKnown ? has('replaceable') || AIR_NAMES.has(name) : REPLACEABLE.has(name)) tags.push('replaceable')
    if (LIQUIDS.has(name)) tags.push('water')
    if (name === 'lava') tags.push('lava')
    if (has('fire') || has('campfires') || HAZARD_NAMES.has(name) || name.endsWith('_fire')) tags.push('hazard')
    if (name === 'magma_block') tags.push('magma')
    if (tagsKnown ? has('climbable') : CLIMBABLE.has(name)) tags.push('climbable')

    const isDoor = tagsKnown ? has('doors') : name.endsWith('_door')
    if (isDoor) {
      tags.push('door')
      const openable = tagsKnown
        ? has('mob_interactable_doors') || has('wooden_doors')
        : name !== 'iron_door'
      tags.push(openable ? 'openable' : 'locked')
    }
    const isGate = tagsKnown ? has('fence_gates') : name.endsWith('_fence_gate')
    if (isGate) tags.push('gate', 'openable')

    if (block.collision !== undefined && block.collision.length > 0) tags.push('solid')
    return tags
  },
}

export function vanillaTags(name: string): readonly BlockTag[] {
  return vanillaClassifier.classify({ loaded: true, name, state: {}, collision: [] })
}

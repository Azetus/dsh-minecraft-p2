import type { BlockClassifier, BlockTag, RawBlock } from '../types.ts'

/**
 * The one place that knows vanilla block names. Rules never import this table;
 * they consume its tags. Replacing the classifier (another content set, a
 * server with different blocks) requires no rule or planner change.
 *
 * Collision geometry is deliberately not produced here: it always comes from
 * the adapter's block state, so a classifier cannot turn a solid block into air.
 */

const HAZARDS: ReadonlySet<string> = new Set([
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

const CLIMBABLE: ReadonlySet<string> = new Set([
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

const REPLACEABLE: ReadonlySet<string> = new Set([
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

const LIQUIDS: ReadonlySet<string> = new Set(['water', 'bubble_column'])

function canonical(name: string): string {
  return name.replace(/^minecraft:/u, '')
}

export const vanillaClassifier: BlockClassifier = {
  classify(block: RawBlock): readonly BlockTag[] {
    const name = canonical(block.name)
    const tags: BlockTag[] = []
    if (REPLACEABLE.has(name)) tags.push('replaceable')
    if (LIQUIDS.has(name)) tags.push('water')
    if (name === 'lava') tags.push('lava')
    if (HAZARDS.has(name) || name.endsWith('_fire')) tags.push('hazard')
    if (name === 'magma_block') tags.push('magma')
    if (CLIMBABLE.has(name)) tags.push('climbable')
    if (name.endsWith('_door')) {
      tags.push('door')
      // Iron doors need redstone; wooden and copper doors open by hand.
      if (name === 'iron_door') tags.push('locked')
      else tags.push('openable')
    }
    if (name.endsWith('_fence_gate')) tags.push('gate', 'openable')
    if (block.collision !== undefined && block.collision.length > 0) tags.push('solid')
    return tags
  },
}

export function vanillaTags(name: string): readonly BlockTag[] {
  return vanillaClassifier.classify({ loaded: true, name, state: {}, collision: [] })
}

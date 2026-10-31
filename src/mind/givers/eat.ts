import type { WorkGiver } from '../types.ts'
import type { Candidate, EvalCtx, WorldView } from '../types.ts'

const FOOD_NAMES = new Set([
  'apple',
  'baked_potato',
  'beef',
  'bread',
  'carrot',
  'cooked_beef',
  'cooked_chicken',
  'cooked_cod',
  'cooked_mutton',
  'cooked_porkchop',
  'cooked_rabbit',
  'cooked_salmon',
  'cookie',
  'golden_apple',
  'golden_carrot',
  'melon_slice',
  'mushroom_stew',
  'potato',
  'pumpkin_pie',
  'rabbit_stew',
  'sweet_berries',
])

/** Eat before the body gets too hungry; this only selects a food item. */
export function createEatGiver(options: { threshold?: number } = {}): WorkGiver {
  const threshold = options.threshold ?? 14
  return {
    id: 'eat',
    find(_ctx: EvalCtx, world: WorldView): Candidate | null {
      if (world.self.food >= threshold) return null
      const food = world.inventory.find(item => FOOD_NAMES.has(item.name.replace(/^minecraft:/u, '')))
      if (food === undefined) return null
      return {
        driverId: 'eat',
        target: { kind: 'point', pos: world.self.pos },
        params: { item: food.name, durationMs: 1_800 },
        keys: `eat:${food.name}`,
      }
    },
  }
}

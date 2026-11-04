import type { ReactionPolicy } from '../reaction-policy.ts'
import { normalizeName } from '../reaction-policy.ts'
import { feetOf, hostilesNear, nearestStandable } from './common.ts'
import type { Candidate, EvalCtx, WorkGiver, WorkGiverResult, WorldView } from '../types.ts'

const FOOD_NAMES: ReadonlySet<string> = new Set([
  'apple', 'baked_potato', 'beetroot', 'beetroot_soup', 'bread', 'carrot',
  'cooked_beef', 'cooked_chicken', 'cooked_cod', 'cooked_mutton', 'cooked_porkchop',
  'cooked_rabbit', 'cooked_salmon', 'cookie', 'dried_kelp', 'glow_berries',
  'golden_apple', 'golden_carrot', 'honey_bottle', 'melon_slice', 'mushroom_stew',
  'potato', 'pumpkin_pie', 'rabbit_stew', 'sweet_berries', 'beef', 'chicken',
  'cod', 'mutton', 'porkchop', 'rabbit', 'salmon',
])

const UNSTUCK_RECENT_MS = 8_000
const UNSTUCK_COOLDOWN_MS = 10_000

export function createSelfEatGiver(policy: () => ReactionPolicy): WorkGiver {
  return {
    id: 'self.eat',
    find(ctx: EvalCtx, world: WorldView): WorkGiverResult {
      if (ctx.orderVerb === 'attack') return null
      const eat = policy().selfCare.eat
      if (!eat.enabled) return null
      if (world.self.food > eat.foodBelow) return null
      if (inImmediateDanger(world)) return null
      const food = world.inventory
        .filter(item => FOOD_NAMES.has(normalizeName(item.name)))
        .sort((left, right) => right.count - left.count)[0]
      if (food === undefined) return null
      const item = normalizeName(food.name)
      const keys = `self:eat:${item}`
      if (ctx.isBlocked?.(keys) === true) return null
      return {
        driverId: 'use',
        target: { kind: 'point', pos: world.self.pos },
        params: { item },
        keys,
      }
    },
  }
}

export function createSelfUnstuckGiver(policy: () => ReactionPolicy): WorkGiver {
  let nextAt = 0
  let seq = 0
  return {
    id: 'self.unstuck',
    find(ctx: EvalCtx, world: WorldView): WorkGiverResult {
      if (ctx.orderVerb === 'attack') return null
      if (!policy().selfCare.unstuck.enabled) return null
      if (ctx.lastStuckAt === undefined || ctx.now - ctx.lastStuckAt > UNSTUCK_RECENT_MS) return null
      if (ctx.now < nextAt) return null
      if (inImmediateDanger(world)) return null
      const feet = feetOf(world.self.pos)
      const target = nearestStandable(world, feet, 3, feet, 2, feet)
      nextAt = ctx.now + UNSTUCK_COOLDOWN_MS
      if (target === undefined) {
        return { kind: 'hold', reason: 'SELF_STUCK', notify: true }
      }
      seq += 1
      return {
        driverId: 'move',
        target: { kind: 'point', pos: target },
        params: { x: target.x, y: target.y, z: target.z, range: 0, timeoutMs: 4_000 },
        keys: `self:unstuck:${seq}`,
      }
    },
  }
}

function inImmediateDanger(world: WorldView): boolean {
  const self = world.self
  if (self.inLava) return true
  if (self.inWater && !self.onGround) return true
  return hostilesNear(world, self.pos, 6).length > 0
}

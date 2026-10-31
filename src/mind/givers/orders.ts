import type { JsonValue } from '../../contracts/types.ts'
import type { Candidate, EvalCtx, WorkGiver, WorldView } from '../types.ts'

type OrderView = {
  order: { id: string; verb: string; params?: Record<string, JsonValue> }
}

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

function positionOf(params: Record<string, JsonValue> | undefined): { x: number; y: number; z: number } | undefined {
  if (params === undefined) return undefined
  if (typeof params.x !== 'number' || typeof params.y !== 'number' || typeof params.z !== 'number') return undefined
  if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) return undefined
  return { x: Math.floor(params.x), y: Math.floor(params.y), z: Math.floor(params.z) }
}

function activeOrder(active: () => OrderView | undefined, verb: string): OrderView | undefined {
  const current = active()
  return current?.order.verb === verb ? current : undefined
}

/** Explicit `go` order: one move to the Agent-selected coordinate. */
export function createGoOrderGiver(active: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.go',
    find(_ctx: EvalCtx, _world: WorldView): Candidate | null {
      const current = activeOrder(active, 'go')
      if (current === undefined) return null
      const pos = positionOf(current.order.params)
      if (pos === undefined) return null
      return {
        driverId: 'move',
        target: { kind: 'point', pos },
        params: { x: pos.x, y: pos.y, z: pos.z, range: 1, timeoutMs: 30_000 },
        keys: `order.go:${current.order.id}`,
      }
    },
  }
}

/** Explicit `sleep` order: move near the bed; the sleep driver uses it. */
export function createSleepOrderGiver(active: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.sleep',
    find(_ctx: EvalCtx, _world: WorldView): Candidate | null {
      const current = activeOrder(active, 'sleep')
      if (current === undefined) return null
      const pos = positionOf(current.order.params)
      if (pos === undefined) return null
      return {
        driverId: 'sleep',
        target: { kind: 'point', pos },
        params: { x: pos.x, y: pos.y, z: pos.z },
        keys: `order.sleep:${current.order.id}`,
      }
    },
  }
}

/** Explicit `eat` order: choose requested food, else any food in inventory. */
export function createEatOrderGiver(active: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.eat',
    find(_ctx: EvalCtx, world: WorldView): Candidate | null {
      const current = activeOrder(active, 'eat')
      if (current === undefined) return null
      const requested = current.order.params?.item
      const food = typeof requested === 'string'
        ? world.inventory.find(item => item.name === requested)
        : world.inventory.find(item => FOOD_NAMES.has(item.name.replace(/^minecraft:/u, '')))
      if (food === undefined) return null
      return {
        driverId: 'eat',
        target: { kind: 'point', pos: world.self.pos },
        params: { item: food.name, durationMs: 1_800 },
        keys: `order.eat:${current.order.id}`,
      }
    },
  }
}

/** Explicit `wander` order: one bounded move chosen by the giver. */
export function createWanderOrderGiver(
  active: () => OrderView | undefined,
  wander: WorkGiver,
): WorkGiver {
  let held: { orderId: string; candidate: Candidate } | undefined
  return {
    id: 'order.wander',
    find(ctx: EvalCtx, world: WorldView): Candidate | null {
      const current = activeOrder(active, 'wander')
      if (current === undefined) return null
      if (held?.orderId === current.order.id) return held.candidate
      const candidate = wander.find(ctx, world)
      if (candidate === null || 'reason' in candidate) return null
      held = { orderId: current.order.id, candidate }
      return candidate
    },
  }
}

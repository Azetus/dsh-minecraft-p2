import type { JsonValue } from '../../contracts/types.ts'
import { boxAround } from '../sensors.ts'
import type { EvalCtx, WorkGiver, WorkGiverResult, WorldView } from '../types.ts'

type OrderView = {
  order: { id: string; verb: string; params?: Record<string, JsonValue> }
}

function activeOrder(active: () => OrderView | undefined, verb: string): OrderView | undefined {
  const current = active()
  return current?.order.verb === verb ? current : undefined
}

/**
 * Explicit `attack` order: exactly the Agent-named entity, no acquisition.
 * P2 never applies its own protection filter here; target choice belongs to
 * the Agent. The giver performs a bounded targeted entity observation so an
 * explicitly named target beyond the default 12-block sensor can still be
 * handed to the melee driver, which owns the approach itself.
 */
export function createAttackOrderGiver(active: () => OrderView | undefined): WorkGiver {
  let lastLookupAt = 0
  return {
    id: 'order.attack',
    find(ctx: EvalCtx, world: WorldView): WorkGiverResult {
      const current = activeOrder(active, 'attack')
      if (current === undefined) return null
      const entityId = current.order.params?.entityId
      if (typeof entityId !== 'string' || entityId.length === 0) {
        return { kind: 'hold', reason: 'ATTACK_TARGET_INVALID' }
      }
      const box = boxAround(world.self.pos, ATTACK_ACQUIRE_RADIUS, 16)
      let entity = world.entitiesIn(box).find(candidate => candidate.id === entityId)
      if (entity === undefined && ctx.observeEntities !== undefined && ctx.now >= lastLookupAt) {
        lastLookupAt = ctx.now + ATTACK_LOOKUP_INTERVAL_MS
        ctx.observeEntities(box)
        entity = world.entitiesIn(box).find(candidate => candidate.id === entityId)
      }
      if (entity === undefined) return { kind: 'hold', reason: 'ATTACK_TARGET_LOST' }
      return {
        driverId: 'attack',
        target: { kind: 'point', pos: entity.position },
        params: {
          entityId: entity.id,
          targetName: entity.name,
          orderId: current.order.id,
          allowAny: true,
          locateRadius: ATTACK_ACQUIRE_RADIUS,
          ...(typeof current.order.params?.maxChases === 'number'
            ? { maxChases: current.order.params.maxChases }
            : {}),
          continuationKey: `order.attack:${current.order.id}:${entity.id}`,
        },
        keys: `order.attack:${current.order.id}:${entity.id}`,
        orderId: current.order.id,
      }
    },
  }
}

const ATTACK_ACQUIRE_RADIUS = 64
const ATTACK_LOOKUP_INTERVAL_MS = 1_000


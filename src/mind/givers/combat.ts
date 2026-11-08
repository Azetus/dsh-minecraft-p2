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
 * the Agent. The mind resolves the known id through the adapter's identity
 * index (fresh every tick, no range box); the bounded snapshot scan is only a
 * fallback for adapters without that index, and the melee driver owns approach.
 */
export function createAttackOrderGiver(active: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.attack',
    find(ctx: EvalCtx, world: WorldView): WorkGiverResult {
      const current = activeOrder(active, 'attack')
      if (current === undefined) return null
      const entityId = current.order.params?.entityId
      if (typeof entityId !== 'string' || entityId.length === 0) {
        return { kind: 'hold', reason: 'ATTACK_TARGET_INVALID' }
      }
      const entity = (ctx.focus?.id === entityId ? ctx.focus : undefined)
        ?? world.entitiesIn(boxAround(world.self.pos, ATTACK_ACQUIRE_RADIUS, 16))
          .find(candidate => candidate.id === entityId)
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


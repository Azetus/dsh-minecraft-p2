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
  let orderId: string | undefined
  let lastKnown: { id: string; name: string; position: { x: number; y: number; z: number } } | undefined
  let lostSince: number | undefined
  let lostAttempted = false
  return {
    id: 'order.attack',
    find(ctx: EvalCtx, world: WorldView): WorkGiverResult {
      const current = activeOrder(active, 'attack')
      if (current === undefined) {
        orderId = undefined
        lastKnown = undefined
        lostSince = undefined
        lostAttempted = false
        return null
      }
      if (orderId !== current.order.id) {
        orderId = current.order.id
        lastKnown = undefined
        lostSince = undefined
        lostAttempted = false
      }
      const entityId = current.order.params?.entityId
      if (typeof entityId !== 'string' || entityId.length === 0) {
        return { kind: 'hold', reason: 'ATTACK_TARGET_INVALID' }
      }
      const entity = (ctx.focus?.id === entityId ? ctx.focus : undefined)
        ?? world.entitiesIn(boxAround(world.self.pos, ATTACK_ACQUIRE_RADIUS, 16))
          .find(candidate => candidate.id === entityId)
      if (entity === undefined) {
        if (lastKnown === undefined) return { kind: 'hold', reason: 'ATTACK_TARGET_LOST' }
        lostSince ??= ctx.now
        // A target that was seen and then vanished (creeper explosion, despawn)
        // must produce one terminal lost instead of holding forever. Give the
        // sensor a short grace for an occluded target.
        if (!lostAttempted && ctx.now - lostSince >= LOST_GRACE_MS) {
          lostAttempted = true
          return candidateFor(current, lastKnown)
        }
        return { kind: 'hold', reason: 'ATTACK_TARGET_LOST' }
      }
      lastKnown = { id: entity.id, name: entity.name, position: entity.position }
      lostSince = undefined
      lostAttempted = false
      return candidateFor(current, entity)
    },
  }
}

const ATTACK_ACQUIRE_RADIUS = 64
const LOST_GRACE_MS = 5_000

function candidateFor(
  current: OrderView,
  entity: { id: string; name: string; position: { x: number; y: number; z: number } },
): WorkGiverResult {
  return {
    driverId: 'attack',
    target: { kind: 'point', pos: entity.position },
    params: {
      entityId: entity.id,
      targetName: entity.name,
      orderId: current.order.id,
      allowAny: true,
      locateRadius: ATTACK_ACQUIRE_RADIUS,
      ...(typeof current.order.params?.chaseLeash === 'number'
        ? { chaseLeash: current.order.params.chaseLeash }
        : {}),
      continuationKey: `order.attack:${current.order.id}:${entity.id}`,
    },
    keys: `order.attack:${current.order.id}:${entity.id}`,
    orderId: current.order.id,
  }
}


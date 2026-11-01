import type { JsonValue } from '../../contracts/types.ts'
import type { EntityInfo } from '../../port/index.ts'
import { boxAround } from '../sensors.ts'
import type { EvalCtx, WorkGiver, WorkGiverResult, WorldView } from '../types.ts'

type OrderView = {
  order: { id: string; verb: string; params?: Record<string, JsonValue> }
}

function activeOrder(active: () => OrderView | undefined, verb: string): OrderView | undefined {
  const current = active()
  return current?.order.verb === verb ? current : undefined
}

function isProtected(entity: EntityInfo): boolean {
  if (entity.type === 'player') return true
  const kind = entity.kind ?? ''
  return /passive|neutral|tameable/i.test(kind)
}

/** Explicit `attack` order: exactly the Agent-named entity, no acquisition. */
export function createAttackOrderGiver(active: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.attack',
    find(_ctx: EvalCtx, world: WorldView): WorkGiverResult {
      const current = activeOrder(active, 'attack')
      if (current === undefined) return null
      const entityId = current.order.params?.entityId
      if (typeof entityId !== 'string' || entityId.length === 0) {
        return { kind: 'hold', reason: 'ATTACK_TARGET_INVALID' }
      }
      const entity = world.entitiesIn(boxAround(world.self.pos, 32, 8))
        .find(candidate => candidate.id === entityId)
      const allowPassive = current.order.params?.allowPassive === true
      if (entity === undefined) return { kind: 'hold', reason: 'ATTACK_TARGET_LOST' }
      if (entity.type === 'player' || (isProtected(entity) && !allowPassive)) {
        return { kind: 'hold', reason: 'ATTACK_TARGET_PROTECTED' }
      }
      return {
        driverId: 'attack',
        target: { kind: 'point', pos: entity.position },
        params: {
          entityId: entity.id,
          targetName: entity.name,
          orderId: current.order.id,
          ...(allowPassive ? { allowPassive: true } : {}),
        },
        keys: `order.attack:${current.order.id}:${entity.id}`,
        orderId: current.order.id,
      }
    },
  }
}


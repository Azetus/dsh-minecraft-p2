import type { JsonValue } from '../../contracts/types.ts'
import type { Candidate, EvalCtx, WorkGiver, WorldView } from '../types.ts'

type CheckOrderView = {
  order: { id: string; verb: string; params?: Record<string, JsonValue> }
}

export function checkPosition(order: CheckOrderView | undefined): { x: number; y: number; z: number } | undefined {
  if (order === undefined || order.order.verb !== 'check') return undefined
  const params = order.order.params ?? {}
  if (typeof params.x !== 'number' || typeof params.y !== 'number' || typeof params.z !== 'number') {
    return undefined
  }
  if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) return undefined
  return { x: Math.floor(params.x), y: Math.floor(params.y), z: Math.floor(params.z) }
}

/**
 * A check order is a one-shot observation job. It only selects the target
 * from the active order; opening the interface is the check driver's job.
 */
export function createCheckGiver(active: () => CheckOrderView | undefined): WorkGiver {
  return {
    id: 'check',
    find(_ctx: EvalCtx, _world: WorldView): Candidate | null {
      const order = active()
      const pos = checkPosition(order)
      if (order === undefined || pos === undefined) return null
      return {
        driverId: 'check',
        target: { kind: 'point', pos },
        params: { x: pos.x, y: pos.y, z: pos.z, orderId: order.order.id },
        keys: `check:${order.order.id}`,
      }
    },
  }
}

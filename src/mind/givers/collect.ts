import type { JsonValue } from '../../contracts/types.ts'
import type { Candidate, EvalCtx, WorkGiver, WorldView } from '../types.ts'

type OrderView = {
  order: { id: string; verb: string; params?: Record<string, JsonValue> }
}

function number(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Explicit `collect`: one bounded pass over already-observed drops near the
 * body. Target selection stays in the driver; the giver only normalizes the
 * order params and keeps one continuation key per order.
 */
export function createCollectOrderGiver(activeOrder: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.collect',
    find(_ctx: EvalCtx, world: WorldView): Candidate | null {
      const current = activeOrder()
      if (current === undefined || current.order.verb !== 'collect') return null
      const params = current.order.params
      const radius = number(params?.radius)
      const maxDrops = number(params?.maxDrops)
      const timeoutMs = number(params?.timeoutMs)
      const item = params?.item
      return {
        driverId: 'collect',
        target: { kind: 'point', pos: world.self.pos },
        params: {
          ...(radius === undefined ? {} : { radius }),
          ...(typeof item === 'string' ? { item } : {}),
          ...(maxDrops === undefined ? {} : { maxDrops }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
        keys: `order.collect:${current.order.id}`,
        orderId: current.order.id,
      }
    },
  }
}

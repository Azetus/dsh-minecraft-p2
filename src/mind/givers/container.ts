import type { JsonValue } from '../../contracts/types.ts'
import type { Candidate, EvalCtx, WorkGiver, WorldView } from '../types.ts'

type OrderView = {
  order: { id: string; verb: string; params?: Record<string, JsonValue> }
}

function number(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Explicit `container` order: one withdraw or deposit transfer. */
export function createContainerOrderGiver(active: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.container',
    find(_ctx: EvalCtx, _world: WorldView): Candidate | null {
      const current = active()
      if (current === undefined || current.order.verb !== 'container') return null
      const params = current.order.params
      const x = number(params?.x)
      const y = number(params?.y)
      const z = number(params?.z)
      const item = params?.item
      const action = params?.action
      if (x === undefined || y === undefined || z === undefined || typeof item !== 'string') return null
      if (typeof action !== 'string'
        || !['withdraw', 'deposit', 'load-input', 'load-fuel', 'take-input', 'take-fuel', 'take-output'].includes(action)) {
        return null
      }
      const count = number(params?.count)
      return {
        driverId: 'container',
        target: { kind: 'point', pos: { x, y, z } },
        params: {
          x,
          y,
          z,
          action,
          item,
          ...(count === undefined ? {} : { count }),
        },
        keys: `order.container:${current.order.id}`,
      }
    },
  }
}

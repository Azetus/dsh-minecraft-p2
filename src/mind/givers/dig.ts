import type { JsonValue } from '../../contracts/types.ts'
import type { Candidate, EvalCtx, WorkGiver, WorldView } from '../types.ts'

type OrderView = {
  order: { id: string; verb: string; params?: Record<string, JsonValue> }
}

function position(params: Record<string, JsonValue> | undefined): { x: number; y: number; z: number } | undefined {
  if (params === undefined) return undefined
  if (typeof params.x !== 'number' || typeof params.y !== 'number' || typeof params.z !== 'number') return undefined
  if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) return undefined
  return { x: Math.floor(params.x), y: Math.floor(params.y), z: Math.floor(params.z) }
}

/** Explicit `dig` order for one Agent-selected block. */
export function createDigOrderGiver(active: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.dig',
    find(_ctx: EvalCtx, _world: WorldView): Candidate | null {
      const current = active()
      if (current === undefined || current.order.verb !== 'dig') return null
      const pos = position(current.order.params)
      if (pos === undefined) return null
      return {
        driverId: 'dig',
        target: { kind: 'point', pos },
        params: pos,
        keys: `order.dig:${current.order.id}`,
      }
    },
  }
}

import type { JsonValue } from '../../contracts/types.ts'
import type { Candidate, EvalCtx, WorkGiver, WorkGiverResult, WorldView } from '../types.ts'

type OrderView = {
  order: { id: string; verb: string; params?: Record<string, JsonValue>; policy?: JsonValue }
}

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

function policyHazards(policy: JsonValue | undefined): JsonValue | undefined {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return undefined
  return (policy as Record<string, JsonValue>).hazards
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
      const hazards = policyHazards(current.order.policy)
      return {
        driverId: 'move',
        target: { kind: 'point', pos },
        params: { x: pos.x, y: pos.y, z: pos.z, range: 1, timeoutMs: 30_000,
          approach: true,
          ...(current.order.params?.exact === undefined ? {} : { exact: current.order.params.exact }),
          ...(current.order.params?.unstickDig === undefined ? {} : { unstickDig: current.order.params.unstickDig }),
          ...(hazards === undefined ? {} : { hazards }),
        },
        keys: `order.go:${current.order.id}`,
      }
    },
  }
}

/** Explicit wait: retain the active order without producing a job. */
export function createHoldOrderGiver(active: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.hold',
    find(_ctx: EvalCtx, _world: WorldView): WorkGiverResult {
      const current = activeOrder(active, 'hold')
      if (current === undefined) return null
      return { kind: 'hold', reason: 'HOLD_ORDER', notify: false }
    },
  }
}

/** Agent-authorized temporary bridge or staircase; no autonomous placement. */
export function createTraverseGiver(active: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.traverse',
    find(_ctx: EvalCtx, _world: WorldView): Candidate | null {
      const current = activeOrder(active, 'traverse')
      if (current === undefined) return null
      const pos = positionOf(current.order.params)
      const params = current.order.params
      if (pos === undefined || params === undefined) return null
      const mode = params.mode
      const item = params.item
      if ((mode !== 'bridge' && mode !== 'scaffold') || typeof item !== 'string' || item.length === 0) return null
      const maxBlocks = typeof params.maxBlocks === 'number' ? params.maxBlocks : undefined
      return {
        driverId: 'traverse',
        target: { kind: 'point', pos },
        params: {
          mode,
          x: pos.x,
          y: pos.y,
          z: pos.z,
          item,
          ...(maxBlocks === undefined ? {} : { maxBlocks }),
        },
        keys: `order.traverse:${current.order.id}`,
      }
    },
  }
}



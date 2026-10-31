import type { JsonValue } from '../../contracts/types.ts'
import type { Candidate, EvalCtx, WorkGiver, WorldView } from '../types.ts'

type OrderView = {
  order: { id: string; verb: string; params?: Record<string, JsonValue> }
}

function position(value: JsonValue | undefined): { x: number; y: number; z: number } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, JsonValue>
  if (typeof record.x !== 'number' || typeof record.y !== 'number' || typeof record.z !== 'number') return undefined
  if (!Number.isFinite(record.x) || !Number.isFinite(record.y) || !Number.isFinite(record.z)) return undefined
  return { x: record.x, y: record.y, z: record.z }
}

/** Explicit `smelt` order: Agent names the furnace and the chest. */
export function createSmeltOrderGiver(active: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.smelt',
    find(_ctx: EvalCtx, _world: WorldView): Candidate | null {
      const current = active()
      if (current === undefined || current.order.verb !== 'smelt') return null
      const furnace = position(current.order.params?.furnace)
      const chest = position(current.order.params?.chest)
      if (furnace === undefined || chest === undefined) return null
      return {
        driverId: 'smelt',
        target: { kind: 'point', pos: furnace },
        params: {
          furnace,
          chest,
          ...(typeof current.order.params?.input === 'string' ? { input: current.order.params.input } : {}),
          ...(typeof current.order.params?.fuel === 'string' ? { fuel: current.order.params.fuel } : {}),
          ...(typeof current.order.params?.output === 'string' ? { output: current.order.params.output } : {}),
          ...(typeof current.order.params?.count === 'number' ? { count: current.order.params.count } : {}),
        },
        keys: `order.smelt:${current.order.id}`,
      }
    },
  }
}

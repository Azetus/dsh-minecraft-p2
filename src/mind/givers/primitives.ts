import type { JsonValue } from '../../contracts/types.ts'
import type { Candidate, EvalCtx, WorkGiver, WorldView } from '../types.ts'

type OrderView = {
  order: { id: string; verb: string; params?: Record<string, JsonValue> }
}

function number(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function position(params: Record<string, JsonValue> | undefined): { x: number; y: number; z: number } | undefined {
  const x = number(params?.x)
  const y = number(params?.y)
  const z = number(params?.z)
  if (x === undefined || y === undefined || z === undefined) return undefined
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
}

function active(activeOrder: () => OrderView | undefined, verb: string): OrderView | undefined {
  const current = activeOrder()
  return current?.order.verb === verb ? current : undefined
}

/** Generic block placement: any block item, including beds. */
export function createPlaceOrderGiver(activeOrder: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.place',
    find(_ctx: EvalCtx, _world: WorldView): Candidate | null {
      const current = active(activeOrder, 'place')
      if (current === undefined) return null
      const pos = position(current.order.params)
      const params = current.order.params
      const item = params?.item
      if (pos === undefined || typeof item !== 'string' || item.length === 0) return null
      return {
        driverId: 'place',
        target: { kind: 'point', pos },
        params: {
          x: pos.x, y: pos.y, z: pos.z, item,
          ...(params?.face === undefined ? {} : { face: params.face }),
          ...(params?.expectedState === undefined ? {} : { expectedState: params.expectedState }),
        },
        keys: `order.place:${current.order.id}`,
      }
    },
  }
}

/** Generic held-item selection. */
export function createEquipOrderGiver(activeOrder: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.equip',
    find(_ctx: EvalCtx, world: WorldView): Candidate | null {
      const current = active(activeOrder, 'equip')
      if (current === undefined) return null
      const item = current.order.params?.item
      if (typeof item !== 'string' || item.length === 0) return null
      return {
        driverId: 'equip',
        target: { kind: 'point', pos: world.self.pos },
        params: { item },
        keys: `order.equip:${current.order.id}`,
      }
    },
  }
}

/** Generic use: activate a block, sleep in a bed, or use an item/food. */
export function createUseOrderGiver(activeOrder: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.use',
    find(_ctx: EvalCtx, world: WorldView): Candidate | null {
      const current = active(activeOrder, 'use')
      if (current === undefined) return null
      const params = current.order.params
      const pos = position(params)
      const item = params?.item
      if (pos === undefined && (typeof item !== 'string' || item.length === 0)) return null
      return {
        driverId: 'use',
        target: { kind: 'point', pos: pos ?? world.self.pos },
        params: {
          ...(pos === undefined ? {} : pos),
          ...(typeof item === 'string' ? { item } : {}),
          ...(params?.durationMs === undefined ? {} : { durationMs: params.durationMs }),
        },
        keys: `order.use:${current.order.id}`,
      }
    },
  }
}

/** Generic recipe execution. */
export function createCraftOrderGiver(activeOrder: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.craft',
    find(_ctx: EvalCtx, world: WorldView): Candidate | null {
      const current = active(activeOrder, 'craft')
      if (current === undefined) return null
      const item = current.order.params?.item
      if (typeof item !== 'string' || item.length === 0) return null
      const count = number(current.order.params?.count)
      return {
        driverId: 'craft',
        target: { kind: 'point', pos: world.self.pos },
        params: { item, ...(count === undefined ? {} : { count }) },
        keys: `order.craft:${current.order.id}`,
      }
    },
  }
}

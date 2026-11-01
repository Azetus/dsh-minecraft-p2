import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle } from './handle.ts'

export const EQUIP_DRIVER_ID = 'equip'

const EQUIP_SCHEMA: SchemaNode = {
  type: 'object',
  properties: { item: { type: 'string' } },
  required: ['item'],
  additionalProperties: false,
}

type EquipParams = { item: string }

/** Select one inventory item as the held item; no world mutation. */
export function createEquipDriver(): Driver {
  return {
    id: EQUIP_DRIVER_ID,
    schema: EQUIP_SCHEMA,
    defaults: {
      budget: { maxTicks: 100, maxWallMs: 5_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as EquipParams
      if (typeof params.item !== 'string' || params.item.length === 0) return { ok: false, code: 'BAD_ARGS' }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as EquipParams
      return new AsyncDriverHandle(`equip:${params.item}`, equip(ctx, params))
    },
  }
}

async function equip(ctx: DriverCtx, params: EquipParams): Promise<DriverResult> {
  const available = ctx.port.inventory().some(item => item.name === params.item)
  if (!available) return { state: 'failed', code: 'EQUIP_ITEM_MISSING' }
  const result = await ctx.port.equip(params.item)
  if (result.state !== 'ok') return { state: 'failed', code: result.code ?? 'EQUIP_FAILED' }
  return { state: 'succeeded', observed: { kind: 'equip', item: params.item } }
}

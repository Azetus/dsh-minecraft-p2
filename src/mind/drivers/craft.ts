import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle } from './handle.ts'

export const CRAFT_DRIVER_ID = 'craft'

const CRAFT_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    item: { type: 'string' },
    count: { type: 'number' },
  },
  required: ['item'],
  additionalProperties: false,
}

type CraftParams = { item: string; count?: number }

/** Craft one recipe result in a bounded batch; the world is the authority. */
export function createCraftDriver(): Driver {
  return {
    id: CRAFT_DRIVER_ID,
    schema: CRAFT_SCHEMA,
    defaults: {
      budget: { maxTicks: 600, maxWallMs: 30_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as CraftParams
      if (typeof params.item !== 'string' || params.item.length === 0) return { ok: false, code: 'BAD_ARGS' }
      if (params.count !== undefined && (!Number.isInteger(params.count) || params.count < 1 || params.count > 64)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as CraftParams
      return new AsyncDriverHandle(`craft:${params.item}:${params.count ?? 1}`, craft(ctx, params))
    },
  }
}

async function craft(ctx: DriverCtx, params: CraftParams): Promise<DriverResult> {
  const count = params.count ?? 1
  const before = countItem(ctx.port.inventory(), params.item)
  const result = await ctx.port.craft(params.item, count)
  if (result.state !== 'ok') return { state: 'failed', code: result.code ?? 'CRAFT_FAILED' }
  const after = countItem(ctx.port.inventory(), params.item)
  if (after < before + count) return { state: 'failed', code: 'CRAFT_READBACK_MISMATCH' }
  return {
    state: 'succeeded',
    observed: { kind: 'craft', item: params.item, count, before, after },
  }
}

function countItem(inventory: Array<{ name: string; count: number }>, name: string): number {
  return inventory.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0)
}

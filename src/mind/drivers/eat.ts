import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle, sleep } from './handle.ts'

export const EAT_DRIVER_ID = 'eat'

const EAT_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    item: { type: 'string' },
    durationMs: { type: 'number' },
  },
  required: ['item'],
  additionalProperties: false,
}

type EatParams = { item: string; durationMs?: number }

/** Equip one food and hold use long enough for the server to consume it. */
export function createEatDriver(): Driver {
  return {
    id: EAT_DRIVER_ID,
    schema: EAT_SCHEMA,
    defaults: {
      budget: { maxTicks: 400, maxWallMs: 8_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as EatParams
      if (typeof params.item !== 'string' || params.item.length === 0) return { ok: false, code: 'BAD_ARGS' }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as EatParams
      return new AsyncDriverHandle(`eat:${params.item}`, eat(ctx, params))
    },
  }
}

async function eat(ctx: DriverCtx, params: EatParams): Promise<DriverResult> {
  const before = ctx.port.self().food
  const equipped = await ctx.port.equip(params.item)
  if (equipped.state !== 'ok') {
    return { state: 'failed', code: equipped.code ?? 'EAT_EQUIP_FAILED' }
  }
  const duration = Math.max(1_000, params.durationMs ?? 1_800)
  const used = await ctx.port.useItem({ durationMs: duration })
  if (used.state !== 'ok') return { state: 'failed', code: used.code ?? 'EAT_USE_FAILED' }
  await sleep(300)
  const after = ctx.port.self().food
  if (after <= before) return { state: 'failed', code: 'EAT_NO_EFFECT' }
  return {
    state: 'succeeded',
    observed: { kind: 'eat', item: params.item, foodBefore: before, foodAfter: after },
  }
}

import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle } from './handle.ts'

export const DIG_DRIVER_ID = 'dig'

const DIG_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
  },
  required: ['x', 'y', 'z'],
  additionalProperties: false,
}

type DigParams = { x: number; y: number; z: number }

/** One Agent-selected block dig; target selection stays outside the driver. */
export function createDigDriver(): Driver {
  return {
    id: DIG_DRIVER_ID,
    schema: DIG_SCHEMA,
    defaults: {
      budget: { maxTicks: 200, maxWallMs: 15_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as DigParams
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as DigParams
      return new AsyncDriverHandle(
        `dig:${params.x},${params.y},${params.z}`,
        dig(ctx, params),
      )
    },
  }
}

async function dig(ctx: DriverCtx, params: DigParams): Promise<DriverResult> {
  const result = await ctx.port.dig({ x: params.x, y: params.y, z: params.z })
  if (result.state !== 'ok') {
    return { state: 'failed', code: result.code ?? 'DIG_FAILED' }
  }
  return { state: 'succeeded', observed: { kind: 'dig', ...params } }
}

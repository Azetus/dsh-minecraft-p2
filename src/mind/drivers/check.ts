import type { ClientPort } from '../../port/index.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle } from './handle.ts'

export const CHECK_DRIVER_ID = 'check'

const CHECK_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    orderId: { type: 'string' },
  },
  required: ['x', 'y', 'z'],
  additionalProperties: false,
}

type CheckParams = { x: number; y: number; z: number; orderId?: string }

/**
 * A check job is the only place that opens a container/furnace interface.
 * Verifiers must use world samples or request a check; they never open a window.
 */
export function createCheckDriver(): Driver {
  return {
    id: CHECK_DRIVER_ID,
    schema: CHECK_SCHEMA,
    defaults: {
      budget: { maxTicks: 100, maxWallMs: 10_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as CheckParams
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as CheckParams
      const key = `check:${params.x},${params.y},${params.z}`
      return new AsyncDriverHandle(key, checkContainer(ctx.port, params))
    },
  }
}

async function checkContainer(port: ClientPort, params: CheckParams): Promise<DriverResult> {
  const result = await port.containerAt({ x: params.x, y: params.y, z: params.z })
  return {
    state: result.state === 'unknown' ? 'failed' : 'succeeded',
    ...(result.state === 'failed' ? { code: result.code } : {}),
    observed: {
      kind: 'container',
      ...(params.orderId === undefined ? {} : { orderId: params.orderId }),
      ...result,
    },
  }
}

import type { ClientPort, Vec3 } from '../../port/index.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle } from './handle.ts'

export const FATAL_DRIVER_ID = 'fatal'

const FATAL_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    waitMs: { type: 'integer', minimum: 0 },
  },
  required: ['x', 'y', 'z'],
  additionalProperties: false,
}

type FatalParams = { x: number; y: number; z: number; waitMs?: number }

/**
 * Agent-authorized fatal exit. This deliberately lives outside the motion core:
 * the core never plans a step into lava/void. The driver only performs the
 * explicit step-off and reports success after the real `died` event.
 */
export function createFatalDriver(): Driver {
  return {
    id: FATAL_DRIVER_ID,
    schema: FATAL_SCHEMA,
    defaults: {
      budget: { maxTicks: 200, maxWallMs: 8_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as FatalParams
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as FatalParams
      return new AsyncDriverHandle(`fatal:${params.x},${params.y},${params.z}`, fatal(ctx, params))
    },
  }
}

async function fatal(ctx: DriverCtx, params: FatalParams): Promise<DriverResult> {
  const target: Vec3 = { x: params.x, y: params.y, z: params.z }
  let died = false
  const onDied = (): void => { died = true }
  ctx.port.on('died', onDied)
  try {
    const stepped = await ctx.port.fatalStep(target)
    if (died || stepped.code === 'DEATH' || stepped.code === 'DIED_IN_ALLOWED_HAZARD') {
      return { state: 'succeeded', observed: { kind: 'fatal', target, died: true } }
    }
    if (stepped.state === 'unknown') {
      return {
        state: 'failed',
        code: stepped.code ?? 'HAZARD_STEP_TIMEOUT',
        ...(stepped.observed === undefined ? {} : { observed: stepped.observed }),
      }
    }
    if (stepped.state === 'failed') {
      return {
        state: 'failed',
        code: stepped.code ?? 'HAZARD_STEP_FAILED',
        ...(stepped.observed === undefined ? {} : { observed: stepped.observed }),
      }
    }
    const waitMs = Math.max(0, params.waitMs ?? 5_000)
    if (!died && waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
    const self = ctx.port.self()
    if (!died && self.health > 0) {
      return { state: 'failed', code: 'HAZARD_SURVIVED', observed: { target, health: self.health } }
    }
    return { state: 'succeeded', observed: { kind: 'fatal', target, died: true } }
  } finally {
    ctx.port.off?.('died', onDied)
  }
}

import type { ClientPort, Vec3 } from '../../port/index.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle } from './handle.ts'

export const SLEEP_DRIVER_ID = 'sleep'

const SLEEP_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
  },
  required: ['x', 'y', 'z'],
  additionalProperties: false,
}

type SleepParams = { x: number; y: number; z: number }

/** Move near an Agent-selected bed, then ask the server to sleep in it. */
export function createSleepDriver(): Driver {
  return {
    id: SLEEP_DRIVER_ID,
    schema: SLEEP_SCHEMA,
    defaults: {
      budget: { maxTicks: 400, maxWallMs: 75_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as SleepParams
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as SleepParams
      return new AsyncDriverHandle(
        `sleep:${params.x},${params.y},${params.z}`,
        sleep(ctx.port, { x: params.x, y: params.y, z: params.z }),
      )
    },
  }
}

async function sleep(port: ClientPort, bed: Vec3): Promise<DriverResult> {
  const moved = await port.moveTo(bed, { range: 4, intent: 'interact', timeoutMs: 15_000 })
  if (moved.state !== 'ok') {
    return { state: 'failed', code: moved.code ?? 'SLEEP_MOVE_FAILED' }
  }
  const slept = await port.sleep(bed)
  if (slept.state !== 'ok') {
    return { state: 'failed', code: slept.code ?? 'SLEEP_FAILED' }
  }
  return { state: 'succeeded', observed: { kind: 'sleep', bed, result: slept } }
}

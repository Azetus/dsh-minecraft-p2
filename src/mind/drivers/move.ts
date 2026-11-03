import type { ActResult, MoveOptions, Vec3 } from '../../port/index.ts'
import type { SchemaNode } from '../schema.ts'
import type {
  Driver,
  DriverCtx,
  DriverResult,
  DriverValidation,
  Job,
  WorldView,
} from '../types.ts'
import { AsyncDriverHandle } from './handle.ts'

export const MOVE_DRIVER_ID = 'move'

const MOVE_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    range: { type: 'number', minimum: 0, maximum: 8 },
    timeoutMs: { type: 'integer', minimum: 1 },
    exact: { type: 'boolean' },
    intent: { type: 'string', enum: ['interact', 'attack'] },
    allowParkour: { type: 'boolean' },
    allowDiagonal: { type: 'boolean' },
    allowPlace: { type: 'boolean' },
    material: { type: 'string' },
    /**
     * Unvalidated vanilla-style path: best effort only. It never grants
     * break/place, and the result is marked `unvalidated`.
     */
    risky: { type: 'boolean' },
    unstickDig: { type: 'array', items: { type: 'object', properties: {
      x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' }, name: { type: 'string' },
    }, required: ['x', 'y', 'z', 'name'], additionalProperties: false } },
  },
  required: ['x', 'y', 'z'],
  additionalProperties: false,
}

type MoveParams = {
  x: number
  y: number
  z: number
  range?: number
  timeoutMs?: number
  exact?: boolean
  allowParkour?: boolean
  allowDiagonal?: boolean
  allowPlace?: boolean
  material?: string
  risky?: boolean
  unstickDig?: MoveOptions['unstickDig']
  intent?: MoveOptions['intent']
}

/** One port call may not exceed the provider's 30s action cap. */
const SEGMENT_MS = 30_000
const MAX_SEGMENTS = 64

/**
 * Movement driver with bounded streaming segments. A long path is advanced to
 * the reachable prefix reported by the provider, then re-planned from there.
 * The driver still owns one already-selected goal; it never picks a new one.
 */
export function createMoveDriver(): Driver {
  return {
    id: MOVE_DRIVER_ID,
    schema: MOVE_SCHEMA,
    defaults: {
      // A 165-block walk can exceed one 30s action; the progress watchdog and
      // per-segment search still bound a stuck path.
      budget: { maxTicks: 3_000, maxWallMs: 150_000 },
      interrupt: 'constant-only',
      suspendable: true,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as MoveParams
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as MoveParams
      const keys = `move:${params.x},${params.y},${params.z},${params.range ?? 1}`
      return new AsyncDriverHandle(keys, move(ctx, params, job))
    },
  }
}

async function move(ctx: DriverCtx, params: MoveParams, job: Job): Promise<DriverResult> {
  const goal: Vec3 = { x: params.x, y: params.y, z: params.z }
  const range = params.range ?? 1
  const totalMs = params.timeoutMs ?? job.budget.maxWallMs
  const startedAt = ctx.now()
  let last: ActResult | undefined
  let timeoutRetries = 0

  for (let segment = 0; segment < MAX_SEGMENTS; segment += 1) {
    const remaining = totalMs - (ctx.now() - startedAt)
    if (remaining <= 0) {
      return {
        state: 'failed',
        code: 'GOTO_TIMEOUT',
        ...(last?.observed === undefined ? {} : { observed: last.observed }),
      }
    }
    const result = await ctx.port.moveTo(goal, {
      range,
      timeoutMs: Math.min(remaining, SEGMENT_MS),
      ...(params.exact === undefined ? {} : { exact: params.exact }),
      ...(params.unstickDig === undefined ? {} : { unstickDig: params.unstickDig }),
      ...(params.intent === undefined ? {} : { intent: params.intent }),
      ...(params.allowParkour === undefined ? {} : { allowParkour: params.allowParkour }),
      ...(params.allowDiagonal === undefined ? {} : { allowDiagonal: params.allowDiagonal }),
      ...(params.allowPlace === undefined ? {} : { allowPlace: params.allowPlace }),
      ...(params.material === undefined ? {} : { material: params.material }),
      ...(params.risky === true ? { planner: 'vanilla' as const } : {}),
    })
    last = result
    if (result.state === 'ok') {
      return result.observed === undefined
        ? { state: 'succeeded' }
        : { state: 'succeeded', observed: result.observed }
    }
    // A bounded action can time out while core is still advancing a prefix or
    // waiting for a slow server tick. Retry a few segments; never treat an
    // unknown/stop-unconfirmed result as success.
    if ((result.code === 'CLIENT_TIMEOUT' || result.code === 'GOTO_TIMEOUT') && timeoutRetries < 3) {
      timeoutRetries += 1
      continue
    }
    return {
      state: 'failed',
      code: result.code ?? (result.state === 'unknown' ? 'CLIENT_TIMEOUT' : 'GOTO_NO_PATH'),
      ...(result.observed === undefined ? {} : { observed: result.observed }),
    }
  }

  return {
    state: 'failed',
    code: 'GOTO_SEGMENTS_EXCEEDED',
    ...(last?.observed === undefined ? {} : { observed: last.observed }),
  }
}

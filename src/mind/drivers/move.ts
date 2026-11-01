import { isRecord } from '../../contracts/protocol.ts'
import { HAZARD_KINDS } from '../../port/terrain.ts'
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
    approach: { type: 'boolean' },
    intent: { type: 'string', enum: ['interact', 'attack'] },
    unstickDig: { type: 'array', items: { type: 'object', properties: {
      x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' }, name: { type: 'string' },
    }, required: ['x', 'y', 'z', 'name'], additionalProperties: false } },
    hazards: {
      type: 'object',
      properties: {
        allow: { type: 'array', items: { type: 'string', enum: [...HAZARD_KINDS] } },
        reason: { type: 'string' },
      },
      required: ['allow'],
      additionalProperties: false,
    },
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
  approach?: boolean
  unstickDig?: MoveOptions['unstickDig']
  intent?: MoveOptions['intent']
  hazards?: MoveOptions['hazards']
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
  const finalGoal: Vec3 = { x: params.x, y: params.y, z: params.z }
  const range = params.range ?? 1
  const totalMs = params.timeoutMs ?? job.budget.maxWallMs
  const startedAt = ctx.now()
  let goal: Vec3 = finalGoal
  let goalIsFinal = true
  let last: ActResult | undefined
  const visited = new Set<string>()

  for (let segment = 0; segment < MAX_SEGMENTS; segment += 1) {
    if (goalIsFinal && typeof ctx.port.blockAt === 'function' && ctx.port.blockAt(goal) === null) {
      const prefix = forwardPrefix(ctx.port.self().pos, finalGoal)
      if (prefix !== undefined && !samePoint(prefix, goal)) {
        goal = prefix
        goalIsFinal = false
      }
    }
    const remaining = totalMs - (ctx.now() - startedAt)
    if (remaining <= 0) {
      return {
        state: 'failed',
        code: 'GOTO_TIMEOUT',
        ...(last?.observed === undefined ? {} : { observed: last.observed }),
      }
    }
    const result = await ctx.port.moveTo(goal, {
      range: goalIsFinal ? range : 1,
      timeoutMs: Math.min(remaining, SEGMENT_MS),
      ...(goalIsFinal && params.exact !== undefined ? { exact: params.exact } : {}),
      ...(goalIsFinal && params.approach !== undefined ? { approach: params.approach } : {}),
      ...(goalIsFinal && params.unstickDig !== undefined ? { unstickDig: params.unstickDig } : {}),
      ...(params.intent === undefined ? {} : { intent: params.intent }),
      ...(params.hazards === undefined ? {} : { hazards: params.hazards }),
    })
    last = result
    if (result.state === 'ok') {
      if (goalIsFinal) {
        return result.observed === undefined
          ? { state: 'succeeded' }
          : { state: 'succeeded', observed: result.observed }
      }
      // Reached the prefix; continue to the original goal.
      goal = finalGoal
      goalIsFinal = true
      continue
    }

    const next = bestReachable(result.observed)
    if (next === undefined || samePoint(next, goal)) {
      return {
        state: 'failed',
        code: result.code ?? (result.state === 'unknown' ? 'CLIENT_TIMEOUT' : 'GOTO_NO_PATH'),
        ...(result.observed === undefined ? {} : { observed: result.observed }),
      }
    }
    const key = pointKey(next)
    if (visited.has(key)) {
      return {
        state: 'failed',
        code: result.code ?? 'GOTO_NO_PATH',
        ...(result.observed === undefined ? {} : { observed: result.observed }),
      }
    }
    visited.add(key)
    goal = next
    goalIsFinal = false
  }

  return {
    state: 'failed',
    code: 'GOTO_SEGMENTS_EXCEEDED',
    ...(last?.observed === undefined ? {} : { observed: last.observed }),
  }
}

function bestReachable(observed: unknown): Vec3 | undefined {
  if (!isRecord(observed)) return undefined
  const best = observed.bestReachable
  if (!isRecord(best)) return undefined
  const { x, y, z } = best
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return undefined
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
}

function samePoint(left: Vec3, right: Vec3): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z
}

/** An unloaded final target is advanced by a near, same-level prefix. */
function forwardPrefix(self: Vec3, target: Vec3, step = 16): Vec3 | undefined {
  const dx = target.x - self.x
  const dz = target.z - self.z
  const distance = Math.hypot(dx, dz)
  if (distance <= 1) return undefined
  const advance = Math.min(step, distance - 1)
  const point = {
    x: Math.floor(self.x + dx / distance * advance),
    y: Math.floor(self.y),
    z: Math.floor(self.z + dz / distance * advance),
  }
  return samePoint(point, { x: Math.floor(self.x), y: Math.floor(self.y), z: Math.floor(self.z) })
    ? undefined
    : point
}

function pointKey(point: Vec3): string {
  return `${point.x},${point.y},${point.z}`
}

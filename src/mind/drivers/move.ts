import type { ActResult, BlockInfo, ClientPort, MoveOptions, Vec3 } from '../../port/index.ts'
import type { JsonValue } from '../../contracts/types.ts'
import { isRecord } from '../../contracts/index.ts'
import type { SchemaNode } from '../schema.ts'
import type {
  Driver,
  DriverCtx,
  DriverResult,
  DriverValidation,
  Job,
  WorldView,
} from '../types.ts'
import { failureBody, failureSnapshot, withFailure } from '../failure.ts'
import type { FailureSuggestion } from '../failure.ts'
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
        observed: moveFailure(ctx, 'GOTO_TIMEOUT', last?.observed, params),
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
    if ((result.code === 'ACT_TIMEOUT' || result.code === 'GOTO_TIMEOUT' || result.code === 'CLIENT_TIMEOUT')
      && timeoutRetries < 3) {
      timeoutRetries += 1
      continue
    }
    const code = result.code ?? (result.state === 'unknown' ? 'ACT_UNCONFIRMED' : 'GOTO_NO_PATH')
    return {
      state: 'failed',
      code,
      observed: moveFailure(ctx, code, result.observed, params),
    }
  }

  return {
    state: 'failed',
    code: 'GOTO_SEGMENTS_EXCEEDED',
    observed: moveFailure(ctx, 'GOTO_SEGMENTS_EXCEEDED', last?.observed, params),
  }
}

/** Failure body for one movement attempt; facts come from the same report. */
function moveFailure(
  ctx: DriverCtx,
  code: string,
  observed: JsonValue | undefined,
  params: MoveParams,
): JsonValue {
  const facts: Record<string, JsonValue> = {
    snapshot: failureSnapshot(ctx.port, params, observed) as unknown as JsonValue,
  }
  const blocked = [
    ...blockCells(observed, 'bodyOverlap'),
    ...blockCells(observed, 'blockedBy'),
  ]
  if (code === 'GOTO_STUCK') {
    facts.probe = probeBody(ctx.port)
    // Only claim blockedAhead when the body itself overlaps a known block;
    // a sampled neighbour is evidence, but not proof of the blocking cell.
    if (blocked.length > 0) facts.blockedAhead = blocked as unknown as JsonValue
  }
  const suggestions: FailureSuggestion[] = []
  for (const cell of blocked.slice(0, 3)) {
    suggestions.push({
      action: 'dig',
      params: { x: cell.x, y: cell.y, z: cell.z },
      confidence: 'exact',
      why: 'this block is proven to block the body or the planned stand cell',
    })
  }
  if (suggestions.length === 0 && (code === 'GOTO_STUCK' || code === 'GOTO_NO_PATH')) {
    suggestions.push({
      action: 'reobserve',
      confidence: 'exact',
      why: 'no blocking cell could be proven; observe the body before retrying',
    })
  }
  if (suggestions.length < 3 && code === 'GOTO_NO_PATH' && isRecord(observed) && isRecord(observed.bestReachable)) {
    const best = observed.bestReachable
    if (isCell(best)) {
      suggestions.push({
        action: 'go',
        params: { x: best.x, y: best.y, z: best.z, range: 0 },
        confidence: 'candidate',
        why: 'move to the proven reachable prefix before planning the full target',
      })
    }
  }
  return withFailure(observed, failureBody({
    layer: 'motion',
    phase: 'execute',
    code,
    observed,
    facts,
    cause: {
      kind: code === 'GOTO_TIMEOUT' || code === 'GOTO_SEARCH_TIMEOUT' ? 'budget' : 'world',
      code,
    },
    recovery: code === 'GOAL_NOT_STANDABLE' || code === 'BODY_OVERLAP'
      ? { kind: 'none' }
      : { kind: 'replan', detail: `target ${params.x},${params.y},${params.z}` },
    suggestions,
  }))
}

function blockCells(
  observed: JsonValue | undefined,
  key: 'bodyOverlap' | 'blockedBy',
): Array<{ x: number; y: number; z: number; name?: string }> {
  if (!isRecord(observed)) return []
  const value = observed[key]
  const blocks = isRecord(value) && Array.isArray(value.blocks)
    ? value.blocks
    : Array.isArray(value) ? value : []
  const cells: Array<{ x: number; y: number; z: number; name?: string }> = []
  for (const item of blocks.slice(0, 8)) {
    if (!isRecord(item)) continue
    const cell = isRecord(item.cell) && isCell(item.cell) ? item.cell : item
    if (!isCell(cell)) continue
    cells.push({
      x: cell.x,
      y: cell.y,
      z: cell.z,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
    })
  }
  return cells
}

function probeBody(port: ClientPort): JsonValue {
  const pos = port.self().pos
  const x = Math.floor(pos.x)
  const y = Math.floor(pos.y)
  const z = Math.floor(pos.z)
  const probes: Array<[string, number, number, number]> = [
    ['feet', x, y, z],
    ['head', x, y + 1, z],
    ['east', x + 1, y, z],
    ['west', x - 1, y, z],
    ['south', x, y, z + 1],
    ['north', x, y, z - 1],
  ]
  return probes.map(([layer, px, py, pz]) => {
    const block: BlockInfo | null = port.blockAt({ x: px, y: py, z: pz })
    return {
      layer,
      x: px,
      y: py,
      z: pz,
      name: block?.name ?? null,
      loaded: block?.loaded ?? false,
    }
  })
}

function isCell(value: unknown): value is { x: number; y: number; z: number } {
  return isRecord(value)
    && typeof value.x === 'number'
    && typeof value.y === 'number'
    && typeof value.z === 'number'
}

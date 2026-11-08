import { isRecord } from '../../contracts/index.ts'
import type { JsonValue } from '../../contracts/types.ts'
import type { Vec3 } from '../../port/index.ts'
import { failureBody, readFailure, withFailure } from '../failure.ts'
import { pickupNearby } from '../pickup.ts'
import type { PickupItemOutcome, PickupResult } from '../pickup.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle } from './handle.ts'

export const COLLECT_DRIVER_ID = 'collect'

const COLLECT_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    radius: { type: 'integer', minimum: 1, maximum: 16 },
    item: { type: 'string' },
    maxDrops: { type: 'integer', minimum: 1, maximum: 16 },
    timeoutMs: { type: 'integer', minimum: 1_000, maximum: 90_000 },
  },
  additionalProperties: false,
}

type CollectParams = {
  radius?: number
  item?: string
  maxDrops?: number
  timeoutMs?: number
}

const DEFAULT_RADIUS = 8
const DEFAULT_MAX_DROPS = 8
const DEFAULT_TIMEOUT_MS = 30_000
const HARD_MAX_RADIUS = 16
const HARD_MAX_DROPS = 16
const HARD_MAX_TIMEOUT_MS = 90_000

/**
 * One bounded collect pass over drops already visible from the body's start
 * position. Movement and pickup stay in `pickupNearby`; this driver only owns
 * the scan origin, ordering, deadline and the collect result contract.
 */
export function createCollectDriver(): Driver {
  return {
    id: COLLECT_DRIVER_ID,
    schema: COLLECT_SCHEMA,
    defaults: {
      budget: { maxTicks: 2_400, maxWallMs: 120_000 },
      interrupt: 'constant-only',
      suspendable: true,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as CollectParams
      if (params.radius !== undefined
        && (!Number.isInteger(params.radius) || params.radius < 1 || params.radius > HARD_MAX_RADIUS)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      if (params.maxDrops !== undefined
        && (!Number.isInteger(params.maxDrops) || params.maxDrops < 1 || params.maxDrops > HARD_MAX_DROPS)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      if (params.timeoutMs !== undefined
        && (!Number.isInteger(params.timeoutMs) || params.timeoutMs < 1_000
          || params.timeoutMs > HARD_MAX_TIMEOUT_MS)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      if (params.item !== undefined
        && (typeof params.item !== 'string' || params.item.trim().length === 0)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as CollectParams
      const key = `collect:${params.radius ?? DEFAULT_RADIUS}:${params.item ?? '*'}:`
        + `${params.maxDrops ?? DEFAULT_MAX_DROPS}:${params.timeoutMs ?? DEFAULT_TIMEOUT_MS}`
      return new AsyncDriverHandle(key, collect(ctx, params).then(result => attachCollectFailure(result)))
    },
  }
}

async function collect(ctx: DriverCtx, params: CollectParams): Promise<DriverResult> {
  const origin: Vec3 = { ...ctx.port.self().pos }
  const radius = params.radius ?? DEFAULT_RADIUS
  const maxDrops = params.maxDrops ?? DEFAULT_MAX_DROPS
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pickup = await pickupNearby(ctx.port, origin, {
    radius,
    maxDrops,
    timeoutMs,
    ...(params.item === undefined ? {} : { item: params.item }),
  })
  const observed = collectObserved(params, origin, radius, maxDrops, timeoutMs, pickup)
  const code = collectFailureCode(pickup)
  if (code !== undefined) return { state: 'failed', code, observed }
  return { state: 'succeeded', observed }
}

function collectFailureCode(pickup: PickupResult): string | undefined {
  if (pickup.drops === 0) return undefined
  if (pickup.timedOut > 0) return 'COLLECT_TIMEOUT'
  if (pickup.full > 0) return 'COLLECT_INVENTORY_FULL'
  if (pickup.unreachable > 0) return 'COLLECT_UNREACHABLE'
  if (pickup.noReturn > 0) return 'COLLECT_NO_RETURN'
  if (pickup.notCollected + pickup.gone + pickup.partial > 0) return 'COLLECT_INCOMPLETE'
  return undefined
}

function collectObserved(
  params: CollectParams,
  origin: Vec3,
  radius: number,
  maxDrops: number,
  timeoutMs: number,
  pickup: PickupResult,
): JsonValue {
  const missed = pickup.notCollected + pickup.gone + pickup.full + pickup.partial + pickup.timedOut
  const collectedDrops = Math.max(0, pickup.drops - missed - pickup.unreachable - pickup.noReturn)
  const unreachable = failedDrops(pickup, 'unreachable')
  const noReturn = failedDrops(pickup, 'noReturn')
  return {
    kind: 'collect',
    origin: { x: origin.x, y: origin.y, z: origin.z },
    radius,
    item: params.item ?? null,
    maxDrops,
    timeoutMs,
    drops: pickup.drops,
    eligible: pickup.eligible,
    skippedByCap: pickup.skippedByCap,
    collected: pickup.picked,
    collectedDrops,
    missed,
    unreachable: pickup.unreachable,
    noReturn: pickup.noReturn,
    inventoryDelta: pickup.observed.inventory.after - pickup.observed.inventory.before,
    timedOut: pickup.timedOut,
    timeoutHit: pickup.timeoutHit,
    gone: pickup.gone,
    full: pickup.full,
    partial: pickup.partial,
    notCollected: pickup.notCollected,
    merged: pickup.merged,
    inventory: pickup.observed.inventory as unknown as JsonValue,
    items: pickup.observed.items.map(item => ({
      id: item.id,
      name: item.item?.name ?? item.name,
      count: item.item?.count ?? 1,
      position: (item.positionAfter ?? item.position) as unknown as JsonValue,
      outcome: item.outcome ?? 'notAttempted',
      ...(item.picked === undefined ? {} : { picked: item.picked }),
      ...(item.presentAfter === undefined ? {} : { presentAfter: item.presentAfter }),
    })),
    ...(pickup.observed.standQuery === undefined
      ? {}
      : { standQuery: pickup.observed.standQuery as unknown as JsonValue }),
    ...(unreachable.length === 0 ? {} : { unreachableDrops: unreachable }),
    ...(noReturn.length === 0 ? {} : { noReturnDrops: noReturn }),
  }
}

function failedDrops(pickup: PickupResult, outcome: PickupItemOutcome): JsonValue[] {
  const drops: JsonValue[] = []
  for (const item of pickup.observed.items) {
    if (item.outcome !== outcome) continue
    drops.push({
      id: item.id,
      name: item.item?.name ?? item.name,
      count: item.item?.count ?? 1,
      position: (item.positionAfter ?? item.position) as unknown as JsonValue,
    })
    if (drops.length >= 5) break
  }
  return drops
}

/** Add the unified failure projection to every collect failure path. */
function attachCollectFailure(result: DriverResult): DriverResult {
  if (result.state !== 'failed' || readFailure(result.observed) !== undefined) return result
  const code = result.code ?? 'COLLECT_INCOMPLETE'
  const facts: Record<string, JsonValue> = {}
  if (isRecord(result.observed) && isRecord(result.observed.standQuery)
    && Array.isArray(result.observed.standQuery.requiredDig)) {
    facts.requiredDig = result.observed.standQuery.requiredDig.slice(0, 8) as unknown as JsonValue
  }
  const budget = code === 'COLLECT_TIMEOUT'
  const noStand = code === 'COLLECT_UNREACHABLE'
  const noReturn = code === 'COLLECT_NO_RETURN'
  return {
    ...result,
    observed: withFailure(result.observed, failureBody({
      layer: 'driver',
      phase: 'pickup',
      code,
      observed: result.observed,
      facts,
      diagnosis: noStand ? 'NO_STAND_CELL' : noReturn ? 'NO_RETURN' : 'UNKNOWN',
      cause: {
        kind: budget ? 'budget' : 'world',
        code,
      },
      recovery: budget ? 'reobserve' : noStand || noReturn ? 'replan' : 'reobserve',
    })),
  }
}

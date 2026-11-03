import { isRecord } from '../contracts/index.ts'
import type { JsonValue } from '../contracts/types.ts'
import { classifyFailure } from './diagnostics.ts'

/**
 * One machine-readable failure projection. Drivers keep their existing
 * `observed` fields; this record is added under `observed.failure` so a wake,
 * `p2_report` or a replay can answer "where, why, what next" without parsing
 * driver-specific shapes.
 *
 * `suggestions` are evidence, not commands: at most three deterministic
 * actions, each tagged exact or candidate, and never executed by P2Mind.
 */
export type FailureLayer =
  | 'port'
  | 'motion'
  | 'driver'
  | 'world'
  | 'authority'
  | 'budget'
  | 'definition'

export type FailurePhase =
  | 'observe'
  | 'approach'
  | 'execute'
  | 'readback'
  | 'pickup'
  | 'release'
  | 'plan'
  | 'unknown'

export type FailureConfidence = 'exact' | 'candidate'

export type FailureSuggestion = {
  action: string
  params?: Record<string, JsonValue>
  confidence: FailureConfidence
  why: string
}

export type FailureCauseKind =
  | 'provider'
  | 'world'
  | 'authority'
  | 'budget'
  | 'definition'
  | 'unknown'

export type FailureCause = {
  kind: FailureCauseKind
  code?: string
  detail?: string
}

export type FailureRecovery = {
  kind: 'retry' | 'replan' | 'reobserve' | 'wait' | 'restart' | 'none'
  detail?: string
}

export type FailureBody = {
  layer: FailureLayer
  phase: FailurePhase
  code: string
  facts: Record<string, JsonValue>
  cause: FailureCause
  recovery?: FailureRecovery
  suggestions?: FailureSuggestion[]
}

/** One bounded cell in a failure snapshot; `name` is null when unloaded. */
export type FailureSnapshotCell = {
  cell: [number, number, number]
  name: string | null
  loaded: boolean
}

export type FailureSnapshotBody = {
  feet: FailureSnapshotCell
  head: FailureSnapshotCell
  support: FailureSnapshotCell
}

/**
 * Facts captured next to the failure so the next Agent turn does not need a
 * second observation. At most 16 unique cells, no path/candidate/visited data.
 */
export type FailureSnapshot = {
  cellCount: number
  self: FailureSnapshotBody
  target: FailureSnapshotBody
  targetNeighbors: FailureSnapshotCell[]
  bodyOverlap: FailureSnapshotCell[]
  pathStatus: string | null
  bestReachable: [number, number, number] | null
}

type SnapshotPort = {
  self(): { pos: { x: number; y: number; z: number } }
  blockAt(p: { x: number; y: number; z: number }): { name: string; loaded: boolean } | null
}

/** Facts are copied from the same snapshot; this is the only whitelist. */
const FACT_KEYS = new Set([
  'at',
  'pos',
  'from',
  'target',
  'activeTarget',
  'cell',
  'move',
  'detail',
  'phase',
  'pathStatus',
  'path',
  'bestReachable',
  'bodyOverlap',
  'blockedBy',
  'blockedAhead',
  'adjacent',
  'skippedStands',
  'probe',
  'requiredDig',
  'skipped',
  'partial',
  'dug',
  'stoppedAt',
  'item',
  'count',
  'entityId',
  'attempted',
  'crafted',
  'produced',
  'before',
  'after',
  'standQuery',
  'support',
  'lastAction',
  'controlState',
  'controlRelease',
  'effect',
  'retrySafe',
  'arrival',
  'reason',
  'candidates',
  'nearbyCandidates',
  'snapshot',
  'supports',
  'suggestedCells',
])

const MAX_FACT_ARRAY = 8
const MAX_FACT_RECORD_KEYS = 16

export function failureFacts(observed: JsonValue | undefined): Record<string, JsonValue> {
  if (!isRecord(observed)) return {}
  const facts: Record<string, JsonValue> = {}
  for (const key of FACT_KEYS) {
    const value = observed[key]
    if (value === undefined) continue
    const bounded = boundFact(value)
    if (bounded !== undefined) facts[key] = bounded
  }
  return facts
}

/**
 * Read one failure-time snapshot through the caller's own port. The helper is
 * deliberately bounded: it reads only self/target feet/head/support, four
 * target neighbours and up to four body-overlap cells, and writes at most 16
 * unique cells. It never copies the path, candidates or visited nodes.
 */
export function failureSnapshot(
  port: SnapshotPort,
  target: { x: number; y: number; z: number },
  observed?: JsonValue,
): FailureSnapshot {
  const cells = new Map<string, FailureSnapshotCell>()
  const read = (x: number, y: number, z: number): FailureSnapshotCell => {
    const key = `${x},${y},${z}`
    const existing = cells.get(key)
    if (existing !== undefined) return existing
    const block = port.blockAt({ x, y, z })
    const cell: FailureSnapshotCell = {
      cell: [x, y, z],
      name: block?.name ?? null,
      loaded: block?.loaded === true,
    }
    if (cells.size < 16) cells.set(key, cell)
    return cell
  }
  const body = (x: number, y: number, z: number): FailureSnapshotBody => ({
    feet: read(x, y, z),
    head: read(x, y + 1, z),
    support: read(x, y - 1, z),
  })

  const selfPos = floorCell(port.self().pos)
  const targetPos = floorCell(target)
  const self = body(selfPos.x, selfPos.y, selfPos.z)
  const targetBody = body(targetPos.x, targetPos.y, targetPos.z)
  const targetNeighbors = [
    read(targetPos.x + 1, targetPos.y, targetPos.z),
    read(targetPos.x - 1, targetPos.y, targetPos.z),
    read(targetPos.x, targetPos.y, targetPos.z + 1),
    read(targetPos.x, targetPos.y, targetPos.z - 1),
  ]
  const bodyOverlap = overlapCells(observed).slice(0, 4)
    .map(cell => read(cell.x, cell.y, cell.z))
  const pathStatus = isRecord(observed) && typeof observed.pathStatus === 'string'
    ? observed.pathStatus
    : null
  const bestReachable = isRecord(observed) && isCell(observed.bestReachable)
    ? [observed.bestReachable.x, observed.bestReachable.y, observed.bestReachable.z] as [number, number, number]
    : null

  return {
    cellCount: cells.size,
    self,
    target: targetBody,
    targetNeighbors,
    bodyOverlap,
    pathStatus,
    bestReachable,
  }
}

export function failureBody(input: {
  layer: FailureLayer
  phase: FailurePhase
  code: string
  observed?: JsonValue | undefined
  facts?: Record<string, JsonValue> | undefined
  cause: FailureCause
  recovery?: FailureRecovery | undefined
  suggestions?: FailureSuggestion[] | undefined
}): FailureBody {
  const facts: Record<string, JsonValue> = {
    ...failureFacts(input.observed),
    ...(input.facts ?? {}),
  }
  const suggestions = input.suggestions === undefined
    ? undefined
    : uniqueSuggestions(input.suggestions)
  return {
    layer: input.layer,
    phase: input.phase,
    code: input.code,
    facts,
    cause: input.cause,
    ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
    ...(suggestions === undefined || suggestions.length === 0 ? {} : { suggestions }),
  }
}

/** Add the failure projection while preserving the driver's existing evidence. */
export function withFailure(observed: JsonValue | undefined, failure: FailureBody): JsonValue {
  const base: Record<string, JsonValue> = isRecord(observed)
    ? observed
    : observed === undefined
      ? {}
      : { provider: observed }
  return { ...base, failure: failure as unknown as JsonValue }
}

export function readFailure(observed: JsonValue | undefined): FailureBody | undefined {
  if (!isRecord(observed) || !isRecord(observed.failure)) return undefined
  const failure = observed.failure
  if (typeof failure.code !== 'string' || typeof failure.layer !== 'string' || typeof failure.phase !== 'string') {
    return undefined
  }
  return failure as unknown as FailureBody
}

/**
 * Provider/port failures never suggest a game action. The only safe next
 * steps are to re-observe, wait, or restart the provider.
 */
export function providerFailureSuggestions(code: string): FailureSuggestion[] {
  const suggestions: FailureSuggestion[] = [
    {
      action: 'reobserve',
      confidence: 'exact',
      why: 'the effect is unknown; read the world before deciding the next order',
    },
  ]
  if (code === 'STOP_UNCONFIRMED') {
    suggestions.push(
      { action: 'wait', confidence: 'candidate', why: 'release may still settle before the next action' },
      { action: 'restart-provider', confidence: 'candidate', why: 'restart the body if release stays unconfirmed' },
    )
  } else if (code === 'ACT_TIMEOUT') {
    suggestions.push({ action: 'wait', confidence: 'candidate', why: 'the action may still complete within the server tick' })
  } else {
    suggestions.push({ action: 'wait', confidence: 'candidate', why: 'give the server a moment before re-observing' })
  }
  return suggestions
}

/**
 * Last-resort projection for a failed job whose driver did not attach a
 * specific failure body. It keeps the generic wake/report contract uniform
 * without inventing game advice.
 */
export function ensureFailureObserved(
  observed: JsonValue | undefined,
  code: string | undefined,
  driverId?: string,
): JsonValue {
  if (readFailure(observed) !== undefined) return observed as JsonValue
  const resolved = code ?? 'DRIVER_FAILED'
  const category = classifyFailure(resolved).category
  const kind = category === 'safety'
    ? 'authority'
    : category === 'budget'
      ? 'budget'
      : category === 'unknown'
        ? 'unknown'
        : 'world'
  return withFailure(observed, failureBody({
    layer: 'driver',
    phase: 'unknown',
    code: resolved,
    observed,
    facts: driverId === undefined ? undefined : { driverId },
    cause: { kind, code: resolved },
    recovery: kind === 'authority' ? { kind: 'none' } : { kind: 'reobserve' },
  }))
}

function uniqueSuggestions(suggestions: FailureSuggestion[]): FailureSuggestion[] {
  const seen = new Set<string>()
  const result: FailureSuggestion[] = []
  for (const suggestion of suggestions) {
    const key = `${suggestion.action}:${JSON.stringify(suggestion.params ?? {})}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(suggestion)
    if (result.length >= 3) break
  }
  return result
}

function floorCell(p: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

function overlapCells(observed: JsonValue | undefined): Array<{ x: number; y: number; z: number }> {
  if (!isRecord(observed)) return []
  const value = observed.bodyOverlap
  const blocks = isRecord(value) && Array.isArray(value.blocks)
    ? value.blocks
    : Array.isArray(value) ? value : []
  const cells: Array<{ x: number; y: number; z: number }> = []
  for (const item of blocks.slice(0, 8)) {
    if (!isRecord(item)) continue
    const cell = isRecord(item.cell) && isCell(item.cell) ? item.cell : item
    if (!isCell(cell)) continue
    cells.push({ x: cell.x, y: cell.y, z: cell.z })
  }
  return cells
}

function isCell(value: unknown): value is { x: number; y: number; z: number } {
  return isRecord(value)
    && typeof value.x === 'number'
    && typeof value.y === 'number'
    && typeof value.z === 'number'
}

function boundFact(value: JsonValue): JsonValue | undefined {
  if (Array.isArray(value)) {
    return value.slice(0, MAX_FACT_ARRAY).map(item => boundFact(item) ?? null)
  }
  if (isRecord(value)) {
    const output: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value).slice(0, MAX_FACT_RECORD_KEYS)) {
      const bounded = boundFact(item)
      if (bounded !== undefined) output[key] = bounded
    }
    return output
  }
  return value
}

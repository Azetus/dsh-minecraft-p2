import { isRecord } from '../contracts/index.ts'
import type { JsonValue } from '../contracts/types.ts'
import { classifyFailure } from './diagnostics.ts'

/**
 * One machine-readable failure projection. Drivers keep their existing
 * `observed` fields; this record is added under `observed.failure` so a wake,
 * `p2_report` or a replay can answer "where, why, what next" without parsing
 * driver-specific shapes.
 *
 * `diagnosis` is one closed classification over the same facts; `recovery` is
 * a contract-level next mode, not a game action.
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

export type FailureDiagnosis =
  | 'HEAD_BLOCKED'
  | 'SUPPORT_MISSING'
  | 'TARGET_UNLOADED'
  | 'TARGET_OCCUPIED'
  | 'START_EMBEDDED'
  | 'NO_STAND_CELL'
  | 'NO_RETURN'
  | 'EFFECT_UNCONFIRMED'
  | 'RELEASE_UNCONFIRMED'
  | 'TOOL_MISSING'
  | 'DENIED'
  | 'UNKNOWN'

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

export type FailureRecovery = 'retry' | 'replan' | 'reobserve' | 'wait' | 'restart' | 'none'

export type FailureBody = {
  layer: FailureLayer
  phase: FailurePhase
  code: string
  facts: Record<string, JsonValue>
  diagnosis: FailureDiagnosis
  cause: FailureCause
  recovery: FailureRecovery
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
  'planned',
  'stoppedAt',
  'causeCode',
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
  'budget',
  'elapsedMs',
  'elapsedGameAge',
  'unreachableDrops',
  'noReturnDrops',
  'placedAt',
  'placedCells',
  'changedCells',
  'itemConsumed',
  'retrySafe',
  'occupied',
  'supportMatchesExpected',
  'suggestedTarget',
  'itemCountBefore',
  'itemCountAfter',
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
  diagnosis?: FailureDiagnosis | undefined
  recovery?: FailureRecovery | undefined
}): FailureBody {
  const facts: Record<string, JsonValue> = {
    ...failureFacts(input.observed),
    ...(input.facts ?? {}),
  }
  const diagnosis = input.diagnosis ?? diagnoseFailure({ code: input.code, observed: input.observed, facts })
  return {
    layer: input.layer,
    phase: input.phase,
    code: input.code,
    facts,
    diagnosis,
    cause: input.cause,
    recovery: input.recovery ?? defaultRecovery(diagnosis),
  }
}

const TOOL_CODES = new Set([
  'TOOL_INSUFFICIENT',
  'EQUIP_NO_ITEM',
  'USE_NO_ITEM',
  'PLACE_NO_ITEM',
])

const UNLOADED_CODES = new Set([
  'GOTO_TARGET_UNLOADED',
  'OBSERVATION_UNAVAILABLE',
])

const NO_STAND_CODES = new Set([
  'GOAL_NOT_STANDABLE',
  'APPROACH_NO_STAND',
  'GOTO_INVALID_TARGET',
  'NO_STAND',
  'PICKUP_UNREACHABLE',
  'COLLECT_UNREACHABLE',
])

/** Codes that share the placement diagnosis order. */
const PLACE_CODES = new Set([
  'PLACE_FAILED',
  'PLACE_UNSUPPORTED',
  'NO_SUPPORT',
  'PLACE_BLOCKED_BY_SELF',
])

/**
 * One closed classification per failure. The classifier reads only facts the
 * driver already captured; when they do not prove a cause it returns UNKNOWN
 * instead of guessing an action.
 */
export function diagnoseFailure(input: {
  code: string
  observed?: JsonValue | undefined
  facts?: Record<string, JsonValue> | undefined
}): FailureDiagnosis {
  const code = input.code
  if (code === 'STOP_UNCONFIRMED') return 'RELEASE_UNCONFIRMED'
  if (code === 'ACT_UNCONFIRMED' || code === 'CLIENT_TIMEOUT') return 'EFFECT_UNCONFIRMED'
  if (code === 'ACTION_DENIED') return 'DENIED'
  if (code === 'PLACE_TARGET_OCCUPIED') return 'TARGET_OCCUPIED'
  if (TOOL_CODES.has(code)) return 'TOOL_MISSING'
  // PICKUP_UNREACHABLE is the drop-specific "no reachable stand cell" code;
  // its requiredDig lists the blocking cells, not a body head/support fault.
  if (code === 'PICKUP_UNREACHABLE' || code === 'COLLECT_UNREACHABLE') return 'NO_STAND_CELL'
  // NO_RETURN is a topology fault: the only pickup cell is a one-way pocket.
  // It must not fold into NO_STAND_CELL, which means "cannot get there".
  if (code === 'PICKUP_NO_RETURN' || code === 'COLLECT_NO_RETURN') return 'NO_RETURN'

  const facts = input.facts ?? failureFacts(input.observed)
  const snapshot = isRecord(facts.snapshot) ? facts.snapshot : undefined
  const self = snapshotBody(snapshot, 'self')
  const target = snapshotBody(snapshot, 'target')
  const blocked = blockedLayers(facts)
  const overlap = snapshot !== undefined && Array.isArray(snapshot.bodyOverlap)
    ? snapshot.bodyOverlap
    : []
  // Placement has its own closed order: embedded body first, then the six-face
  // support read, then an explicit server refusal, then UNKNOWN.
  if (PLACE_CODES.has(code)) return diagnosePlaceFailure(code, facts, overlap)
  if (code === 'BODY_OVERLAP' || overlap.length > 0) return 'START_EMBEDDED'
  if (UNLOADED_CODES.has(code) || target?.feet.loaded === false) return 'TARGET_UNLOADED'
  if (target?.support !== undefined && !target.support.loaded) return 'TARGET_UNLOADED'
  if (self?.support !== undefined && !self.support.loaded) return 'TARGET_UNLOADED'
  if (blocked.has('head')) return 'HEAD_BLOCKED'
  if (self?.head.loaded === true && isBlockingName(self.head.name)) return 'HEAD_BLOCKED'
  if (target?.head.loaded === true && isBlockingName(target.head.name)) return 'HEAD_BLOCKED'
  if (blocked.has('support')) return 'SUPPORT_MISSING'
  if (code === 'PLACE_UNSUPPORTED' || code === 'NO_SUPPORT') {
    const supportFlags = readSupports(facts.supports)
    if (supportFlags === undefined || !supportFlags.some(Boolean)) return 'SUPPORT_MISSING'
  }
  if (target?.support.loaded === true && !isSolidName(target.support.name)) return 'SUPPORT_MISSING'
  if (self?.support.loaded === true && !isSolidName(self.support.name)) return 'SUPPORT_MISSING'
  if (NO_STAND_CODES.has(code)) return 'NO_STAND_CELL'
  return 'UNKNOWN'
}

/**
 * Placement order from the contract: a target inside the body beats every
 * other cause, then a six-face support read, then an explicit refusal.
 */
function diagnosePlaceFailure(
  code: string,
  facts: Record<string, JsonValue>,
  overlap: JsonValue[],
): FailureDiagnosis {
  if (code === 'PLACE_BLOCKED_BY_SELF' || facts.blockedBy === 'self' || overlap.length > 0) {
    return 'START_EMBEDDED'
  }
  if (code === 'PLACE_UNSUPPORTED' || code === 'NO_SUPPORT') return 'SUPPORT_MISSING'
  const supportFlags = readSupports(facts.supports)
  if (supportFlags !== undefined && !supportFlags.some(Boolean)) return 'SUPPORT_MISSING'
  const denial = facts.denial
  if (facts.providerCode === 'ACTION_DENIED'
    || (isRecord(denial) && typeof denial.text === 'string')) return 'DENIED'
  return 'UNKNOWN'
}

function defaultRecovery(diagnosis: FailureDiagnosis): FailureRecovery {
  if (diagnosis === 'DENIED' || diagnosis === 'START_EMBEDDED') return 'none'
  if (diagnosis === 'RELEASE_UNCONFIRMED') return 'restart'
  if (diagnosis === 'UNKNOWN' || diagnosis === 'EFFECT_UNCONFIRMED' || diagnosis === 'TARGET_UNLOADED') {
    return 'reobserve'
  }
  return 'replan'
}

function snapshotBody(
  snapshot: Record<string, JsonValue> | undefined,
  key: 'self' | 'target',
): { feet: SnapshotCellView; head: SnapshotCellView; support: SnapshotCellView } | undefined {
  const body = snapshot?.[key]
  if (!isRecord(body)) return undefined
  const feet = snapshotCell(body.feet)
  const head = snapshotCell(body.head)
  const support = snapshotCell(body.support)
  if (feet === undefined || head === undefined || support === undefined) return undefined
  return { feet, head, support }
}

type SnapshotCellView = { name: string | null; loaded: boolean }

function snapshotCell(value: JsonValue | undefined): SnapshotCellView | undefined {
  if (!isRecord(value)) return undefined
  return {
    name: typeof value.name === 'string' ? value.name : null,
    loaded: value.loaded === true,
  }
}

function blockedLayers(facts: Record<string, JsonValue>): Set<string> {
  const layers = new Set<string>()
  for (const key of ['blockedBy', 'requiredDig'] as const) {
    const value = facts[key]
    const entries = Array.isArray(value) ? value : isRecord(value) ? [value] : []
    for (const entry of entries.slice(0, 8)) {
      if (!isRecord(entry) || typeof entry.layer !== 'string') continue
      layers.add(entry.layer)
    }
  }
  return layers
}

function readSupports(value: JsonValue | undefined): boolean[] | undefined {
  if (!isRecord(value)) return undefined
  const values = Object.values(value).filter((entry): entry is boolean => typeof entry === 'boolean')
  return values.length === 0 ? undefined : values
}

function isBlockingName(name: string | null): boolean {
  return name !== null && !isAirName(name) && name !== 'water' && name !== 'lava'
}

function isSolidName(name: string | null): boolean {
  return name !== null && isBlockingName(name)
}

function isAirName(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
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
  // Budget exhaustion is a tracker-level stop, not a driver result: keep that
  // distinction visible even when the driver never attached a failure body.
  const budgetExhausted = resolved === 'BUDGET_EXCEEDED'
  const kind = category === 'safety'
    ? 'authority'
    : category === 'budget'
      ? 'budget'
      : category === 'definition'
        ? 'definition'
        : category === 'unknown'
          ? 'unknown'
          : 'world'
  return withFailure(observed, failureBody({
    layer: budgetExhausted ? 'budget' : 'driver',
    phase: budgetExhausted ? 'execute' : 'unknown',
    code: resolved,
    observed,
    facts: driverId === undefined ? undefined : { driverId },
    cause: { kind, code: resolved },
    recovery: kind === 'authority' || kind === 'definition' ? 'none' : 'reobserve',
  }))
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

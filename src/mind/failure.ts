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

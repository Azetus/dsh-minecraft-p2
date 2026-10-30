/**
 * Strategy artifact contract (agent-authored content).
 *
 * A strategy is a single-file module that calls `defineStrategy({ manifest,
 * evaluate })`. `evaluate` is synchronous, receives plain JSON facts and
 * returns a plain JSON verdict; it cannot import, call operations, hold host
 * handles or use timers. The host resolves declared act ids at check time and
 * stamps slot/holder/attempt identity on every proposal.
 */

import type { JsonValue } from './types.ts'

export const STRATEGY_SLOTS = ['S0', 'S1', 'S2', 'S3'] as const
export type StrategySlot = (typeof STRATEGY_SLOTS)[number]

export const STRATEGY_HAZARD_CLASSES = ['lethal', 'bleeding-fire', 'trapped'] as const
export type StrategyHazardClass = (typeof STRATEGY_HAZARD_CLASSES)[number]

export type StrategyManifest = {
  id: string
  version: string
  description?: string
  slot: StrategySlot
  /** Required for S0: the conflict-matrix class. */
  hazardClass?: StrategyHazardClass
  /** Observation keys the host must supply; must be registered fact sources. */
  facts: string[]
  /** Act definition ids this strategy proposes. */
  acts?: string[]
}

export type StrategyActionShape = {
  intent: string
  act: string
  args?: Record<string, JsonValue>
}

export type StrategyDiagnosticShape = {
  code: string
  message: string
  detail?: JsonValue
}

/**
 * Wire verdict returned by an artifact strategy. It is intentionally pure JSON:
 * the host maps it onto the in-process StrategyVerdict and owns identity.
 */
export type StrategyVerdictShape =
  | { kind: 'idle'; checkpoint?: JsonValue }
  | { kind: 'unknown'; missing: string[]; checkpoint?: JsonValue }
  | ({ kind: 'propose'; checkpoint?: JsonValue } & StrategyActionShape)
  | { kind: 'running'; intent: string; progress?: { step?: string; fraction?: number; detail?: JsonValue }; checkpoint?: JsonValue }
  | { kind: 'wait'; until: string; deadlineMs: number; checkpoint?: JsonValue }
  | {
    kind: 'recover'
    reason: string
    leasePriority: 'interrupt' | 'boundary'
    action?: StrategyActionShape
    checkpoint?: JsonValue
  }
  | { kind: 'candidate-complete'; evidence: string[]; checkpoint?: JsonValue }
  | {
    kind: 'blocked'
    missing: string[]
    since?: number
    diagnostics: StrategyDiagnosticShape[]
    checkpoint?: JsonValue
  }

export class StrategyManifestError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'StrategyManifestError'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new StrategyManifestError(code, message)
}

function readStringArray(value: unknown, field: string, options: { required: boolean; nonEmpty?: boolean }): string[] | undefined {
  if (value === undefined) {
    if (options.required) fail('INVALID_STRATEGY_MANIFEST', `strategy manifest.${field} is required`)
    return undefined
  }
  if (!Array.isArray(value)) fail('INVALID_STRATEGY_MANIFEST', `strategy manifest.${field} must be an array`)
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      fail('INVALID_STRATEGY_MANIFEST', `strategy manifest.${field} must contain non-empty strings`)
    }
    if (options.nonEmpty === true && entry.trim().length === 0) {
      fail('INVALID_STRATEGY_MANIFEST', `strategy manifest.${field} must contain non-empty strings`)
    }
    if (!result.includes(entry)) result.push(entry)
  }
  return result
}

/** Validate the manifest captured from `defineStrategy`; fail closed. */
export function parseStrategyManifest(value: unknown): StrategyManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_STRATEGY_MANIFEST', 'strategy manifest must be an object')
  }
  const record = value as Record<string, unknown>
  const id = record.id
  if (typeof id !== 'string' || id.length === 0) fail('INVALID_STRATEGY_MANIFEST', 'strategy manifest.id is required')
  const version = record.version
  if (typeof version !== 'string' || version.length === 0) fail('INVALID_STRATEGY_MANIFEST', 'strategy manifest.version is required')
  const slot = record.slot
  if (slot !== 'S0' && slot !== 'S1' && slot !== 'S2' && slot !== 'S3') {
    fail('INVALID_STRATEGY_MANIFEST', 'strategy manifest.slot must be S0, S1, S2 or S3')
  }
  const hazardClass = record.hazardClass
  if (hazardClass !== undefined
    && hazardClass !== 'lethal'
    && hazardClass !== 'bleeding-fire'
    && hazardClass !== 'trapped') {
    fail('INVALID_STRATEGY_MANIFEST', 'strategy manifest.hazardClass must be lethal, bleeding-fire or trapped')
  }
  if (slot === 'S0' && hazardClass === undefined) {
    fail('INVALID_STRATEGY_MANIFEST', 'S0 strategies must declare hazardClass for the conflict matrix')
  }
  if (slot !== 'S0' && hazardClass !== undefined) {
    fail('INVALID_STRATEGY_MANIFEST', 'only S0 strategies may declare hazardClass')
  }
  const facts = readStringArray(record.facts, 'facts', { required: true, nonEmpty: true }) ?? []
  const acts = readStringArray(record.acts, 'acts', { required: false }) ?? []
  if (record.description !== undefined && typeof record.description !== 'string') {
    fail('INVALID_STRATEGY_MANIFEST', 'strategy manifest.description must be a string')
  }
  return {
    id,
    version,
    slot,
    facts,
    acts,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(hazardClass === undefined ? {} : { hazardClass }),
  }
}

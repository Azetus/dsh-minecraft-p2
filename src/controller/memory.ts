/**
 * Bounded action memory (P2CONTROLLER C3).
 *
 * The controller must not build a world model, but it does have to remember
 * that it just escaped water, which targets failed, and how many retries it
 * burned. Everything here is capped and time-windowed; the memory is a
 * diagnostic and decision aid, never a source of world truth.
 */

import type { EvidenceId } from './types.ts'

export type HazardRecord = {
  hazardId: string
  kind: string
  area: { x: number; y: number; z: number; radius: number }
  dimension?: string
  at: number
  expiresAt: number
  evidenceId?: EvidenceId
}

export type FailureRecord = {
  goal: string
  reason: string
  at: number
  evidenceId?: EvidenceId
}

export type EscapePhase = 'none' | 'escaping' | 'recovering' | 'verifying'

export type ActionMemoryOptions = {
  now?: () => number
  maxHazards?: number
  maxFailures?: number
  hazardTtlMs?: number
  /** A retry budget resets after this window. */
  retryWindowMs?: number
}

const DEFAULT_MAX_HAZARDS = 32
const DEFAULT_MAX_FAILURES = 16
const DEFAULT_HAZARD_TTL_MS = 60 * 60_000
const DEFAULT_RETRY_WINDOW_MS = 5 * 60_000

type RetryEntry = { used: number; startedAt: number }

export class ActionMemory {
  private readonly now: () => number
  private readonly maxHazards: number
  private readonly maxFailures: number
  private readonly hazardTtlMs: number
  private readonly retryWindowMs: number
  private hazardLog: HazardRecord[] = []
  private failureLog: FailureRecord[] = []
  private readonly retries = new Map<string, RetryEntry>()
  private escapePhaseValue: EscapePhase = 'none'
  private escapeSinceValue: number | undefined
  private escapeReasonValue: string | undefined

  constructor(options: ActionMemoryOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxHazards = options.maxHazards ?? DEFAULT_MAX_HAZARDS
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES
    this.hazardTtlMs = options.hazardTtlMs ?? DEFAULT_HAZARD_TTL_MS
    this.retryWindowMs = options.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS
  }

  get escapePhase(): EscapePhase {
    return this.escapePhaseValue
  }

  get escapeSince(): number | undefined {
    return this.escapeSinceValue
  }

  get escapeReason(): string | undefined {
    return this.escapeReasonValue
  }

  recordHazard(record: Omit<HazardRecord, 'expiresAt'> & { expiresAt?: number }): HazardRecord {
    const hazard: HazardRecord = {
      hazardId: record.hazardId,
      kind: record.kind,
      area: record.area,
      at: record.at,
      expiresAt: record.expiresAt ?? record.at + this.hazardTtlMs,
      ...(record.dimension === undefined ? {} : { dimension: record.dimension }),
      ...(record.evidenceId === undefined ? {} : { evidenceId: record.evidenceId }),
    }
    // Same hazard at the same place is one memory, refreshed rather than duplicated.
    const existing = this.hazardLog.findIndex(entry => entry.hazardId === hazard.hazardId)
    if (existing >= 0) this.hazardLog.splice(existing, 1)
    this.hazardLog.push(hazard)
    if (this.hazardLog.length > this.maxHazards) this.hazardLog.shift()
    return hazard
  }

  /** Unexpired hazards, newest last. */
  hazards(now = this.now()): HazardRecord[] {
    this.hazardLog = this.hazardLog.filter(hazard => hazard.expiresAt > now)
    return [...this.hazardLog]
  }

  /** Hazards whose area contains `position` (same dimension when both name one). */
  hazardsAt(position: { x: number; y: number; z: number }, dimension: string | undefined, now = this.now()): HazardRecord[] {
    return this.hazards(now).filter(hazard => {
      if (dimension !== undefined && hazard.dimension !== undefined && hazard.dimension !== dimension) return false
      const dx = position.x - hazard.area.x
      const dy = position.y - hazard.area.y
      const dz = position.z - hazard.area.z
      return Math.hypot(dx, dy, dz) <= hazard.area.radius
    })
  }

  recordFailure(record: FailureRecord): void {
    this.failureLog.push(record)
    if (this.failureLog.length > this.maxFailures) this.failureLog.shift()
  }

  failures(now = this.now(), windowMs = Number.POSITIVE_INFINITY): FailureRecord[] {
    return this.failureLog.filter(record => now - record.at <= windowMs)
  }

  failuresFor(goal: string, now = this.now(), windowMs = Number.POSITIVE_INFINITY): FailureRecord[] {
    return this.failures(now, windowMs).filter(record => record.goal === goal)
  }

  setEscapePhase(phase: EscapePhase, reason: string, at = this.now()): void {
    if (this.escapePhaseValue === phase) {
      this.escapeReasonValue = reason
      return
    }
    this.escapePhaseValue = phase
    this.escapeReasonValue = reason
    this.escapeSinceValue = phase === 'none' ? undefined : at
  }

  /**
   * Spend one retry from a named budget. Returns the attempt number (1-based)
   * or `undefined` when the budget is exhausted; the window resets it.
   */
  spendRetry(key: string, limit: number, at = this.now(), windowMs = this.retryWindowMs): number | undefined {
    const entry = this.retries.get(key)
    if (entry === undefined || at - entry.startedAt >= windowMs) {
      this.retries.set(key, { used: 1, startedAt: at })
      return 1
    }
    if (entry.used >= limit) return undefined
    entry.used += 1
    return entry.used
  }

  retryRemaining(key: string, limit: number, at = this.now(), windowMs = this.retryWindowMs): number {
    const entry = this.retries.get(key)
    if (entry === undefined || at - entry.startedAt >= windowMs) return limit
    return Math.max(0, limit - entry.used)
  }

  snapshot(now = this.now()): {
    hazards: HazardRecord[]
    failures: FailureRecord[]
    escapePhase: EscapePhase
    escapeSince: number | undefined
    escapeReason: string | undefined
    retries: Array<{ key: string; used: number; since: number }>
  } {
    const retries: Array<{ key: string; used: number; since: number }> = []
    for (const [key, entry] of this.retries) {
      if (now - entry.startedAt >= this.retryWindowMs) continue
      retries.push({ key, used: entry.used, since: entry.startedAt })
    }
    return {
      hazards: this.hazards(now),
      failures: this.failures(now),
      escapePhase: this.escapePhaseValue,
      escapeSince: this.escapeSinceValue,
      escapeReason: this.escapeReasonValue,
      retries,
    }
  }

  /** Clear time-windowed entries; called when death/respawn voids old targets. */
  reset(): void {
    this.hazardLog = []
    this.failureLog = []
    this.retries.clear()
    this.escapePhaseValue = 'none'
    this.escapeSinceValue = undefined
    this.escapeReasonValue = undefined
  }

}







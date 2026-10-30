/**
 * Observation bus (P2CONTROLLER §3.1 item 4, C3).
 *
 * A fact is a value plus its validity: `known|unknown`, `sampledAt`,
 * `validUntil`, `scope` and `evidenceId`. `unknown` is never `false`: readers
 * get an explicit reason, and multi-fact reads must fall inside the
 * coherence window before they may be used for one decision.
 */

import type { JsonValue } from '../contracts/types.ts'
import type { EvidenceId, Scope } from './types.ts'

export type Fact = {
  key: string
  value: JsonValue | null
  known: boolean
  sampledAt: number
  validUntil: number
  scope: Scope
  evidenceId: EvidenceId
  /** Why the fact is unknown; present only when `known` is false. */
  unknownReason?: 'missing' | 'expired' | 'invalidated' | 'stale-before-recovery'
}

export type FactSample = {
  key: string
  value: JsonValue
  scope: Scope
  sampledAt?: number
  ttlMs?: number
  evidenceId?: EvidenceId
  validUntil?: number
}

export type FactRead = {
  fact: Fact
  known: boolean
  reason?: Fact['unknownReason']
}

export type FactSet = {
  /** Only usable values; unknown keys are absent. */
  values: Record<string, JsonValue>
  facts: Record<string, Fact>
  known: string[]
  unknown: string[]
  reasons: Record<string, string>
  coherent: boolean
  coherenceGapMs: number
}

export type ReadOptions = {
  /** Facts sampled before this instant do not count (post-recovery re-verification). */
  freshSince?: number
}

export type ObservationBusOptions = {
  now?: () => number
  defaultTtlMs?: number
  /** Largest spread between the samples used for one decision. */
  coherenceWindowMs?: number
  maxFacts?: number
}

const DEFAULT_TTL_MS = 500
const DEFAULT_COHERENCE_WINDOW_MS = 500
const DEFAULT_MAX_FACTS = 128

export class ObservationBus {
  private readonly facts = new Map<string, Fact>()
  private readonly now: () => number
  private readonly defaultTtlMs: number
  private readonly coherenceWindowMs: number
  private readonly maxFacts: number
  private sequence = 0

  constructor(options: ObservationBusOptions = {}) {
    this.now = options.now ?? Date.now
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS
    this.coherenceWindowMs = options.coherenceWindowMs ?? DEFAULT_COHERENCE_WINDOW_MS
    this.maxFacts = options.maxFacts ?? DEFAULT_MAX_FACTS
  }

  get windowMs(): number {
    return this.coherenceWindowMs
  }

  /** Publish one sampled fact; the newest sample replaces the old evidence. */
  publish(sample: FactSample): Fact {
    const sampledAt = sample.sampledAt ?? this.now()
    const fact: Fact = {
      key: sample.key,
      value: sample.value,
      known: true,
      sampledAt,
      validUntil: sample.validUntil ?? sampledAt + (sample.ttlMs ?? this.defaultTtlMs),
      scope: sample.scope,
      evidenceId: sample.evidenceId ?? `fact-${++this.sequence}`,
    }
    this.facts.set(sample.key, fact)
    this.evict()
    return fact
  }

  /**
   * Invalidate every fact whose scope starts with `scopePrefix` (death,
   * respawn, dimension change): the old goals and observations are void.
   */
  invalidateScope(scopePrefix: string): number {
    let count = 0
    for (const [key, fact] of this.facts) {
      if (!fact.scope.startsWith(scopePrefix)) continue
      this.facts.set(key, { ...fact, known: false, unknownReason: 'invalidated' })
      count += 1
    }
    return count
  }

  invalidateAll(): number {
    return this.invalidateScope('')
  }

  read(key: string, now = this.now(), options: ReadOptions = {}): FactRead {
    const fact = this.facts.get(key)
    if (fact === undefined) {
      return {
        fact: { key, value: null, known: false, sampledAt: 0, validUntil: 0, scope: '', evidenceId: '', unknownReason: 'missing' },
        known: false,
        reason: 'missing',
      }
    }
    const reason = this.invalidReason(fact, now, options)
    if (reason !== undefined) {
      return { fact: { ...fact, known: false, unknownReason: reason }, known: false, reason }
    }
    return { fact, known: true }
  }

  /**
   * Read the facts one decision needs. `coherent` is false when the usable
   * samples span more than the coherence window; the older samples are then
   * reported unknown so a caller cannot silently stitch stale values together.
   */
  readMany(keys: readonly string[], now = this.now(), options: ReadOptions = {}): FactSet {
    const facts: Record<string, Fact> = {}
    const known: string[] = []
    const unknown: string[] = []
    const reasons: Record<string, string> = {}
    const values: Record<string, JsonValue> = {}

    for (const key of keys) {
      const read = this.read(key, now, options)
      facts[key] = read.fact
      if (read.known) {
        known.push(key)
        values[key] = read.fact.value as JsonValue
      } else {
        unknown.push(key)
        reasons[key] = read.reason ?? 'unknown'
      }
    }

    let gap = 0
    let coherent = true
    if (known.length > 1) {
      const times = known.map(key => facts[key]?.sampledAt ?? 0)
      gap = Math.max(...times) - Math.min(...times)
      coherent = gap <= this.coherenceWindowMs
      if (!coherent) {
        const newest = Math.max(...times)
        for (const key of [...known]) {
          const fact = facts[key]
          if (fact === undefined || newest - fact.sampledAt <= this.coherenceWindowMs) continue
          known.splice(known.indexOf(key), 1)
          unknown.push(key)
          reasons[key] = 'incoherent'
          facts[key] = { ...fact, known: false, unknownReason: 'expired' }
          delete values[key]
        }
      }
    }
    return { values, facts, known, unknown, reasons, coherent, coherenceGapMs: gap }
  }

  /** Diagnostic view; bounded by construction. */
  snapshot(keys?: readonly string[]): Fact[] {
    const all = keys === undefined ? [...this.facts.values()] : keys.map(key => this.facts.get(key)).filter((fact): fact is Fact => fact !== undefined)
    return all.map(fact => ({ ...fact }))
  }

  private invalidReason(fact: Fact, now: number, options: ReadOptions): Fact['unknownReason'] | undefined {
    if (!fact.known) return fact.unknownReason ?? 'invalidated'
    if (now >= fact.validUntil) return 'expired'
    if (options.freshSince !== undefined && fact.sampledAt < options.freshSince) return 'stale-before-recovery'
    return undefined
  }

  /** Keep the bus bounded: drop the oldest known fact when above capacity. */
  private evict(): void {
    if (this.facts.size <= this.maxFacts) return
    let oldestKey: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, fact] of this.facts) {
      if (fact.sampledAt < oldestAt) {
        oldestAt = fact.sampledAt
        oldestKey = key
      }
    }
    if (oldestKey !== undefined) this.facts.delete(oldestKey)
  }
}

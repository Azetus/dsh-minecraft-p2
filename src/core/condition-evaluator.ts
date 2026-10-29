import { p2Error } from '../contracts/protocol.ts'
import type { JsonValue, P2Error, ValueMeta } from '../contracts/types.ts'
import type { PolicyOutcome, QueryOutcome, QueryPort } from './node-runtime.ts'

/** One query declared by a guard or watch condition. */
export type DeclaredQuery = {
  op: string
  args?: Record<string, JsonValue>
}

/** A sample result; failed samples carry the structured error. */
export type Sample = {
  status: 'ok' | 'failed'
  value?: JsonValue
  meta?: ValueMeta
  error?: P2Error
}

export type PredicateInput = {
  /** Samples keyed by declaration index, matching the documented shape. */
  samples: Record<string, JsonValue>
  now: number
}

export type PredicateValue =
  | boolean
  | { fire: boolean; evidence?: JsonValue; key?: string; summary?: string }

export type PredicateCall =
  | { status: 'ok'; value: PredicateValue }
  | { status: 'failed'; error: P2Error }
  | { status: 'pending'; poll: () => PredicateCall }

export type ConditionEvaluatorOptions = {
  queries: readonly DeclaredQuery[]
  query: QueryPort
  /** Pure predicate step; may be pending (policy runner) or synchronous (sugar). */
  evaluate: (input: PredicateInput) => PredicateCall
  queryTimeoutMs?: number
  predicateTimeoutMs?: number
}

export type ConditionOutcome =
  | {
      status: 'fire' | 'quiet'
      samples: Record<string, JsonValue>
      sampledAt: number
      evidence?: JsonValue
      key?: string
      summary?: string
    }
  | {
      status: 'failed'
      error: P2Error
      samples: Record<string, JsonValue>
    }

const DEFAULT_TIMEOUT_MS = 1000

/**
 * Shared "declared queries + pure policy" evaluator used by guard conditions
 * and watch predicates.
 *
 * One round samples the declared queries sequentially (one in flight at a
 * time, 1s deadline each), rejects stale or failed samples, then calls the
 * predicate once. Pending work never blocks the caller; `advance` returns
 * `undefined` until the round settles.
 */
export class ConditionEvaluator {
  private readonly queries: readonly DeclaredQuery[]
  private readonly query: QueryPort
  private readonly evaluate: (input: PredicateInput) => PredicateCall
  private readonly queryTimeoutMs: number
  private readonly predicateTimeoutMs: number

  private index = 0
  private samples: Sample[] = []
  private inFlight: { poll: () => QueryOutcome; startedAt: number } | undefined
  private predicate: { poll: () => PredicateCall; startedAt: number } | undefined
  private phase: 'query' | 'predicate' = 'query'
  private running = false

  constructor(options: ConditionEvaluatorOptions) {
    this.queries = [...options.queries]
    this.query = options.query
    this.evaluate = options.evaluate
    this.queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.predicateTimeoutMs = options.predicateTimeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get active(): boolean {
    return this.running
  }

  /** Begin one round; ignored while a round is already active. */
  start(): void {
    if (this.running) return
    this.running = true
    this.index = 0
    this.samples = []
    this.inFlight = undefined
    this.predicate = undefined
    this.phase = 'query'
  }

  /** Advance the round; `undefined` means it is still pending. */
  advance(now: number): ConditionOutcome | undefined {
    if (!this.running) return undefined
    if (this.phase === 'query') {
      const state = this.advanceQueries(now)
      if (state === 'pending') return undefined
      if (typeof state === 'object') {
        this.running = false
        return state
      }
      const outcome = this.startPredicate(now)
      if (outcome !== undefined) this.running = false
      return outcome
    }
    const outcome = this.advancePredicate(now)
    if (outcome !== undefined) this.running = false
    return outcome
  }

  private advanceQueries(now: number): 'pending' | 'done' | ConditionOutcome {
    if (this.inFlight !== undefined) {
      if (now - this.inFlight.startedAt > this.queryTimeoutMs) {
        this.inFlight = undefined
        this.samples.push({
          status: 'failed',
          error: p2Error('GUARD_QUERY_TIMEOUT', 'timeout', 'declared query timed out', { module: 'core.condition' }),
        })
      } else {
        const outcome = this.inFlight.poll()
        if (outcome.status === 'pending') return 'pending'
        this.inFlight = undefined
        this.pushOutcome(outcome)
        if (this.samples.at(-1)?.status === 'failed') return this.failure()
      }
    }
    while (this.index < this.queries.length) {
      const query = this.queries[this.index] as DeclaredQuery
      let outcome: QueryOutcome
      try {
        outcome = this.query({ op: query.op, args: {} }, query.args ?? {})
      } catch (error) {
        outcome = {
          status: 'failed',
          error: p2Error(
            'GUARD_QUERY_FAILED',
            'runtime',
            error instanceof Error ? error.message : String(error),
            { module: 'core.condition', opId: query.op },
          ),
        }
      }
      if (outcome.status === 'pending') {
        this.inFlight = { poll: outcome.poll, startedAt: now }
        return 'pending'
      }
      this.pushOutcome(outcome)
      if (this.samples.at(-1)?.status === 'failed') return this.failure()
    }
    return 'done'
  }

  private pushOutcome(outcome: Exclude<QueryOutcome, { status: 'pending' }>): void {
    if (outcome.status === 'ok') {
      this.samples.push({
        status: 'ok',
        value: outcome.value,
        ...(outcome.meta === undefined ? {} : { meta: outcome.meta }),
      })
    } else {
      this.samples.push({ status: 'failed', error: outcome.error })
    }
    this.index += 1
  }

  private failure(): ConditionOutcome {
    const failed = this.samples.find(sample => sample.status === 'failed')
    return {
      status: 'failed',
      error: failed?.error ?? p2Error('GUARD_QUERY_FAILED', 'runtime', 'declared query failed', { module: 'core.condition' }),
      samples: this.payload(),
    }
  }

  private startPredicate(now: number): ConditionOutcome | undefined {
    this.phase = 'predicate'
    const failed = this.samples.find(sample => sample.status === 'failed')
    if (failed !== undefined) return this.failure()
    const stale = this.samples.findIndex(sample => sample.meta?.validUntil !== undefined && now > sample.meta.validUntil)
    if (stale >= 0) {
      return {
        status: 'failed',
        error: p2Error('STALE_OBSERVATION', 'runtime', `sample ${stale} is stale`, { module: 'core.condition' }),
        samples: this.payload(),
      }
    }
    const input: PredicateInput = { samples: this.payload(), now }
    let call: PredicateCall
    try {
      call = this.evaluate(input)
    } catch (error) {
      call = {
        status: 'failed',
        error: p2Error('GUARD_POLICY_FAILED', 'runtime', error instanceof Error ? error.message : String(error), { module: 'core.condition' }),
      }
    }
    return this.consumePredicate(call, now)
  }

  private advancePredicate(now: number): ConditionOutcome | undefined {
    const current = this.predicate
    if (current === undefined) return undefined
    if (now - current.startedAt > this.predicateTimeoutMs) {
      this.predicate = undefined
      return {
        status: 'failed',
        error: p2Error('GUARD_POLICY_TIMEOUT', 'timeout', 'predicate timed out', { module: 'core.condition' }),
        samples: this.payload(),
      }
    }
    const call = current.poll()
    if (call.status === 'pending') {
      this.predicate = { poll: call.poll, startedAt: current.startedAt }
      return undefined
    }
    this.predicate = undefined
    return this.consumePredicate(call, now)
  }

  private consumePredicate(call: PredicateCall, now: number): ConditionOutcome | undefined {
    if (call.status === 'pending') {
      this.predicate = { poll: call.poll, startedAt: now }
      return undefined
    }
    if (call.status === 'failed') {
      return { status: 'failed', error: call.error, samples: this.payload() }
    }
    const value = call.value
    if (typeof value === 'boolean') {
      return this.complete(value, undefined, now)
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)
      && typeof (value as { fire?: unknown }).fire === 'boolean') {
      const record = value as { fire: boolean; evidence?: JsonValue; key?: unknown; summary?: unknown }
      if ((record.key !== undefined && typeof record.key !== 'string')
        || (record.summary !== undefined && typeof record.summary !== 'string')) {
        return {
          status: 'failed',
          error: p2Error('GUARD_POLICY_RESULT_INVALID', 'runtime', 'predicate key/summary must be strings', { module: 'core.condition' }),
          samples: this.payload(),
        }
      }
      return this.complete(record.fire, record.evidence, now, record.key, record.summary)
    }
    return {
      status: 'failed',
      error: p2Error('GUARD_POLICY_RESULT_INVALID', 'runtime', 'predicate returned an invalid value', { module: 'core.condition' }),
      samples: this.payload(),
    }
  }

  private complete(
    fire: boolean,
    evidence: JsonValue | undefined,
    now: number,
    key?: string,
    summary?: string,
  ): ConditionOutcome {
    this.running = false
    return {
      status: fire ? 'fire' : 'quiet',
      samples: this.payload(),
      sampledAt: now,
      ...(evidence === undefined ? {} : { evidence }),
      ...(key === undefined ? {} : { key }),
      ...(summary === undefined ? {} : { summary }),
    }
  }

  private payload(): Record<string, JsonValue> {
    const samples: Record<string, JsonValue> = {}
    this.samples.forEach((sample, index) => {
      samples[String(index)] = {
        status: sample.status,
        ...(sample.value === undefined ? {} : { value: sample.value }),
        ...(sample.meta === undefined ? {} : { meta: sample.meta as unknown as JsonValue }),
        ...(sample.error === undefined ? {} : { error: sample.error as unknown as JsonValue }),
      }
    })
    return samples
  }
}

/** Adapt a policy-runner outcome to a predicate call. */
export function policyCall(outcome: PolicyOutcome): PredicateCall {
  if (outcome.status === 'ok') return { status: 'ok', value: outcome.value as PredicateValue }
  if (outcome.status === 'failed') return { status: 'failed', error: outcome.error }
  return {
    status: 'pending',
    poll: () => policyCall(outcome.poll()),
  }
}

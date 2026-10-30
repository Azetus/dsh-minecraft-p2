/**
 * Commitment repository and completion gate (P2CONTROLLER §3.1 item 3, C2/C4).
 *
 * A commitment is a long-lived goal owned by the controller: it survives action
 * handovers, suspension and strategy replacement. Completion is not "the post
 * read true once": a candidate must be followed by cleanup (no active action),
 * valid (known, unexpired, in-scope) evidence, and — for counts — a baseline
 * difference so pre-owned items never count as newly produced.
 */

import { p2Error } from '../contracts/protocol.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import type { FactSet } from './observation.ts'
import type { EvidenceId } from './types.ts'

export type PostCondition =
  | {
    kind: 'count-at-least'
    factKey: string
    item: string
    count: number
    /** Compare against the commitment baseline instead of the absolute total. */
    fromBaseline?: boolean
  }
  | {
    kind: 'fact-equals'
    factKey: string
    value: JsonValue
  }
  | {
    /** Standing goals (follow, guard) have no natural success terminal. */
    kind: 'standing'
  }

export type Baseline = {
  at: number
  values: Record<string, JsonValue>
  evidenceIds: Record<string, string>
  missing: string[]
}

export type EvidenceRef = {
  factKey: string
  evidenceId: EvidenceId
  sampledAt: number
  validUntil: number
  scope: string
  value: JsonValue
  observed?: number
  required?: number
  baseline?: number
}

export type CommitmentState =
  | 'active'
  | 'suspended'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'

export type Diagnostic = {
  code: string
  message: string
  at: number
  detail?: JsonValue
}

export type BlockedInfo = {
  reason: string
  missing: string[]
  since: number
  diagnostics: Diagnostic[]
}

export type Commitment = {
  id: string
  kind: 'task' | 'standing'
  goal: string
  strategyKey: string
  post: PostCondition
  state: CommitmentState
  createdAt: number
  deadline: number
  cleanup?: string
  /** Recovery default is re-verification, not resuming the old program point. */
  resume: 'reverify'
  baseline: Baseline
  checkpoint: JsonValue
  candidateRejections: number
  evidence: EvidenceRef[]
  suspendedAt?: number | undefined
  suspendReason?: string | undefined
  verifyingSince?: number | undefined
  verificationDeadline?: number | undefined
  candidateSince?: number | undefined
  blocked?: BlockedInfo | undefined
  error?: P2Error | undefined
  endedAt?: number | undefined
}

export type CommitmentSpec = {
  id?: string
  kind: 'task' | 'standing'
  goal: string
  strategyKey: string
  post: PostCondition
  baselineKeys: string[]
  deadlineMs?: number
  cleanup?: string
  checkpoint?: JsonValue
}

export type CommitmentView = {
  id: string
  goal: string
  state: CommitmentState
  post: PostCondition
  baseline: Baseline
  checkpoint: JsonValue
  suspendedAt?: number | undefined
  suspendReason?: string | undefined
}

export type VerificationResult =
  | { status: 'true'; evidence: EvidenceRef[] }
  | { status: 'false'; reason: string }
  | { status: 'unknown'; missing: string[] }

export type CommitmentStoreOptions = {
  now?: () => number
  verificationTimeoutMs?: number
  deadlineMs?: number
  maxCommitments?: number
}

const DEFAULT_VERIFICATION_TIMEOUT_MS = 2000
const DEFAULT_DEADLINE_MS = 10 * 60_000
const DEFAULT_MAX_COMMITMENTS = 8

export class CommitmentStore {
  private readonly commitments = new Map<string, Commitment>()
  private readonly now: () => number
  private readonly verificationTimeoutMs: number
  private readonly defaultDeadlineMs: number
  private readonly maxCommitments: number
  private sequence = 0

  constructor(options: CommitmentStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS
    this.defaultDeadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS
    this.maxCommitments = options.maxCommitments ?? DEFAULT_MAX_COMMITMENTS
  }

  get verificationWindowMs(): number {
    return this.verificationTimeoutMs
  }

  create(spec: CommitmentSpec, baseline: Baseline, at = this.now()): Commitment {
    if (this.active() !== undefined) {
      throw p2Error('COMMITMENT_BUSY', 'control', 'another commitment is still active', { module: 'controller.commitment' })
    }
    if (spec.kind === 'task' && spec.post.kind === 'standing') {
      throw p2Error('INVALID_POSTCONDITION', 'validation', 'a task commitment needs a measurable post-condition', {
        module: 'controller.commitment',
      })
    }
    const id = spec.id ?? `commit-${++this.sequence}`
    const commitment: Commitment = {
      id,
      kind: spec.kind,
      goal: spec.goal,
      strategyKey: spec.strategyKey,
      post: spec.post,
      state: 'active',
      createdAt: at,
      deadline: at + (spec.deadlineMs ?? this.defaultDeadlineMs),
      resume: 'reverify',
      baseline,
      checkpoint: spec.checkpoint ?? null,
      candidateRejections: 0,
      evidence: [],
      ...(spec.cleanup === undefined ? {} : { cleanup: spec.cleanup }),
    }
    this.commitments.set(id, commitment)
    while (this.commitments.size > this.maxCommitments) {
      const oldest = [...this.commitments.values()].sort((left, right) => left.createdAt - right.createdAt)[0]
      if (oldest === undefined) break
      this.commitments.delete(oldest.id)
    }
    return commitment
  }

  get(id: string): Commitment | undefined {
    return this.commitments.get(id)
  }

  /** The single non-terminal commitment, if any. */
  active(): Commitment | undefined {
    for (const commitment of this.commitments.values()) {
      if (!isTerminal(commitment.state)) return commitment
    }
    return undefined
  }

  suspend(id: string, reason: string, at = this.now()): Commitment {
    const commitment = this.require(id)
    if (isTerminal(commitment.state) || commitment.state === 'suspended') return commitment
    commitment.state = 'suspended'
    commitment.suspendedAt = at
    commitment.suspendReason = reason
    commitment.verifyingSince = undefined
    commitment.verificationDeadline = undefined
    return commitment
  }

  /** Suspended → verifying: recovery starts with a fresh look, not a resume. */
  beginVerification(id: string, reason: string, at = this.now()): Commitment {
    const commitment = this.require(id)
    if (isTerminal(commitment.state)) return commitment
    commitment.state = 'verifying'
    commitment.verifyingSince = at
    commitment.verificationDeadline = at + this.verificationTimeoutMs
    commitment.suspendReason = reason
    return commitment
  }

  markVerified(id: string, at = this.now()): Commitment {
    const commitment = this.require(id)
    if (commitment.state !== 'verifying') return commitment
    commitment.state = 'active'
    commitment.verifyingSince = undefined
    commitment.verificationDeadline = undefined
    commitment.suspendedAt = undefined
    commitment.suspendReason = undefined
    commitment.checkpoint = { ...asRecord(commitment.checkpoint), verifiedAt: at }
    return commitment
  }

  checkpoint(id: string, patch: JsonValue): Commitment {
    const commitment = this.require(id)
    if (isTerminal(commitment.state)) return commitment
    commitment.checkpoint = patch
    return commitment
  }

  markCandidate(id: string, at = this.now()): void {
    const commitment = this.require(id)
    commitment.candidateSince ??= at
  }

  clearCandidate(id: string): void {
    const commitment = this.require(id)
    commitment.candidateSince = undefined
  }

  rejectCandidate(id: string, diagnostic: Diagnostic): void {
    const commitment = this.require(id)
    commitment.candidateRejections += 1
    commitment.candidateSince = undefined
    if (commitment.candidateRejections >= 3) {
      this.fail(id, p2Error('POSTCONDITION_FAILED', 'runtime', 'candidate completion was rejected three times', {
        module: 'controller.commitment',
      }, { diagnostic: diagnostic.detail ?? null }))
      return
    }
    commitment.state = 'active'
    commitment.checkpoint = {
      ...asRecord(commitment.checkpoint),
      lastRejection: diagnostic as unknown as JsonValue,
    }
  }

  succeed(id: string, evidence: EvidenceRef[], at = this.now()): Commitment {
    const commitment = this.require(id)
    commitment.state = 'succeeded'
    commitment.evidence = evidence
    commitment.endedAt = at
    commitment.candidateSince = undefined
    commitment.verificationDeadline = undefined
    return commitment
  }

  fail(id: string, error: P2Error, at = this.now()): Commitment {
    const commitment = this.require(id)
    commitment.state = 'failed'
    commitment.error = error
    commitment.endedAt = at
    return commitment
  }

  block(id: string, info: BlockedInfo): Commitment {
    const commitment = this.require(id)
    commitment.state = 'blocked'
    commitment.blocked = info
    commitment.endedAt = info.since
    return commitment
  }

  cancel(id: string, reason: string, at = this.now()): Commitment {
    const commitment = this.require(id)
    if (isTerminal(commitment.state)) return commitment
    commitment.state = 'cancelled'
    commitment.endedAt = at
    commitment.checkpoint = { ...asRecord(commitment.checkpoint), cancelReason: reason }
    return commitment
  }

  /** True when the commitment's own deadline has passed. */
  expired(commitment: Commitment, now = this.now()): boolean {
    return now >= commitment.deadline && !isTerminal(commitment.state)
  }

  view(commitment: Commitment): CommitmentView {
    return {
      id: commitment.id,
      goal: commitment.goal,
      state: commitment.state,
      post: commitment.post,
      baseline: commitment.baseline,
      checkpoint: commitment.checkpoint,
      ...(commitment.suspendedAt === undefined ? {} : { suspendedAt: commitment.suspendedAt }),
      ...(commitment.suspendReason === undefined ? {} : { suspendReason: commitment.suspendReason }),
    }
  }

  all(): Commitment[] {
    return [...this.commitments.values()]
  }

  private require(id: string): Commitment {
    const commitment = this.commitments.get(id)
    if (commitment === undefined) {
      throw p2Error('COMMITMENT_NOT_FOUND', 'validation', `unknown commitment: ${id}`, { module: 'controller.commitment' })
    }
    return commitment
  }
}

export function isTerminal(state: CommitmentState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'blocked'
}

/**
 * Evaluate a post condition against one coherent fact set. `unknown` is a
 * first-class answer: a missing or unparsable fact never means "not met".
 */
export function verifyPostCondition(
  post: PostCondition,
  facts: FactSet,
  baseline: Baseline,
): VerificationResult {
  if (post.kind === 'standing') {
    // A standing goal is only ever "still satisfied"; it cannot be completed
    // by a single evidence reading.
    return { status: 'unknown', missing: [] }
  }
  const read = facts.values[post.factKey]
  if (read === undefined) return { status: 'unknown', missing: [post.factKey] }

  if (post.kind === 'fact-equals') {
    return sameJson(read, post.value)
      ? {
        status: 'true',
        evidence: [evidenceOf(post.factKey, facts, read, {})],
      }
      : { status: 'false', reason: `${post.factKey} does not equal the required value` }
  }

  const observed = countItem(read, post.item)
  if (observed === undefined) {
    return { status: 'unknown', missing: [post.factKey] }
  }
  if (post.fromBaseline === true) {
    if (baseline.missing.includes(post.factKey)) {
      return { status: 'unknown', missing: [`${post.factKey}@baseline`] }
    }
    const baselineValue = baseline.values[post.factKey]
    const baselineCount = baselineValue === undefined ? undefined : countItem(baselineValue, post.item)
    if (baselineCount === undefined) return { status: 'unknown', missing: [`${post.factKey}@baseline`] }
    const required = baselineCount + post.count
    if (observed < required) {
      return {
        status: 'false',
        reason: `${post.item} count ${observed} is below baseline ${baselineCount} + ${post.count}`,
      }
    }
    return {
      status: 'true',
      evidence: [evidenceOf(post.factKey, facts, read, {
        observed,
        required,
        baseline: baselineCount,
      })],
    }
  }
  if (observed < post.count) {
    return { status: 'false', reason: `${post.item} count ${observed} is below ${post.count}` }
  }
  return {
    status: 'true',
    evidence: [evidenceOf(post.factKey, facts, read, { observed, required: post.count })],
  }
}

/** Count an item in an inventory-like fact (array of stacks or a name→count map). */
export function countItem(value: JsonValue, item: string): number | undefined {
  const wanted = item.replace(/^minecraft:/u, '')
  if (Array.isArray(value)) {
    let total = 0
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
      const record = entry as Record<string, JsonValue>
      if (typeof record.name !== 'string' || typeof record.count !== 'number') return undefined
      if (record.name.replace(/^minecraft:/u, '') === wanted) total += record.count
    }
    return total
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, JsonValue>
    let total = 0
    let matched = false
    for (const [name, count] of Object.entries(record)) {
      if (typeof count !== 'number') return undefined
      if (name.replace(/^minecraft:/u, '') === wanted) {
        total += count
        matched = true
      }
    }
    return matched || Object.keys(record).length === 0 ? total : 0
  }
  return undefined
}

function evidenceOf(
  factKey: string,
  facts: FactSet,
  value: JsonValue,
  detail: { observed?: number; required?: number; baseline?: number },
): EvidenceRef {
  const fact = facts.facts[factKey]
  if (fact === undefined) {
    throw p2Error('EVIDENCE_MISSING', 'runtime', `no fact for evidence ${factKey}`, { module: 'controller.commitment' })
  }
  return {
    factKey,
    evidenceId: fact.evidenceId,
    sampledAt: fact.sampledAt,
    validUntil: fact.validUntil,
    scope: fact.scope,
    value,
    ...(detail.observed === undefined ? {} : { observed: detail.observed }),
    ...(detail.required === undefined ? {} : { required: detail.required }),
    ...(detail.baseline === undefined ? {} : { baseline: detail.baseline }),
  }
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {}
}

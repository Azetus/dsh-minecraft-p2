/**
 * P2Controller core (docs/runtime/P2CONTROLLER.md v2, M1–M3).
 *
 * The controller is resident and is *not* a run. It owns the single action
 * lease, the observation bus, the commitment repository and the bounded action
 * memory; strategies are replaceable content that can only propose.
 *
 * Tick order is fixed:
 *   1. strategy takeovers (and interrupt revocations)
 *   2. lease/handover progress and terminal outcomes
 *   3. observation refresh
 *   4. strategy evaluation -> commitment transitions (suspend/verify/complete)
 *   5. arbitration -> at most one dispatch through the lease
 *
 * It never talks to a provider: the actuator port is the only control seam, so
 * swapping providers changes no line in this file.
 */

import { p2Error } from '../contracts/protocol.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import { ActionLeaseMachine, controlFaultError } from './lease.ts'
import type { HandoverTickResult } from './lease.ts'
import type {
  ActionOutcome,
  ActionRequest,
  ActuatorPort,
  ControlFault,
  HandoverPhase,
  HazardClass,
  LeaseState,
  SlotId,
} from './types.ts'
import { ObservationBus } from './observation.ts'
import type { Fact, FactSample, ReadOptions } from './observation.ts'
import { ActionMemory } from './memory.ts'
import {
  CommitmentStore,
  isTerminal,
  verifyPostCondition,
} from './commitment.ts'
import type {
  Baseline,
  BlockedInfo,
  Commitment,
  CommitmentSpec,
  CommitmentState,
  Diagnostic,
  EvidenceRef,
} from './commitment.ts'
import { SLOT_ORDER, compareCandidates, slotRank } from './slots.ts'
import { StrategyRegistry } from './strategy.ts'
import type { InstallMode, InstallResult, Strategy, StrategyContext, StrategyVerdict } from './strategy.ts'

export type FactSource = {
  op: string
  args?: Record<string, JsonValue>
  scope?: string
  ttlMs?: number
  /** Per-fact refresh interval; defaults to the controller-wide value. */
  refreshMs?: number
}

export type SenseResult =
  | { status: 'ok'; value: JsonValue; sampledAt?: number; scope?: string; evidenceId?: string }
  | { status: 'unknown'; reason: string }
  | { status: 'failed'; error: P2Error }
  | { status: 'pending' }

/** Semantic sensing seam; a binding maps it onto QueryOps. */
export type SensePort = {
  sample(source: FactSource, now: number): SenseResult
}

export type ControllerEventKind =
  | 'action-requested'
  | 'action-started'
  | 'action-completed'
  | 'action-preempted'
  | 'control-fault'
  | 'control-fault-cleared'
  | 'commitment-suspended'
  | 'commitment-verifying'
  | 'commitment-resumed'
  | 'commitment-succeeded'
  | 'commitment-failed'
  | 'commitment-blocked'
  | 'commitment-cancelled'
  | 'candidate-rejected'
  | 'strategy-installed'
  | 'strategy-takeover-pending'
  | 'strategy-taken-over'
  | 'degraded'

export type ControllerEvent = {
  at: number
  kind: ControllerEventKind
  slot?: SlotId | undefined
  strategyKey?: string | undefined
  commitmentId?: string | undefined
  detail?: string | undefined
  data?: JsonValue | undefined
}

export type SlotEvaluation = {
  slot: SlotId
  strategyKey: string
  version: string
  attemptId: string
  registration: number
  hazardClass?: HazardClass
  /** Shadow evaluations are diagnostic only and never take the lease. */
  shadow?: boolean
  verdict: StrategyVerdict
}

export type DecisionCandidate = {
  slot: SlotId
  strategyKey: string
  kind: 'propose' | 'recover'
  intent: string
  act: string
}

export type ControllerDecision = {
  at: number
  reason: string
  selected: DecisionCandidate | null
  candidates: DecisionCandidate[]
  suppressedSlots: SlotId[]
  detail?: string | undefined
}

/** One bounded per-tick decision record; evidence lists fact keys only. */
export type DecisionTrace = {
  at: number
  tick: number
  reason: string
  selected: { slot: SlotId; strategyKey: string; intent: string; act: string } | null
  candidates: DecisionCandidate[]
  suppressedSlots: SlotId[]
  evidence: string[]
}

export type S0LatencySample = {
  detectedAt: number
  decidedAt: number
  preemptAt: number
  effectiveAt: number
  totalMs: number
}

export type ControllerMetrics = {
  startedAt: number
  ticks: number
  lastTickAt: number
  commitmentActiveMs: number
  noProgressMs: number
  idleMs: number
  lastProgressAt: number
  actionsStarted: number
  actionsFailed: number
  commitmentsSucceeded: number
  commitmentsFailed: number
  commitmentsBlocked: number
  deaths: number
  deathsByClass: Record<string, number>
  s0Latency: S0LatencySample[]
}

export type VerificationState = {
  since: number
  deadline: number
  reason: string
  commitmentId: string
}

export type StallState = {
  since: number
  ticks: number
  missing: string[]
  diagnostics: Diagnostic[]
}

export type CommitmentSummary = {
  id: string
  goal: string
  strategyKey: string
  state: CommitmentState
  deadline: number
  checkpoint: JsonValue
  suspendedAt?: number
  suspendReason?: string
  blocked?: BlockedInfo
  evidence: EvidenceRef[]
}

export type ControllerStatus = {
  now: number
  phase: 'normal' | 'verifying' | 'recovering'
  lease: {
    phase: HandoverPhase
    state: LeaseState
    generation: number
    holder?: string
    fault?: ControlFault
  }
  action: { intent: string; act: string; slot: SlotId } | null
  decision: ControllerDecision | null
  decisions: DecisionTrace[]
  metrics: ControllerMetrics
  commitment: CommitmentSummary | null
  commitments: CommitmentSummary[]
  strategies: ReturnType<StrategyRegistry['summaries']>
  verification: VerificationState | null
  stall: StallState | null
  memory: ReturnType<ActionMemory['snapshot']>
  degraded: string[]
}

export type P2ControllerOptions = {
  actuator: ActuatorPort
  sense?: SensePort
  facts?: Record<string, FactSource>
  now?: () => number
  coherenceWindowMs?: number
  factTtlMs?: number
  refreshIntervalMs?: number
  stopTimeoutMs?: number
  verificationTimeoutMs?: number
  unknownDeadlineMs?: number
  maxEvents?: number
  onEvent?: (event: ControllerEvent) => void
  memory?: ActionMemory
  commitments?: CommitmentStore
}

const DEFAULT_REFRESH_INTERVAL_MS = 100
const DEFAULT_VERIFICATION_TIMEOUT_MS = 2000
const DEFAULT_UNKNOWN_DEADLINE_MS = 3000
const DEFAULT_MAX_EVENTS = 128
const S0_RETRY_WINDOW_MS = 60_000
const S0_RETRY_LIMIT = 3

export class P2Controller {
  readonly machine: ActionLeaseMachine
  readonly observations: ObservationBus
  readonly memory: ActionMemory
  readonly commitments: CommitmentStore
  readonly registry: StrategyRegistry
  private readonly sense: SensePort | undefined
  private readonly factSources: Record<string, FactSource>
  private readonly now: () => number
  private readonly refreshIntervalMs: number
  private readonly factTtlMs: number | undefined
  private readonly verificationTimeoutMs: number
  private readonly unknownDeadlineMs: number
  private readonly maxEvents: number
  private readonly onEvent: ((event: ControllerEvent) => void) | undefined
  private readonly events: ControllerEvent[] = []
  private readonly degraded = new Set<string>()
  private decisionValue: ControllerDecision | null = null
  private ticks = 0
  private lastTickAt = Date.now()
  private readonly decisionTraces: DecisionTrace[] = []
  private readonly metrics: ControllerMetrics = {
    startedAt: Date.now(),
    ticks: 0,
    lastTickAt: Date.now(),
    commitmentActiveMs: 0,
    noProgressMs: 0,
    idleMs: 0,
    lastProgressAt: Date.now(),
    actionsStarted: 0,
    actionsFailed: 0,
    commitmentsSucceeded: 0,
    commitmentsFailed: 0,
    commitmentsBlocked: 0,
    deaths: 0,
    deathsByClass: {},
    s0Latency: [],
  }
  private emergencyFirstAt: number | undefined
  private s0DecidedAt: number | undefined
  private s0PreemptAt: number | undefined
  private verificationValue: VerificationState | undefined
  private stallValue: StallState | undefined
  private activeRequest: ActionRequest | undefined
  private activeSlot: SlotId | undefined
  private lastOutcomeValue: StrategyContext['lastOutcome'] | undefined
  /** Debounce S0 clearing: a jump can briefly report inWater=false. */
  private s0HadEmergency = false
  private s0ClearTicks = 0
  private lastCompletionAt: number | undefined
  /** False while the body is shutting the controller down: no new dispatch. */
  private autonomyValue = true
  /** Bounded S0 retry ledger: holder|intent -> starts within the window. */
  private readonly s0Attempts = new Map<string, { count: number; firstAt: number }>()

  constructor(options: P2ControllerOptions) {
    this.sense = options.sense
    this.factSources = options.facts ?? {}
    this.now = options.now ?? Date.now
    this.lastTickAt = this.now()
    this.metrics.startedAt = this.now()
    this.metrics.lastTickAt = this.now()
    this.metrics.lastProgressAt = this.now()
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
    this.factTtlMs = options.factTtlMs
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS
    this.unknownDeadlineMs = options.unknownDeadlineMs ?? DEFAULT_UNKNOWN_DEADLINE_MS
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
    this.onEvent = options.onEvent
    this.observations = new ObservationBus({
      now: this.now,
      ...(options.coherenceWindowMs === undefined ? {} : { coherenceWindowMs: options.coherenceWindowMs }),
      ...(options.factTtlMs === undefined ? {} : { defaultTtlMs: options.factTtlMs }),
    })
    this.memory = options.memory ?? new ActionMemory({ now: this.now })
    this.commitments = options.commitments ?? new CommitmentStore({ now: this.now, verificationTimeoutMs: this.verificationTimeoutMs })
    this.registry = new StrategyRegistry({ now: this.now })
    this.machine = new ActionLeaseMachine({
      actuator: options.actuator,
      now: this.now,
      ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
      onEvent: event => {
        if (event.kind === 'fault') this.recordEvent('control-fault', event.at, { detail: event.detail })
        if (event.kind === 'fault-cleared') this.recordEvent('control-fault-cleared', event.at)
      },
    })
  }

  get phase(): 'normal' | 'verifying' | 'recovering' {
    if (this.verificationValue !== undefined) return 'verifying'
    return this.memory.escapePhase === 'recovering' ? 'recovering' : 'normal'
  }

  get verification(): VerificationState | undefined {
    return this.verificationValue
  }

  get decision(): ControllerDecision | null {
    return this.decisionValue
  }

  get eventLog(): readonly ControllerEvent[] {
    return this.events
  }

  /** Publish a fact directly (tests, or a binding that already sampled it). */
  publish(sample: FactSample): Fact {
    return this.observations.publish(sample)
  }

  /**
   * Death/respawn/dimension change: invalidate old observations (and, for a
   * full invalidation, hazard memory). The commitment goes to re-verification,
   * never back to the old program point.
   */
  invalidateScope(scopePrefix: string, now = this.now()): number {
    const count = this.observations.invalidateScope(scopePrefix)
    if (scopePrefix === '') this.memory.reset()
    const commitment = this.commitments.active()
    if (commitment !== undefined && commitment.state === 'active') {
      this.commitments.suspend(commitment.id, `scope-invalidated:${scopePrefix}`, now)
      this.recordEvent('commitment-suspended', now, {
        commitmentId: commitment.id,
        detail: `scope-invalidated:${scopePrefix}`,
      })
    }
    return count
  }

  install(strategy: Strategy, mode: InstallMode = 'boundary', at = this.now(), shadow = false): InstallResult {
    const existing = this.registry.binding(strategy.key)
    if (existing !== undefined && existing.slot !== strategy.slot) {
      throw p2Error('STRATEGY_SLOT_MISMATCH', 'validation', `strategy ${strategy.key} is bound to ${existing.slot}`, {
        module: 'controller',
      }, { slot: strategy.slot })
    }
    const result = this.registry.install(strategy, mode, at, shadow)
    if (result.status === 'installed') {
      this.recordEvent('strategy-installed', at, { strategyKey: strategy.key })
    } else if (result.status === 'pending-boundary' || result.status === 'pending-interrupt') {
      this.recordEvent('strategy-takeover-pending', at, { strategyKey: strategy.key, detail: mode })
    }
    return result
  }

  uninstall(key: string, at = this.now()): boolean {
    const commitment = this.commitments.active()
    const removed = this.registry.uninstall(key)
    if (removed && commitment?.strategyKey === key) {
      this.failCommitment(commitment, p2Error('STRATEGY_UNAVAILABLE', 'capability', `strategy ${key} was uninstalled`, {
        module: 'controller',
      }), at)
    }
    return removed
  }

  /** Create the single active commitment and snapshot its baseline facts. */
  commit(spec: CommitmentSpec, at = this.now()): Commitment {
    const facts = this.observations.readMany(spec.baselineKeys, at)
    const evidenceIds: Record<string, string> = {}
    for (const key of facts.known) {
      const fact = facts.facts[key]
      if (fact !== undefined) evidenceIds[key] = fact.evidenceId
    }
    const baseline: Baseline = {
      at,
      values: facts.values,
      evidenceIds,
      missing: facts.unknown,
    }
    const commitment = this.commitments.create(spec, baseline, at)
    // A new commitment starts without the previous one's action outcome; stale
    // results must not steer a fresh goal (real-machine finding).
    this.lastOutcomeValue = undefined
    this.lastCompletionAt = undefined
    this.stallValue = undefined
    this.s0HadEmergency = false
    this.s0ClearTicks = 0
    this.noteProgress(at)
    return commitment
  }

  cancelCommitment(id: string, reason: string, at = this.now()): Commitment {
    const commitment = this.commitments.get(id)
    if (commitment === undefined) {
      throw p2Error('COMMITMENT_NOT_FOUND', 'validation', `unknown commitment: ${id}`, { module: 'controller' })
    }
    if (this.activeRequest !== undefined && this.activeRequest.holder.endsWith(`:${commitment.strategyKey}`)) {
      this.machine.cancel(at)
    }
    const pending = this.machine.pendingRequest
    if (pending !== undefined && pending.holder.endsWith(`:${commitment.strategyKey}`)) {
      this.machine.dropPending('commitment-cancelled', at)
    }
    this.commitments.cancel(id, reason, at)
    this.verificationValue = undefined
    this.stallValue = undefined
    this.recordEvent('commitment-cancelled', at, { commitmentId: id, detail: reason })
    return commitment
  }

  /**
   * One resident tick. Safe to call with no commitment and no strategies: the
   * controller then stays quiet instead of inventing work.
   */
  tick(now = this.now()): ControllerStatus {
    this.accountTime(now)
    this.ticks += 1
    this.metrics.ticks = this.ticks
    this.metrics.lastTickAt = now
    this.lastTickAt = now
    if (this.autonomyValue) this.advanceTakeovers(now)

    const activeBefore = this.activeRequest
    const handover: HandoverTickResult = this.machine.tick(now)
    if (handover.completed !== undefined) {
      this.recordCompletion(activeBefore, handover.completed.outcome, now)
    }
    if (handover.started !== undefined && handover.startedRequest !== undefined) {
      this.recordStarted(handover.startedRequest)
    }
    if (handover.fault !== undefined) this.noteFault(handover.fault, now)
    // A revoke drops the handle, so no terminal outcome will ever arrive for
    // the old action; keep it as accounting only and release the slot record.
    if (this.activeRequest !== undefined && this.machine.currentRequest === undefined) {
      this.recordRevoked(this.activeRequest, now)
    }

    if (!this.autonomyValue) {
      // Shutdown: still advance release, never evaluate or dispatch again.
      return this.status(now)
    }

    this.refreshObservations(now)
    // A release confirmed this tick can unblock a pending takeover immediately.
    this.advanceTakeovers(now)

    const evaluations = this.evaluateAll(now)
    this.updateCommitment(evaluations, now)
    const decision = this.arbitrate(evaluations, now)
    this.decisionValue = decision
    if (decision.selected?.slot === 'S0' && this.s0DecidedAt === undefined) this.s0DecidedAt = now
    this.recordDecision(decision, evaluations, now)
    this.applyDecision(decision, now)
    return this.status(now)
  }

  /**
   * Freeze or resume new control. Disabling the controller sets this false so a
   * strategy that keeps proposing (for example, an escape loop) cannot restart
   * an action while the lease is being released.
   */
  setAutonomy(enabled: boolean, at = this.now()): void {
    this.autonomyValue = enabled
    if (!enabled) this.machine.dropPending('autonomy-off', at)
  }

  get autonomy(): boolean {
    return this.autonomyValue
  }

  /** Best-effort shutdown: release the slot; never reports a successful stop. */
  dispose(at = this.now()): void {
    this.machine.dispose(at)
  }

  status(now = this.now()): ControllerStatus {
    const commitment = this.commitments.active()
    return {
      now,
      phase: this.phase,
      lease: {
        phase: this.machine.phase,
        state: this.machine.leaseState,
        generation: this.machine.generation,
        ...(this.machine.grant === undefined ? {} : { holder: this.machine.grant.holder }),
        ...(this.machine.controlFault === undefined ? {} : { fault: this.machine.controlFault }),
      },
      action: this.activeRequest === undefined || this.activeSlot === undefined
        ? null
        : { intent: this.activeRequest.intent, act: this.activeRequest.act, slot: this.activeSlot },
      decision: this.decisionValue,
      decisions: [...this.decisionTraces],
      metrics: { ...this.metrics, s0Latency: [...this.metrics.s0Latency] },
      commitment: commitment === undefined ? null : summarize(commitment),
      commitments: this.commitments.all().map(summarize),
      strategies: this.registry.summaries(),
      verification: this.verificationValue ?? null,
      stall: this.stallValue ?? null,
      memory: this.memory.snapshot(now),
      degraded: [...this.degraded],
    }
  }

  // ---------------------------------------------------------------- takeovers

  private advanceTakeovers(now: number): void {
    const pending = this.registry.pending()
    if (pending.length === 0) return
    for (const binding of pending) {
      if (binding.state !== 'pending-interrupt' || this.machine.phase !== 'active') continue
      // Interrupt = revoke the running action now; the new version takes over
      // only after release is confirmed, and never inherits a queued old step.
      this.machine.cancel(now)
      this.machine.dropPending('strategy-replacement', now)
      this.recordEvent('action-preempted', now, {
        strategyKey: binding.key,
        detail: 'strategy-interrupt: lease revoked',
      })
      this.recordEvent('strategy-takeover-pending', now, {
        strategyKey: binding.key,
        detail: 'interrupt: lease revoked, waiting for release',
      })
    }
    if (this.machine.phase !== 'idle') return
    for (const binding of [...this.registry.pending()]) {
      const taken = this.registry.takeOver(binding.key, now)
      if (taken === undefined) continue
      // A new attempt must not inherit the previous attempt's last action.
      this.lastOutcomeValue = undefined
      this.lastCompletionAt = undefined
      const commitment = this.commitments.active()
      if (commitment !== undefined && commitment.strategyKey === taken.strategy.key) {
        this.reconcileStrategyChange(commitment, taken.strategy, taken.previousVersion, now)
      }
      this.recordEvent('strategy-taken-over', now, {
        strategyKey: binding.key,
        detail: `${taken.previousVersion} -> ${taken.strategy.version} (${taken.attemptId})`,
        data: {
          installedVersion: binding.installedVersion,
          activeVersion: taken.strategy.version,
          attemptId: taken.attemptId,
        },
      })
    }
  }

  /** Cross-version replacement defaults to re-verification; migration is explicit. */
  private reconcileStrategyChange(commitment: Commitment, strategy: Strategy, previousVersion: string, now: number): void {
    if (isTerminal(commitment.state)) return
    if (this.registry.canMigrate(strategy, previousVersion) && typeof strategy.migrate === 'function') {
      const migrated = strategy.migrate(commitment.checkpoint, previousVersion)
      if (migrated !== undefined) {
        this.commitments.checkpoint(commitment.id, migrated)
        return
      }
    }
    this.beginVerification(commitment, 'strategy-replaced', now)
  }

  // -------------------------------------------------------------- observations

  private refreshObservations(now: number): void {
    if (this.sense === undefined) return
    for (const [key, source] of Object.entries(this.factSources)) {
      const read = this.observations.read(key, now)
      const refreshMs = source.refreshMs ?? this.refreshIntervalMs
      if (read.known && now - read.fact.sampledAt < refreshMs) {
        this.degraded.delete(`sense:${key}`)
        continue
      }
      let result: SenseResult
      try {
        result = this.sense.sample(source, now)
      } catch (error) {
        result = {
          status: 'failed',
          error: p2Error('SENSE_FAILED', 'environment', messageOf(error), { module: 'controller.sense' }, { fact: key }),
        }
      }
      if (result.status !== 'ok') {
        this.degraded.add(`sense:${key}`)
        continue
      }
      this.degraded.delete(`sense:${key}`)
      const ttlMs = source.ttlMs ?? this.factTtlMs
      this.observations.publish({
        key,
        value: result.value,
        scope: result.scope ?? source.scope ?? 'default',
        sampledAt: result.sampledAt ?? now,
        ...(ttlMs === undefined ? {} : { ttlMs }),
        ...(result.evidenceId === undefined ? {} : { evidenceId: result.evidenceId }),
      })
    }
  }

  // ---------------------------------------------------------------- strategies

  private evaluateAll(now: number): SlotEvaluation[] {
    const evaluations: SlotEvaluation[] = []
    for (const slot of SLOT_ORDER) {
      for (const { strategy, binding } of this.registry.active(slot)) {
        const context = this.strategyContext(strategy, binding, slot, now)
        let verdict: StrategyVerdict
        try {
          verdict = strategy.evaluate(context)
        } catch (error) {
          this.degraded.add(`strategy:${strategy.key}`)
          verdict = {
            kind: 'blocked',
            missing: ['strategy-error'],
            since: now,
            diagnostics: [{ code: 'STRATEGY_ERROR', message: messageOf(error), at: now }],
          }
        }
        verdict = this.guardS0Retry(slot, strategy.key, verdict, now)
        verdict = this.guardHazardTarget(slot, verdict, now)
        evaluations.push({
          slot,
          strategyKey: strategy.key,
          version: binding.activeVersion,
          attemptId: binding.attemptId,
          registration: binding.registration,
          ...(strategy.hazardClass === undefined ? {} : { hazardClass: strategy.hazardClass }),
          ...(binding.shadow === true ? { shadow: true } : {}),
          verdict,
        })
      }
    }
    return evaluations
  }

  private strategyContext(strategy: Strategy, binding: { attemptId: string }, slot: SlotId, now: number): StrategyContext {
    const commitment = this.commitmentFor(strategy.key)
    const activeAction = this.activeRequest === undefined || this.activeSlot === undefined
      ? undefined
      : {
        intent: this.activeRequest.intent,
        act: this.activeRequest.act,
        holder: this.activeRequest.holder,
        ...(this.activeRequest.attemptId === undefined ? {} : { attemptId: this.activeRequest.attemptId }),
      }
    return {
      now,
      slot,
      attemptId: binding.attemptId,
      phase: this.phaseFor(slot),
      facts: (keys, options) => this.observations.readMany(keys, now, this.readOptions(options)),
      memory: this.memory,
      ...(commitment === undefined ? {} : { commitment: this.commitments.view(commitment) }),
      ...(activeAction === undefined ? {} : { activeAction }),
      ...(this.lastOutcomeValue === undefined ? {} : { lastOutcome: this.lastOutcomeValue }),
      request: (intent, act, args = {}) => ({
        intent,
        act,
        args,
        slot,
        holder: `${slot}:${strategy.key}`,
        attemptId: binding.attemptId,
      }),
      propose: (intent, act, args = {}) => ({
        kind: 'propose',
        intent,
        action: {
          intent,
          act,
          args,
          slot,
          holder: `${slot}:${strategy.key}`,
          attemptId: binding.attemptId,
        },
      }),
      diagnostic: (code, message, detail) => ({
        code,
        message,
        at: now,
        ...(detail === undefined ? {} : { detail }),
      }),
      saveCheckpoint: patch => {
        if (commitment !== undefined) this.commitments.checkpoint(commitment.id, patch)
      },
      evidence: factKey => {
        const fact = this.observations.read(factKey, now).fact
        return {
          factKey,
          evidenceId: fact.evidenceId,
          sampledAt: fact.sampledAt,
          validUntil: fact.validUntil,
          scope: fact.scope,
          value: fact.value,
        }
      },
    }
  }

  private phaseFor(slot: SlotId): 'normal' | 'verifying' | 'recovering' {
    if (slot === 'S2' && this.verificationValue !== undefined) return 'verifying'
    return this.memory.escapePhase === 'recovering' ? 'recovering' : 'normal'
  }

  private readOptions(options: ReadOptions | undefined): ReadOptions {
    const since = this.verificationValue?.since
    if (since === undefined) return options ?? {}
    return { ...options, freshSince: Math.max(options?.freshSince ?? 0, since) }
  }

  private commitmentFor(strategyKey: string): Commitment | undefined {
    const commitment = this.commitments.active()
    return commitment?.strategyKey === strategyKey ? commitment : undefined
  }

  // ---------------------------------------------------------------- arbitration

  private arbitrate(evaluations: SlotEvaluation[], now: number): ControllerDecision {
    const candidates: Array<{ evaluation: SlotEvaluation; action: ActionRequest; kind: 'propose' | 'recover' }> = []
    for (const evaluation of evaluations) {
      if (evaluation.shadow === true) continue
      const verdict = evaluation.verdict
      if (verdict.kind === 'propose') {
        candidates.push({ evaluation, action: verdict.action, kind: 'propose' })
      } else if (verdict.kind === 'recover' && verdict.action !== undefined) {
        candidates.push({ evaluation, action: verdict.action, kind: 'recover' })
      }
    }
    const summary = candidates.map(toDecisionCandidate)
    const emergency = evaluations.filter(evaluation => evaluation.slot === 'S0' && evaluation.shadow !== true && isHazardSignal(evaluation.verdict))
    const commitment = this.commitments.active()

    if (emergency.length > 0) {
      const actionable = candidates
        .filter(candidate => candidate.evaluation.slot === 'S0')
        .sort((left, right) => compareCandidates(orderOf(left.evaluation), orderOf(right.evaluation)))
      if (actionable.length === 0) {
        const verdict = emergency[0]?.verdict
        const running = emergency.some(evaluation => evaluation.verdict.kind === 'running')
        return {
          at: now,
          reason: running ? 'emergency-running' : 'emergency-blocked',
          selected: null,
          candidates: summary,
          suppressedSlots: ['S1', 'S2', 'S3'],
          detail: running
            ? 'the emergency action still owns the lease'
            : verdict?.kind === 'blocked'
              ? `emergency blocked: ${verdict.missing.join(', ') || 'no detail'}`
              : 'emergency present but no executable action',
        }
      }
      const best = actionable[0]
      if (best === undefined) throw new Error('unreachable: emergency candidate list is empty')
      return this.decisionFor(best, 'emergency', summary, ['S1', 'S2', 'S3'], now)
    }

    const maintenance = candidates
      .filter(candidate => candidate.evaluation.slot === 'S1')
      .sort((left, right) => compareCandidates(orderOf(left.evaluation), orderOf(right.evaluation)))
    if (maintenance.length > 0) {
      const best = maintenance[0]
      if (best === undefined) throw new Error('unreachable: maintenance candidate list is empty')
      return this.decisionFor(best, 'maintenance', summary, ['S2', 'S3'], now)
    }

    if (commitment !== undefined && !isTerminal(commitment.state)) {
      if (commitment.state === 'active' || commitment.state === 'verifying') {
        const task = candidates
          .filter(candidate => candidate.evaluation.slot === 'S2' && candidate.evaluation.strategyKey === commitment.strategyKey)
          .sort((left, right) => compareCandidates(orderOf(left.evaluation), orderOf(right.evaluation)))
        const best = task[0]
        if (best !== undefined) return this.decisionFor(best, 'commitment', summary, ['S3'], now)
      }
      return {
        at: now,
        reason: `commitment-${commitment.state}`,
        selected: null,
        candidates: summary,
        suppressedSlots: ['S2', 'S3'],
        detail: commitment.suspendReason ?? commitment.blocked?.reason,
      }
    }

    const standby = candidates
      .filter(candidate => candidate.evaluation.slot === 'S3')
      .sort((left, right) => compareCandidates(orderOf(left.evaluation), orderOf(right.evaluation)))
    const best = standby[0]
    if (best !== undefined) return this.decisionFor(best, 'standby', summary, [], now)

    return {
      at: now,
      reason: candidates.length === 0 ? 'no-candidate' : 'no-selected-slot',
      selected: null,
      candidates: summary,
      suppressedSlots: [],
    }
  }

  private decisionFor(
    candidate: { evaluation: SlotEvaluation; action: ActionRequest; kind: 'propose' | 'recover' },
    reason: string,
    summary: DecisionCandidate[],
    suppressedSlots: SlotId[],
    now: number,
  ): ControllerDecision {
    this.pendingTarget = candidate.action
    return {
      at: now,
      reason,
      selected: toDecisionCandidate(candidate),
      candidates: summary,
      suppressedSlots,
    }
  }

  private pendingTarget: ActionRequest | undefined

  private applyDecision(decision: ControllerDecision, now: number): void {
    const target = this.pendingTarget
    this.pendingTarget = undefined
    if (decision.selected === null || target === undefined) return
    if (this.machine.phase === 'control-fault') {
      this.degraded.add('dispatch:control-fault')
      return
    }
    if (this.registry.pending().length > 0) {
      // A strategy replacement is pending: hold new control until it takes over.
      this.degraded.add('dispatch:takeover-pending')
      return
    }
    if (this.verificationValue !== undefined && target.slot !== 'S0') {
      // Re-verification means the facts behind the proposal predate recovery;
      // nothing but an emergency may start until the next fresh evaluation.
      this.degraded.add('dispatch:verifying')
      return
    }

    const active = this.machine.currentRequest
    if (active !== undefined) {
      const activeSlot = this.activeSlot ?? target.slot
      if (slotRank(target.slot) >= slotRank(activeSlot)) return
      if (sameRequest(active, target)) return
      this.preempt(target, now)
      return
    }
    if (this.machine.phase !== 'idle') {
      if (!sameRequest(this.machine.pendingRequest, target)) this.machine.request(target, now)
      return
    }
    const result = this.machine.request(target, now)
    if (result.outcome === 'rejected') {
      this.degraded.add(`dispatch:${target.holder}`)
      this.recordEvent('degraded', now, {
        strategyKey: target.holder,
        detail: result.fault === undefined ? 'dispatch rejected' : controlFaultError(result.fault).message,
      })
      return
    }
    if (result.outcome === 'started') {
      this.recordStarted(target)
      this.recordEvent('action-started', now, {
        slot: target.slot,
        strategyKey: target.holder,
        detail: target.intent,
      })
    } else {
      this.recordEvent('action-requested', now, {
        slot: target.slot,
        strategyKey: target.holder,
        detail: target.intent,
      })
    }
  }

  private preempt(target: ActionRequest, now: number): void {
    const commitment = this.commitments.active()
    if (commitment !== undefined && commitment.state === 'active' && (this.activeSlot === 'S2' || target.slot !== 'S2')) {
      this.suspendCommitment(commitment, target, now)
    }
    if (target.slot === 'S0') this.memory.setEscapePhase('escaping', target.intent, now)
    if (target.slot === 'S0' && this.activeRequest !== undefined) this.s0PreemptAt = now
    const result = this.machine.request(target, now)
    this.recordEvent('action-preempted', now, {
      slot: target.slot,
      strategyKey: target.holder,
      detail: this.activeRequest === undefined ? target.intent : `${this.activeRequest.intent} -> ${target.intent}`,
    })
    if (result.outcome === 'rejected') this.degraded.add(`dispatch:${target.holder}`)
  }

  // ---------------------------------------------------------------- commitments

  private updateCommitment(evaluations: SlotEvaluation[], now: number): void {
    const commitment = this.commitments.active()
    if (commitment === undefined) {
      this.verificationValue = undefined
      this.stallValue = undefined
      return
    }
    if (this.commitments.expired(commitment, now)) {
      this.failCommitment(commitment, p2Error(
        'COMMITMENT_DEADLINE',
        'timeout',
        `commitment ${commitment.id} exceeded its deadline`,
        { module: 'controller.commitment' },
        { goal: commitment.goal },
      ), now)
      return
    }

    const emergency = evaluations.filter(evaluation => evaluation.slot === 'S0' && evaluation.shadow !== true && isHazardSignal(evaluation.verdict))
    if (emergency.length > 0 && this.emergencyFirstAt === undefined) this.emergencyFirstAt = now
    const s0Clear = this.s0EmergencyClear(emergency)
    const task = evaluations.find(evaluation => evaluation.slot === 'S2' && evaluation.strategyKey === commitment.strategyKey)

    if (commitment.state === 'active') {
      if (emergency.length > 0) {
        const signal = emergency[0]
        const exhausted = signal?.verdict.kind === 'blocked'
          && signal.verdict.diagnostics.some(item => item.code === 'S0_RETRY_EXHAUSTED')
        if (signal !== undefined && exhausted && signal.verdict.kind === 'blocked') {
          // The emergency branch cannot execute: record blocked, never fall
          // back to the task (docs §6).
          this.blockCommitment(commitment, 'EMERGENCY_BLOCKED', signal.verdict.missing, now, signal.verdict.diagnostics)
        } else if (signal !== undefined) {
          this.suspendCommitment(commitment, signal, now)
        }
        return
      }
      if (!s0Clear) return
      if (task?.verdict.kind === 'candidate-complete') {
        this.completionGate(commitment, task.verdict.evidence, now)
        return
      }
      this.trackStall(commitment, task, now)
      return
    }

    if (commitment.state === 'suspended') {
      if (this.machine.controlFault !== undefined) return
      const signal = emergency[0]
      if (signal !== undefined) {
        if (signal.verdict.kind === 'blocked'
          && signal.verdict.diagnostics.some(item => item.code === 'S0_RETRY_EXHAUSTED')) {
          this.blockCommitment(commitment, 'EMERGENCY_BLOCKED', signal.verdict.missing, now, signal.verdict.diagnostics)
        }
        return
      }
      if (!s0Clear) return
      this.beginVerification(commitment, 'hazard-cleared', now)
      return
    }

    if (commitment.state === 'verifying') {
      if (emergency.length > 0) {
        this.commitments.suspend(commitment.id, `preempted by ${emergency[0]?.strategyKey ?? 'emergency'}`, now)
        this.verificationValue = undefined
        return
      }
      if (this.machine.controlFault !== undefined) return
      if (!s0Clear) return
      const verdict = task?.verdict
      const ready = verdict?.kind === 'propose' || verdict?.kind === 'candidate-complete' || verdict?.kind === 'running'
      if (ready) {
        this.commitments.markVerified(commitment.id, now)
        this.verificationValue = undefined
        this.stallValue = undefined
        this.memory.setEscapePhase('none', 'verified', now)
        this.recordEvent('commitment-resumed', now, {
          commitmentId: commitment.id,
          detail: 'fresh facts verified; continuing within the commitment',
        })
        return
      }
      const deadline = this.verificationValue?.deadline ?? now
      if (now >= deadline) {
        const missing = verdict?.kind === 'unknown' ? verdict.missing : verdict?.kind === 'blocked' ? verdict.missing : []
        this.blockCommitment(commitment, 'REVERIFY_TIMEOUT', missing, now, [{
          code: 'REVERIFY_TIMEOUT',
          message: 're-verification did not produce fresh coherent facts in time',
          at: now,
        }])
      }
      return
    }
  }

  private beginVerification(commitment: Commitment, reason: string, now: number): void {
    const wasVerifying = commitment.state === 'verifying'
    this.commitments.beginVerification(commitment.id, reason, now)
    this.verificationValue = {
      since: now + 1,
      deadline: now + this.verificationTimeoutMs,
      reason,
      commitmentId: commitment.id,
    }
    this.memory.setEscapePhase('verifying', reason, now)
    if (!wasVerifying) {
      this.recordEvent('commitment-verifying', now, { commitmentId: commitment.id, detail: reason })
    }
  }

  private suspendCommitment(commitment: Commitment, signal: SlotEvaluation | ActionRequest, now: number): void {
    if (commitment.state === 'suspended') return
    const reason = 'intent' in signal && typeof signal.intent === 'string'
      ? `preempted by ${signal.intent}`
      : `preempted by ${(signal as SlotEvaluation).strategyKey}`
    this.commitments.suspend(commitment.id, reason, now)
    this.verificationValue = undefined
    this.memory.setEscapePhase('escaping', reason, now)
    this.recordEvent('commitment-suspended', now, {
      commitmentId: commitment.id,
      ...(this.activeRequest === undefined ? {} : { strategyKey: this.activeRequest.holder }),
      detail: reason,
    })
  }

  private trackStall(commitment: Commitment, task: SlotEvaluation | undefined, now: number): void {
    const verdict = task?.verdict
    const blocked = verdict?.kind === 'blocked' ? verdict : undefined
    const unknown = verdict?.kind === 'unknown' ? verdict : undefined
    if (blocked === undefined && unknown === undefined) {
      this.stallValue = undefined
      return
    }
    const missing = blocked?.missing ?? unknown?.missing ?? []
    const diagnostics = blocked?.diagnostics ?? []
    const since = this.stallValue?.since ?? blocked?.since ?? now
    const ticks = (this.stallValue?.ticks ?? 0) + 1
    const synthesized: Diagnostic = {
      code: blocked === undefined ? 'MISSING_OBSERVATION' : 'STRATEGY_BLOCKED',
      message: `waited ${now - since}ms for ${missing.length === 0 ? 'the strategy' : missing.join(', ')}`,
      at: now,
      detail: { ticks, missing },
    }
    this.stallValue = {
      since,
      ticks,
      missing,
      diagnostics: mergeDiagnostics(this.stallValue?.diagnostics ?? [], [...diagnostics, synthesized]),
    }
    if (now - since < this.unknownDeadlineMs) return
    this.blockCommitment(
      commitment,
      blocked === undefined ? 'MISSING_OBSERVATION' : 'STRATEGY_BLOCKED',
      missing,
      now,
      this.stallValue.diagnostics,
    )
  }

  /**
   * Completion gate: candidate → cleanup confirmed → valid evidence → success.
   * An unknown post-condition waits only until its deadline; release unknown or
   * a missing baseline can never become a success.
   */
  private completionGate(commitment: Commitment, evidenceRefs: EvidenceRef[], now: number): void {
    this.commitments.markCandidate(commitment.id, now)
    const candidateSince = commitment.candidateSince ?? now
    const settled = this.machine.phase === 'idle'
      && this.machine.leaseState !== 'unknown'
      && this.machine.controlFault === undefined
      && this.activeRequest === undefined
    if (!settled) {
      const fault = this.machine.controlFault
      if (fault !== undefined && now - candidateSince >= this.verificationTimeoutMs) {
        this.blockCommitment(commitment, 'RELEASE_UNCONFIRMED', [], now, [{
          code: fault.code,
          message: 'control release was not confirmed; success cannot be submitted',
          at: now,
        }])
      }
      return
    }

    const postKeys = commitment.post.kind === 'standing'
      ? evidenceRefs.map(ref => ref.factKey)
      : [commitment.post.factKey, ...evidenceRefs.map(ref => ref.factKey)]
    const freshSince = Math.max(commitment.baseline.at, this.lastCompletionAt ?? 0)
    const facts = this.observations.readMany(postKeys, now, { freshSince })
    const verification = verifyPostCondition(commitment.post, facts, commitment.baseline)
    if (verification.status === 'true') {
      this.commitments.succeed(commitment.id, verification.evidence, now)
      this.metrics.commitmentsSucceeded += 1
      this.noteProgress(now)
      this.verificationValue = undefined
      this.stallValue = undefined
      this.recordEvent('commitment-succeeded', now, {
        commitmentId: commitment.id,
        detail: `evidence ${verification.evidence.map(item => item.evidenceId).join(', ')}`,
      })
      return
    }
    if (verification.status === 'false') {
      this.commitments.rejectCandidate(commitment.id, {
        code: 'CANDIDATE_REJECTED',
        message: verification.reason,
        at: now,
      })
      this.recordEvent('candidate-rejected', now, {
        commitmentId: commitment.id,
        detail: verification.reason,
      })
      const after = this.commitments.get(commitment.id)
      if (after?.state === 'failed') {
        this.recordEvent('commitment-failed', now, { commitmentId: commitment.id, detail: after.error?.code })
      }
      return
    }
    // unknown: wait for fresh evidence, but only for a bounded time.
    if (now - candidateSince >= this.verificationTimeoutMs) {
      this.blockCommitment(commitment, 'EVIDENCE_TIMEOUT', verification.missing, now, [{
        code: 'EVIDENCE_TIMEOUT',
        message: 'completion evidence was still unknown at the verification deadline',
        at: now,
        detail: { evidence: evidenceRefs as unknown as JsonValue },
      }])
    }
  }

  private blockCommitment(
    commitment: Commitment,
    reason: string,
    missing: string[],
    now: number,
    diagnostics: Diagnostic[],
  ): void {
    const since = this.stallValue?.since ?? commitment.suspendedAt ?? now
    this.commitments.block(commitment.id, { reason, missing, since, diagnostics })
    this.verificationValue = undefined
    this.stallValue = undefined
    this.recordEvent('commitment-blocked', now, {
      commitmentId: commitment.id,
      detail: `${reason}${missing.length === 0 ? '' : `: ${missing.join(', ')}`}`,
    })
  }

  private failCommitment(commitment: Commitment, error: P2Error, now: number): void {
    this.commitments.fail(commitment.id, error, now)
    this.metrics.commitmentsFailed += 1
    this.noteProgress(now)
    this.verificationValue = undefined
    this.stallValue = undefined
    this.recordEvent('commitment-failed', now, { commitmentId: commitment.id, detail: error.code })
  }

  // ---------------------------------------------------------------- outcomes

  private recordStarted(request: ActionRequest): void {
    this.activeRequest = request
    this.activeSlot = request.slot
    this.metrics.actionsStarted += 1
    this.noteProgress(this.now())
    if (request.slot === 'S0' && this.emergencyFirstAt !== undefined) {
      const effectiveAt = this.now()
      const decidedAt = this.s0DecidedAt ?? effectiveAt
      const preemptAt = this.s0PreemptAt ?? decidedAt
      this.metrics.s0Latency.push({
        detectedAt: this.emergencyFirstAt,
        decidedAt,
        preemptAt,
        effectiveAt,
        totalMs: effectiveAt - this.emergencyFirstAt,
      })
      while (this.metrics.s0Latency.length > 16) this.metrics.s0Latency.shift()
      this.emergencyFirstAt = undefined
      this.s0DecidedAt = undefined
      this.s0PreemptAt = undefined
    }
    if (request.slot === 'S0') {
      const key = `${request.holder}|${request.intent}`
      const now = this.now()
      const entry = this.s0Attempts.get(key)
      if (entry === undefined || now - entry.firstAt > S0_RETRY_WINDOW_MS) {
        this.s0Attempts.set(key, { count: 1, firstAt: now })
      } else {
        entry.count += 1
      }
    }
    if (this.registry.pending().length === 0) this.degraded.delete(`dispatch:${request.holder}`)
  }

  /**
   * A jump can transiently report inWater=false, so an S0 that stops proposing
   * for one tick is not proof that the hazard cleared. Require a few quiet ticks.
   */
  private s0EmergencyClear(emergency: SlotEvaluation[]): boolean {
    if (emergency.length > 0) {
      this.s0HadEmergency = true
      this.s0ClearTicks = 0
      return false
    }
    if (!this.s0HadEmergency) return true
    this.s0ClearTicks += 1
    if (this.s0ClearTicks < 3) return false
    this.s0HadEmergency = false
    this.s0ClearTicks = 0
    return true
  }

  /** Death is a hazard class of its own and must survive 60 minutes. */
  recordDeath(position: { x: number; y: number; z: number } | null, now = this.now()): void {
    this.metrics.deaths += 1
    this.metrics.deathsByClass.death = (this.metrics.deathsByClass.death ?? 0) + 1
    if (position !== null) {
      this.memory.recordHazard({
        hazardId: `death:${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`,
        kind: 'death',
        area: { x: position.x, y: position.y, z: position.z, radius: 4 },
        at: now,
        expiresAt: now + 60 * 60_000,
      })
    }
    this.invalidateScope('body', now)
  }

  /** Task actions must not target an area already remembered as hazardous. */
  private guardHazardTarget(slot: SlotId, verdict: StrategyVerdict, now: number): StrategyVerdict {
    if (slot === 'S0') return verdict
    const action = verdict.kind === 'propose'
      ? verdict.action
      : verdict.kind === 'recover'
        ? verdict.action
        : undefined
    if (action === undefined) return verdict
    const point = targetPoint(action.args)
    if (point === undefined) return verdict
    const hazard = this.memory.hazardsAt(point, undefined, now)[0]
    if (hazard === undefined) return verdict
    return {
      kind: 'blocked',
      missing: ['safe-target'],
      since: now,
      diagnostics: [{
        code: 'HAZARD_TARGET',
        message: `target is inside a remembered ${hazard.kind} hazard`,
        at: now,
        detail: { hazardId: hazard.hazardId, kind: hazard.kind },
      }],
    }
  }

  private noteProgress(now: number): void {
    this.metrics.lastProgressAt = now
  }

  /** Account wall-clock time for no-progress and idle metrics. */
  private accountTime(now: number): void {
    const delta = Math.max(0, now - this.lastTickAt)
    if (delta === 0) return
    const commitment = this.commitments.active()
    if (commitment !== undefined) {
      this.metrics.commitmentActiveMs += delta
      if (now - this.metrics.lastProgressAt > 1000) this.metrics.noProgressMs += delta
    } else {
      this.metrics.idleMs += delta
    }
  }

  private recordDecision(decision: ControllerDecision, evaluations: SlotEvaluation[], now: number): void {
    const evidence: string[] = []
    for (const evaluation of evaluations) {
      if (evaluation.verdict.kind === 'candidate-complete') {
        for (const item of evaluation.verdict.evidence) evidence.push(item.factKey)
      }
    }
    const trace: DecisionTrace = {
      at: now,
      tick: this.ticks,
      reason: decision.reason,
      selected: decision.selected === null
        ? null
        : {
            slot: decision.selected.slot,
            strategyKey: decision.selected.strategyKey,
            intent: decision.selected.intent,
            act: decision.selected.act,
          },
      candidates: decision.candidates.map(candidate => ({ ...candidate })),
      suppressedSlots: [...decision.suppressedSlots],
      evidence,
    }
    this.decisionTraces.push(trace)
    while (this.decisionTraces.length > 64) this.decisionTraces.shift()
  }

  /**
   * An S0 that keeps proposing the same action is not escaping: bound it so it
   * cannot spin forever (real-machine finding: walk-back could not climb out of
   * a walled pool). A blocked S0 suppresses lower slots.
   */
  private guardS0Retry(slot: SlotId, _strategyKey: string, verdict: StrategyVerdict, now: number): StrategyVerdict {
    if (slot !== 'S0') return verdict
    const action = verdict.kind === 'propose'
      ? verdict.action
      : verdict.kind === 'recover'
        ? verdict.action
        : undefined
    if (action === undefined) return verdict
    const entry = this.s0Attempts.get(`${action.holder}|${action.intent}`)
    if (entry === undefined || now - entry.firstAt > S0_RETRY_WINDOW_MS || entry.count < S0_RETRY_LIMIT) {
      return verdict
    }
    return {
      kind: 'blocked',
      missing: [],
      since: entry.firstAt,
      diagnostics: [{
        code: 'S0_RETRY_EXHAUSTED',
        message: `S0 action ${action.intent} started ${entry.count} times without clearing the hazard`,
        at: now,
        detail: { attempts: entry.count, intent: action.intent },
      }],
    }
  }

  private recordCompletion(request: ActionRequest | undefined, outcome: ActionOutcome, now: number): void {
    const intent = request?.intent ?? 'unknown'
    this.lastCompletionAt = now
    this.noteProgress(now)
    if (outcome.status === 'failed') this.metrics.actionsFailed += 1
    this.lastOutcomeValue = {
      intent,
      status: outcome.status,
      at: now,
      ...(request?.attemptId === undefined ? {} : { attemptId: request.attemptId }),
      ...(outcome.status === 'succeeded' && outcome.result !== undefined ? { result: outcome.result } : {}),
      ...(outcome.status === 'failed' ? { error: outcome.error } : {}),
    }
    if (outcome.status === 'failed') {
      this.memory.recordFailure({ goal: intent, reason: outcome.error.code, at: now })
    }
    if (request?.slot === 'S0') {
      this.memory.setEscapePhase('recovering', intent, now)
    }
    const commitment = this.commitments.active()
    if (commitment !== undefined && request !== undefined && request.holder.endsWith(`:${commitment.strategyKey}`)) {
      const checkpoint = asRecord(commitment.checkpoint)
      this.commitments.checkpoint(commitment.id, {
        ...checkpoint,
        lastOutcome: { intent, status: outcome.status, at: now },
      })
    }
    this.activeRequest = undefined
    this.activeSlot = undefined
    this.recordEvent('action-completed', now, {
      ...(request === undefined ? {} : { slot: request.slot, strategyKey: request.holder }),
      detail: `${intent}: ${outcome.status}${outcome.status === 'failed' ? ` (${outcome.error.code})` : ''}`,
    })
  }

  /** A revoked action never produces a terminal poll result; record it once. */
  private recordRevoked(request: ActionRequest, now: number): void {
    this.lastCompletionAt = now
    this.noteProgress(now)
    this.lastOutcomeValue = {
      intent: request.intent,
      status: 'cancelled',
      at: now,
      ...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
    }
    this.activeRequest = undefined
    this.activeSlot = undefined
    this.recordEvent('action-completed', now, {
      slot: request.slot,
      strategyKey: request.holder,
      detail: `${request.intent}: cancelled`,
    })
  }

  private noteFault(fault: ControlFault, now: number): void {    const commitment = this.commitments.active()
    if (commitment !== undefined && commitment.state === 'active') {
      this.commitments.suspend(commitment.id, `control-fault: ${fault.code}`, now)
      this.verificationValue = undefined
      this.recordEvent('commitment-suspended', now, { commitmentId: commitment.id, detail: fault.code })
    }
    this.memory.setEscapePhase('recovering', `control-fault: ${fault.code}`, now)
    this.degraded.add(`fault:${fault.code}`)
  }

  private recordEvent(kind: ControllerEventKind, at: number, extra: Omit<ControllerEvent, 'kind' | 'at'> = {}): void {
    const event: ControllerEvent = { at, kind, ...extra }
    this.events.push(event)
    if (this.events.length > this.maxEvents) this.events.shift()
    this.onEvent?.(event)
  }
}

function summarize(commitment: Commitment): CommitmentSummary {
  return {
    id: commitment.id,
    goal: commitment.goal,
    strategyKey: commitment.strategyKey,
    state: commitment.state,
    deadline: commitment.deadline,
    checkpoint: commitment.checkpoint,
    ...(commitment.suspendedAt === undefined ? {} : { suspendedAt: commitment.suspendedAt }),
    ...(commitment.suspendReason === undefined ? {} : { suspendReason: commitment.suspendReason }),
    ...(commitment.blocked === undefined ? {} : { blocked: commitment.blocked }),
    evidence: commitment.evidence,
  }
}

function toDecisionCandidate(candidate: { evaluation: SlotEvaluation; action: ActionRequest; kind: 'propose' | 'recover' }): DecisionCandidate {
  return {
    slot: candidate.evaluation.slot,
    strategyKey: candidate.evaluation.strategyKey,
    kind: candidate.kind,
    intent: candidate.action.intent,
    act: candidate.action.act,
  }
}

function orderOf(evaluation: SlotEvaluation): { slot: SlotId; hazardClass?: HazardClass; registration: number } {
  return {
    slot: evaluation.slot,
    registration: evaluation.registration,
    ...(evaluation.hazardClass === undefined ? {} : { hazardClass: evaluation.hazardClass }),
  }
}

function targetPoint(value: JsonValue | undefined): { x: number; y: number; z: number } | undefined {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, JsonValue>
  if (typeof record.x === 'number' && typeof record.y === 'number' && typeof record.z === 'number') {
    return { x: record.x, y: record.y, z: record.z }
  }
  for (const key of ['pos', 'position', 'target']) {
    const nested = targetPoint(record[key])
    if (nested !== undefined) return nested
  }
  return undefined
}

function isHazardSignal(verdict: StrategyVerdict): boolean {
  // `running` matters for S0: the escape action is still holding the lease, so
  // the hazard is present even though the strategy has nothing new to propose.
  return verdict.kind === 'propose' || verdict.kind === 'recover' || verdict.kind === 'blocked' || verdict.kind === 'running'
}

function sameRequest(left: ActionRequest | undefined, right: ActionRequest): boolean {
  if (left === undefined) return false
  return left.act === right.act && left.intent === right.intent && stableJson(left.args) === stableJson(right.args)
}

/** Key-order independent JSON used only for request de-duplication. */
function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function mergeDiagnostics(existing: Diagnostic[], incoming: Diagnostic[]): Diagnostic[] {
  const seen = new Set(existing.map(item => `${item.code}:${item.message}`))
  const merged = [...existing]
  for (const item of incoming) {
    const key = `${item.code}:${item.message}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }
  return merged.slice(-8)
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {}
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  if (error instanceof Error) return error.message
  return String(error)
}










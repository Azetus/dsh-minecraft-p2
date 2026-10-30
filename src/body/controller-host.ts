/**
 * Body-side binding for the P2Controller: the single control mode that owns
 * the action slot. It adapts the existing ActPort/QueryPort to the controller
 * ports, loads checked strategy artifacts and exposes a small command surface
 * to the bridge.
 *
 * The controller is the body's single autonomous control mode: no other
 * executor may hold the action slot.
 */

import type {
  ControllerCancelParams,
  ControllerCommitParams,
  ControllerCommitmentView,
  ControllerEventView,
  ControllerEventsParams,
  ControllerEventsResult,
  ControllerInstallParams,
  ControllerInstallResult,
  ControllerView,
  ProviderRuntimeStatus,
} from '../contracts/protocol.ts'
import { p2Error } from '../contracts/protocol.ts'
import type { JsonValue } from '../contracts/types.ts'
import type { StrategyArtifact } from '../contracts/artifacts.ts'
import type { PostCondition, Commitment } from '../controller/commitment.ts'
import { P2Controller } from '../controller/controller.ts'
import type { ControllerEvent, FactSource, SenseResult } from '../controller/controller.ts'
import { createArtifactStrategy } from '../controller/artifact-strategy.ts'
import type { ActionOutcome, ActionRequest, ActuatorPort, LeaseGrant, ReleaseReport } from '../controller/types.ts'
import { StrategyRuntime } from '../core/strategy-runtime.ts'
import type { ActHandle, ActPoll, ActPort, QueryOutcome, QueryPort } from '../core/node-runtime.ts'

export type ControllerMode = ControllerView['mode']

/** Surface consumed by the body runtime and its tests. */
export type ControllerRuntime = {
  readonly engaged: boolean
  readonly mode: ControllerMode
  enable(now: number): ControllerView
  disable(now: number): ControllerView
  install(params: ControllerInstallParams, now: number): ControllerInstallResult
  commit(params: ControllerCommitParams, now: number): ControllerCommitmentView
  queue(params: ControllerCommitParams, now: number): ControllerView
  cancel(params: ControllerCancelParams, now: number): ControllerCommitmentView
  events(params: ControllerEventsParams): ControllerEventsResult
  status(now?: number): ControllerView
  tick(now: number): void
  dispose(now: number): void
}

export type BodyControllerOptions = {
  act: ActPort
  query: QueryPort
  /** Activated strategy artifact lookup (returns undefined unless enabled). */
  strategySource: (artifactId: string) => StrategyArtifact | undefined
  now?: () => number
  providerStatus?: () => ProviderRuntimeStatus
  factSources?: Record<string, FactSource>
  log?: (line: string) => void
}

const DEFAULT_FACT_SOURCES: Record<string, FactSource> = {
  position: { op: 'position', scope: 'body', refreshMs: 100, ttlMs: 600 },
  health: { op: 'health', scope: 'body', refreshMs: 200, ttlMs: 600 },
  inventory: { op: 'inventory', scope: 'body', refreshMs: 300, ttlMs: 1500 },
  nearbyBlocks: {
    op: 'blocks',
    args: {
      radius: 16,
      count: 24,
      exposed: true,
      names: ['stone', 'deepslate', 'cobblestone', 'coal_ore', 'iron_ore', 'oak_log', 'birch_log', 'grass_block', 'dirt', 'sand', 'gravel'],
    },
    scope: 'body',
    refreshMs: 700,
    ttlMs: 2000,
  },
  entities: {
    op: 'entities',
    args: { count: 64, sort: 'distance', maxDistance: 24 },
    scope: 'body',
    refreshMs: 400,
    ttlMs: 1200,
  },
}

const EVENT_LIMIT = 200
const CONTROLLER_RUN_ID = 'controller'

export class BodyController implements ControllerRuntime {
  private controller: P2Controller | undefined
  private modeValue: ControllerMode = 'off'
  private enabledAt: number | null = null
  private disableRequested = false
  private actSequence = 0
  private eventSequence = 0
  private readonly eventLog: ControllerEventView[] = []
  private readonly pendingCommits: ControllerCommitParams[] = []
  private lastDeathAt: number | null = null
  private lastDimension: string | null = null
  private readonly act: ActPort
  private readonly query: QueryPort
  private readonly strategySource: (artifactId: string) => StrategyArtifact | undefined
  private readonly now: () => number
  private readonly providerStatus: (() => ProviderRuntimeStatus) | undefined
  private readonly factSources: Record<string, FactSource>
  private readonly strategyRuntime: StrategyRuntime
  private readonly log: (line: string) => void

  constructor(options: BodyControllerOptions) {
    this.act = options.act
    this.query = options.query
    this.strategySource = options.strategySource
    this.now = options.now ?? Date.now
    this.providerStatus = options.providerStatus
    this.factSources = options.factSources ?? DEFAULT_FACT_SOURCES
    this.strategyRuntime = new StrategyRuntime()
    this.log = options.log ?? (() => {})
  }

  get engaged(): boolean {
    return this.modeValue !== 'off'
  }

  get mode(): ControllerMode {
    return this.modeValue
  }

  /** Fact keys available to strategy artifacts (used for install validation). */
  get factKeys(): string[] {
    return Object.keys(this.factSources)
  }

  enable(now = this.now()): ControllerView {
    if (this.modeValue !== 'off') {
      if (this.modeValue === 'active') return this.status(now)
      throw p2Error('CONTROL_MODE_BUSY', 'control', `controller is ${this.modeValue}; wait for it to settle`, {
        module: 'body.controller',
      })
    }
    if (this.controller !== undefined && this.controller.machine.controlFault !== undefined) {
      throw p2Error(
        'CONTROL_FAULT',
        'control',
        'controller has an unresolved control fault; wait for release proof before enabling',
        { module: 'body.controller' },
        { fault: this.controller.machine.controlFault.code },
      )
    }
    this.controller ??= this.createController()
    this.controller.setAutonomy(true, now)
    this.disableRequested = false
    this.modeValue = 'active'
    this.enabledAt ??= now
    this.log('controller enabled')
    return this.status(now)
  }

  disable(now = this.now()): ControllerView {
    if (this.modeValue === 'off') return this.status(now)
    const controller = this.controller
    if (controller === undefined) {
      this.modeValue = 'off'
      return this.status(now)
    }
    this.disableRequested = true
    this.modeValue = 'disabling'
    // Freeze dispatch before revoking: a strategy that keeps proposing must not
    // restart an action while the lease is being released (real-machine finding).
    controller.setAutonomy(false, now)
    const commitment = controller.commitments.active()
    if (commitment !== undefined) controller.cancelCommitment(commitment.id, 'controller-disabled', now)
    controller.machine.cancel(now)
    if (controller.machine.phase === 'idle' && controller.machine.controlFault === undefined) {
      this.modeValue = 'off'
      this.disableRequested = false
    }
    this.log('controller disabling')
    return this.status(now)
  }

  install(params: ControllerInstallParams, now = this.now()): ControllerInstallResult {
    const controller = this.requireEnabled()
    const artifact = this.strategySource(params.artifactId)
    if (artifact === undefined) {
      throw p2Error('STRATEGY_NOT_ACTIVATED', 'capability', `strategy artifact is not activated: ${params.artifactId}`, {
        module: 'body.controller',
      })
    }
    const missingFacts = artifact.facts.filter(key => this.factSources[key] === undefined)
    if (missingFacts.length > 0) {
      throw p2Error('STRATEGY_FACT_UNKNOWN', 'capability', `strategy needs unregistered facts: ${missingFacts.join(', ')}`, {
        module: 'body.controller',
      }, { missing: missingFacts })
    }
    const loaded = this.strategyRuntime.load(artifact)
    const strategy = createArtifactStrategy({ artifact, evaluate: loaded.evaluate })
    const result = controller.install(strategy, params.mode ?? 'boundary', now, params.shadow === true)
    const binding = controller.registry.binding(artifact.definitionId)
    this.log(`controller strategy ${artifact.definitionId}@${artifact.version} -> ${result.status}`)
    return {
      key: artifact.definitionId,
      status: result.status,
      attemptId: result.attemptId,
      installedVersion: binding?.installedVersion ?? artifact.version,
      activeVersion: binding?.activeVersion ?? artifact.version,
      state: binding?.state ?? 'active',
    }
  }

  commit(params: ControllerCommitParams, now = this.now()): ControllerCommitmentView {
    const controller = this.requireEnabled()
    if (controller.registry.binding(params.strategyKey) === undefined) {
      throw p2Error('STRATEGY_NOT_INSTALLED', 'validation', `strategy is not installed: ${params.strategyKey}`, {
        module: 'body.controller',
      })
    }
    const post = parsePostCondition(params.post)
    const kind = params.kind ?? (post.kind === 'standing' ? 'standing' : 'task')
    if ((kind === 'standing') !== (post.kind === 'standing')) {
      throw p2Error('INVALID_POSTCONDITION', 'validation', 'standing commitments need a standing post-condition and vice versa', {
        module: 'body.controller',
      })
    }
    const baselineKeys = params.baselineKeys
      ?? (post.kind === 'standing' ? [] : [post.factKey])
    const unknownFacts = baselineKeys.filter(key => this.factSources[key] === undefined)
    if (unknownFacts.length > 0) {
      throw p2Error('FACT_NOT_REGISTERED', 'capability', `baseline facts are not registered: ${unknownFacts.join(', ')}`, {
        module: 'body.controller',
      }, { missing: unknownFacts })
    }
    const deadlineMs = params.deadlineMs
    if (deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) {
      throw p2Error('INVALID_COMMITMENT', 'validation', 'deadlineMs must be positive', { module: 'body.controller' })
    }
    // Sample the baseline right now: a commit issued between ticks must not
    // record an empty baseline just because the bus has not refreshed yet.
    for (const key of baselineKeys) {
      const source = this.factSources[key]
      if (source === undefined) continue
      const sample = this.sense(source)
      if (sample.status !== 'ok') continue
      controller.publish({
        key,
        value: sample.value,
        scope: sample.scope ?? source.scope ?? 'body',
        sampledAt: sample.sampledAt ?? now,
        ...(source.ttlMs === undefined ? {} : { ttlMs: source.ttlMs }),
      })
    }
    const commitment = controller.commit({
      ...(params.id === undefined ? {} : { id: params.id }),
      kind,
      goal: params.goal,
      strategyKey: params.strategyKey,
      post,
      baselineKeys,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      ...(params.checkpoint === undefined ? {} : { checkpoint: params.checkpoint }),
    }, now)
    this.log(`controller commitment ${commitment.id}: ${commitment.goal}`)
    return summarizeCommitment(commitment)
  }

  /**
   * Queue a commitment for the next free slot. Validation is intentionally
   * deferred to the moment it actually starts, because the strategy set or
   * facts may have changed; a failing item is logged and skipped, not retried.
   */
  queue(params: ControllerCommitParams, now = this.now()): ControllerView {
    this.requireEnabled()
    if (this.pendingCommits.length >= 32) {
      throw p2Error('COMMITMENT_QUEUE_FULL', 'validation', 'commitment queue is full', { module: 'body.controller' })
    }
    this.pendingCommits.push({ ...params })
    this.log(`controller queued commitment ${params.id ?? '(auto)'}: ${params.goal}`)
    return this.status(now)
  }

  cancel(params: ControllerCancelParams, now = this.now()): ControllerCommitmentView {
    const controller = this.requireEnabled()
    const active = controller.commitments.active()
    const id = params.commitmentId ?? active?.id
    if (id === undefined) {
      throw p2Error('COMMITMENT_NOT_FOUND', 'validation', 'there is no active commitment to cancel', {
        module: 'body.controller',
      })
    }
    const commitment = controller.cancelCommitment(id, params.reason ?? 'owner-cancelled', now)
    return summarizeCommitment(commitment)
  }

  events(params: ControllerEventsParams = {}): ControllerEventsResult {
    const since = typeof params.sinceSeq === 'number' && Number.isFinite(params.sinceSeq) ? params.sinceSeq : 0
    const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.max(1, Math.min(100, Math.floor(params.limit)))
      : 50
    return {
      events: this.eventLog.filter(event => event.seq > since).slice(0, limit),
      seq: this.eventSequence,
    }
  }

  status(now = this.now()): ControllerView {
    const controller = this.controller
    if (controller === undefined) return emptyView(this.modeValue, null, this.eventLog, this.eventSequence)
    const status = controller.status(now)
    return {
      mode: this.modeValue,
      enabledAt: this.enabledAt,
      queueLength: this.pendingCommits.length,
      phase: status.phase,
      lease: status.lease as unknown as JsonValue,
      action: (status.action ?? null) as unknown as JsonValue,
      decision: (status.decision ?? null) as unknown as JsonValue,
      decisions: status.decisions as unknown as JsonValue[],
      metrics: status.metrics as unknown as JsonValue,
      commitment: status.commitment === null ? null : {
        ...summarizeCommitment(status.commitment as unknown as Commitment),
      },
      commitments: status.commitments.map(summary => summarizeCommitment(summary as unknown as Commitment)),
      strategies: status.strategies.map(row => ({
        key: row.key,
        slot: row.slot,
        state: row.state,
        installedVersion: row.installedVersion,
        activeVersion: row.activeVersion,
        attemptId: row.attemptId,
        ...(row.hazardClass === undefined ? {} : { hazardClass: row.hazardClass }),
        ...(row.shadow === true ? { shadow: true } : {}),
      })),
      verification: (status.verification ?? null) as unknown as JsonValue,
      stall: (status.stall ?? null) as unknown as JsonValue,
      memory: status.memory as unknown as JsonValue,
      degraded: [...status.degraded],
      events: this.eventLog.slice(-50),
      eventSeq: this.eventSequence,
    }
  }

  tick(now = this.now()): void {
    if (this.modeValue === 'off' || this.controller === undefined) return
    this.observeWorldChange(now)
    this.controller.tick(now)
    if (this.controller.machine.controlFault !== undefined) {
      this.modeValue = 'fault'
      return
    }
    if (this.modeValue === 'active' && this.pendingCommits.length > 0) {
      const status = this.controller.status(now)
      if (status.commitment === null && status.action === null && this.controller.commitments.active() === undefined) {
        const next = this.pendingCommits.shift()
        if (next !== undefined) {
          try {
            this.commit(next, now)
          } catch (error) {
            this.log(`queued commitment skipped: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
    }
    if (this.disableRequested) {
      if (this.controller.machine.phase === 'idle') {
        this.modeValue = 'off'
        this.disableRequested = false
        this.log('controller disabled')
      } else {
        this.modeValue = 'disabling'
      }
      return
    }
    this.modeValue = 'active'
  }

  dispose(now = this.now()): void {
    this.controller?.dispose(now)
    this.modeValue = 'off'
    this.disableRequested = false
  }

  private requireEnabled(): P2Controller {
    if (this.controller === undefined || this.modeValue === 'off') {
      throw p2Error('CONTROLLER_DISABLED', 'control', 'enable the controller before using it', {
        module: 'body.controller',
      })
    }
    return this.controller
  }

  private createController(): P2Controller {
    return new P2Controller({
      actuator: this.actuator(),
      sense: { sample: source => this.sense(source) },
      facts: this.factSources,
      now: this.now,
      coherenceWindowMs: 1200,
      factTtlMs: 1500,
      refreshIntervalMs: 200,
      stopTimeoutMs: 2500,
      verificationTimeoutMs: 3000,
      unknownDeadlineMs: 5000,
      onEvent: event => this.record(event),
    })
  }

  private actuator(): ActuatorPort {
    return {
      start: (request: ActionRequest, grant: LeaseGrant): ActHandle => {
        const handle = this.act.start(
          { definitionId: request.act, artifactId: request.act },
          request.args,
          {
            runId: CONTROLLER_RUN_ID,
            actInstanceId: `controller-act-${++this.actSequence}`,
            generation: grant.generation,
          },
        )
        return {
          poll: () => toActionOutcome(handle.poll()),
          stop: () => handle.stop(),
        }
      },
      stop: now => this.act.stopRun?.(now, CONTROLLER_RUN_ID),
      release: (now): ReleaseReport => {
        if (this.act.pollRelease === undefined) {
          return { status: 'unconfirmed', detail: 'act port cannot prove release' }
        }
        const status = this.act.pollRelease(now)
        if (status === 'released' || status === 'idle') return { status: 'released' }
        if (status === 'stopping') return { status: 'stopping' }
        return { status: 'unconfirmed', detail: status }
      },
    }
  }

  private sense(source: FactSource): SenseResult {
    let outcome: QueryOutcome
    try {
      outcome = this.query({ op: source.op, args: {} }, source.args ?? {})
    } catch (error) {
      return {
        status: 'failed',
        error: p2Error('SENSE_FAILED', 'environment', error instanceof Error ? error.message : String(error), {
          module: 'body.controller',
          opId: source.op,
        }),
      }
    }
    if (outcome.status === 'pending') return { status: 'pending' }
    if (outcome.status === 'failed') return { status: 'failed', error: outcome.error }
    const meta = outcome.meta
    return {
      status: 'ok',
      value: outcome.value,
      scope: source.scope ?? meta?.scope ?? 'body',
      ...(meta?.sampledAt === undefined ? {} : { sampledAt: meta.sampledAt }),
    }
  }

  private observeWorldChange(now: number): void {
    const controller = this.controller
    if (controller === undefined) return
    const provider = this.providerStatus?.()
    if (provider !== undefined && typeof provider.lastDeathAt === 'number' && provider.lastDeathAt !== this.lastDeathAt) {
      this.lastDeathAt = provider.lastDeathAt
      controller.recordDeath(provider.lastDeathPosition ?? null, now)
      this.log('controller observations invalidated after death')
    }
    const position = controller.observations.read('position', now)
    const value = position.known ? position.fact.value : null
    const dimension = isRecord(value) && typeof value.dimension === 'string' ? value.dimension : null
    if (dimension !== null) {
      if (this.lastDimension !== null && dimension !== this.lastDimension) {
        controller.invalidateScope('body', now)
        this.log(`controller observations invalidated after dimension change to ${dimension}`)
      }
      this.lastDimension = dimension
    }
  }

  private record(event: ControllerEvent): void {
    const view: ControllerEventView = {
      seq: ++this.eventSequence,
      at: event.at,
      kind: event.kind,
      ...(event.slot === undefined ? {} : { slot: event.slot }),
      ...(event.strategyKey === undefined ? {} : { strategyKey: event.strategyKey }),
      ...(event.commitmentId === undefined ? {} : { commitmentId: event.commitmentId }),
      ...(event.detail === undefined ? {} : { detail: event.detail }),
      ...(event.data === undefined ? {} : { data: event.data }),
    }
    this.eventLog.push(view)
    if (this.eventLog.length > EVENT_LIMIT) this.eventLog.shift()
  }
}

function toActionOutcome(poll: ActPoll): ActionOutcome {
  switch (poll.status) {
    case 'running':
      return { status: 'running' }
    case 'succeeded':
      return { status: 'succeeded', ...(poll.result === undefined ? {} : { result: poll.result }) }
    case 'failed':
      return { status: 'failed', error: poll.error }
    case 'cancelled':
      return { status: 'cancelled', ...(poll.error === undefined ? {} : { reason: poll.error.message }) }
  }
}

function summarizeCommitment(commitment: Commitment): ControllerCommitmentView {
  return {
    id: commitment.id,
    goal: commitment.goal,
    strategyKey: commitment.strategyKey,
    state: commitment.state,
    deadline: commitment.deadline,
    checkpoint: commitment.checkpoint,
    ...(commitment.suspendedAt === undefined ? {} : { suspendedAt: commitment.suspendedAt }),
    ...(commitment.suspendReason === undefined ? {} : { suspendReason: commitment.suspendReason }),
    ...(commitment.blocked === undefined ? {} : { blocked: commitment.blocked as unknown as JsonValue }),
    evidence: commitment.evidence as unknown as JsonValue[],
  }
}

function emptyView(
  mode: ControllerMode,
  enabledAt: number | null,
  events: ControllerEventView[],
  eventSeq: number,
): ControllerView {
  return {
    mode,
    enabledAt,
    queueLength: 0,
    phase: null,
    lease: null,
    action: null,
    decision: null,
    decisions: [],
    metrics: {
      startedAt: 0,
      ticks: 0,
      lastTickAt: 0,
      commitmentActiveMs: 0,
      noProgressMs: 0,
      idleMs: 0,
      lastProgressAt: 0,
      actionsStarted: 0,
      actionsFailed: 0,
      commitmentsSucceeded: 0,
      commitmentsFailed: 0,
      commitmentsBlocked: 0,
      deaths: 0,
      deathsByClass: {},
      s0Latency: [],
    },
    commitment: null,
    commitments: [],
    strategies: [],
    verification: null,
    stall: null,
    memory: null,
    degraded: [],
    events: events.slice(-50),
    eventSeq,
  }
}

function parsePostCondition(value: JsonValue): PostCondition {
  if (!isRecord(value)) {
    throw p2Error('INVALID_POSTCONDITION', 'validation', 'post must be an object', { module: 'body.controller' })
  }
  if (value.kind === 'standing') return { kind: 'standing' }
  if (value.kind === 'count-at-least') {
    if (typeof value.factKey !== 'string' || value.factKey.length === 0) {
      throw p2Error('INVALID_POSTCONDITION', 'validation', 'post.factKey is required', { module: 'body.controller' })
    }
    if (typeof value.item !== 'string' || value.item.length === 0) {
      throw p2Error('INVALID_POSTCONDITION', 'validation', 'post.item is required', { module: 'body.controller' })
    }
    if (typeof value.count !== 'number' || !Number.isInteger(value.count) || Math.abs(value.count) > 1_000_000) {
      throw p2Error('INVALID_POSTCONDITION', 'validation', 'post.count must be a bounded integer', { module: 'body.controller' })
    }
    if (value.fromBaseline !== undefined && typeof value.fromBaseline !== 'boolean') {
      throw p2Error('INVALID_POSTCONDITION', 'validation', 'post.fromBaseline must be a boolean', { module: 'body.controller' })
    }
    return {
      kind: 'count-at-least',
      factKey: value.factKey,
      item: value.item,
      count: value.count,
      ...(value.fromBaseline === true ? { fromBaseline: true } : {}),
    }
  }
  if (value.kind === 'fact-equals') {
    if (typeof value.factKey !== 'string' || value.factKey.length === 0 || value.value === undefined) {
      throw p2Error('INVALID_POSTCONDITION', 'validation', 'post.factKey and post.value are required', {
        module: 'body.controller',
      })
    }
    return { kind: 'fact-equals', factKey: value.factKey, value: value.value }
  }
  throw p2Error('INVALID_POSTCONDITION', 'validation', `unknown post kind: ${String(value.kind)}`, {
    module: 'body.controller',
  })
}

function isRecord(value: JsonValue | unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}







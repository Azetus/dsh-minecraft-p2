import type { ArtifactRef, BehaviorArtifact, ContentArtifact } from '../contracts/ir.ts'
import type { LastRunSummary, ProviderRuntimeStatus, RescueParams, RescueResult } from '../contracts/protocol.ts'
import type {
  CleanupState,
  ControlHealth,
  CurrentStep,
  GuardCondition,
  GuardEvent,
  GuardEventPhase,
  GuardState,
  GuardStatus,
  GuardSwitchSummary,
  SwitchState,
} from '../contracts/protocol.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import { CheckerError, checkBehavior } from './checker.ts'
import type { CheckerCredential } from './checker.ts'
import { checkAct } from './act-checker.ts'
import { checkPolicy } from './policy-checker.ts'
import { checkOp } from './op-checker.ts'
import { checkBehaviorJs } from './js-checker.ts'
import type { AuthoredOpArtifact } from './op-artifact.ts'
import type { OperationContract } from '../operation/index.ts'
import type { TraceSink } from './trace.ts'
import { CommandLedger } from './logging.ts'
import { BehaviorRun } from './run.ts'
import { JsBehaviorRun } from './js-runtime.ts'
import { RunnerBehaviorDriver } from './behavior-driver.ts'
import type { RunnerClient } from './runner-client.ts'
import type { ConfirmInput, ConfirmResult, RunStatus } from './run.ts'
import { ArtifactRegistry, RegistryError } from './registry.ts'
import type { ArtifactRecord } from './registry.ts'
import type { ActPort, PolicyPort, QueryOutcome, QueryPort } from './node-runtime.ts'
import type { ActSource } from './act-port.ts'
import type { PolicySource } from './policy-port.ts'

export type CheckHostRequest = {
  sourcePath: string
  sourceRoot?: string
  timeoutMs?: number
  artifactKind?: 'behavior' | 'act' | 'policy' | 'op'
  /** Experimental behavior script format; default is IR. */
  format?: 'ir' | 'js'
}

export type CheckHostResult = {
  artifactId: string
  definitionId: string
  sourceDigest: string
  kind: 'behavior' | 'act' | 'policy' | 'op'
  artifact: ContentArtifact
}

export type SwitchInput = {
  artifactId: string
  params: Record<string, JsonValue>
  commandId: string
}

export type SwitchResult = {
  accepted: boolean
  runId: string | null
  status: RunStatus | 'rejected' | 'superseded' | 'stopping'
  error?: P2Error
}

export type HostStatus = {
  bindingId: string
  activeRun: null | {
    runId: string
    status: RunStatus
    artifactId: string
    completion: string | null
  }
  pendingConfirmation: null | {
    id: string
    runId: string
  }
  lastRun: LastRunSummary | null
  providerState: ProviderRuntimeStatus | null
  commandCount: number
  activeAct: string | null
  activeNode: string | null
  activeTarget: { x: number; z: number } | null
  waiting: string | null
  lastFailure: P2Error | null
  currentStep: CurrentStep | null
  stepCount: number
  progress: JsonValue | null
  lastError: P2Error | null
  cleanupState: CleanupState
  controlHealth: ControlHealth
  switchState: SwitchState
  guard: GuardStatus | null
  lastSwitch: GuardSwitchSummary | null
  guardEvents: GuardEvent[]
  guardEventSeq: number
}

export type GuardSetInput = {
  condition: GuardCondition
  targetArtifactId: string
  params: Record<string, JsonValue>
  ttlMs: number
}

type ActiveGuard = {
  id: string
  condition: GuardCondition
  targetArtifactId: string
  params: Record<string, JsonValue>
  armedAt: number
  expiresAt: number
  state: GuardState
  attemptId?: string
  lastError?: P2Error
}

type PendingSwitch = {
  artifactId: string
  params: Record<string, JsonValue>
  commandId: string
  source: 'user' | 'guard'
  guardId?: string
  attemptId?: string
  /** Run that the guard attempt stopped, recorded on the attempt until it starts the target. */
  fromRunId?: string | null
}

const GUARD_EVAL_INTERVAL_MS = 250
const GUARD_QUERY_TIMEOUT_MS = 1000
const GUARD_ERROR_LIMIT = 3
const GUARD_EVENT_LIMIT = 64

export type BehaviorHostOptions = {
  bindingId: string
  query: QueryPort
  act: ActPort
  policy?: PolicyPort
  owner?: string
  builtinsDigest?: string
  providerStatus?: () => ProviderRuntimeStatus
  newRunId?: () => string
  /** Load act/policy code in a sandbox to extract its manifest. */
  loadManifest?: (kind: 'act' | 'policy', code: string, artifactId: string) => Promise<JsonValue>
  /** Load behavior code in the sandbox runner to extract its manifest. */
  loadBehaviorManifest?: (code: string, artifactId: string) => Promise<JsonValue>
  /** Experiment-only rescue channel; behavior/act cannot reach it. */
  rescue?: (request: RescueParams, context: { owner: string }) => Promise<RescueResult>
  /** Sandbox runner used for author JS behavior code in production. */
  behaviorRunner?: RunnerClient | (() => RunnerClient)
  /** Developer trace sink; recording never affects scheduling or control. */
  trace?: TraceSink
}

/** Library-level behavior host used by M1 tests; body wiring remains separate. */
export class BehaviorHost {
  private readonly registry: ArtifactRegistry
  private readonly bindingId: string
  private readonly credentials = new Map<string, CheckerCredential>()
  private readonly ledger = new CommandLedger<SwitchResult | ConfirmResult | { artifactId: string }>()
  private readonly query: QueryPort
  private readonly act: ActPort
  private readonly policy: PolicyPort
  private readonly providerStatus: (() => ProviderRuntimeStatus) | undefined
  private readonly loadManifest: BehaviorHostOptions['loadManifest']
  private readonly loadBehaviorManifest: BehaviorHostOptions['loadBehaviorManifest']
  private readonly rescue: BehaviorHostOptions['rescue']
  private readonly behaviorRunner: RunnerClient | (() => RunnerClient) | undefined
  private readonly trace: TraceSink | undefined
  private owner: string
  private readonly newRunId: () => string
  private run: BehaviorRun | JsBehaviorRun | undefined
  private runArtifact: string | undefined
  private runTrace: { runId: string; name: string; startedAt: number; artifactId: string } | undefined
  private pendingSwitch: PendingSwitch | undefined
  private lastRun: LastRunSummary | null = null
  private sequence = 0
  private guard: ActiveGuard | undefined
  private guardSequence = 0
  private attemptSequence = 0
  private guardNextEvalAt = 0
  private guardFailures = 0
  private guardInFlight: { poll: () => QueryOutcome; startedAt: number } | undefined
  private lastSwitch: GuardSwitchSummary | null = null
  private readonly guardEvents: GuardEvent[] = []
  private guardEventSeq = 0

  constructor(options: BehaviorHostOptions) {
    this.bindingId = options.bindingId
    this.registry = new ArtifactRegistry({
      bindingId: options.bindingId,
      ...(options.builtinsDigest === undefined ? {} : { builtinsDigest: options.builtinsDigest }),
    })
    this.query = options.query
    this.act = options.act
    this.policy = options.policy ?? (() => ({
      status: 'failed',
      error: p2Error('POLICY_UNAVAILABLE', 'capability', 'no policy runner is configured', { module: 'core.host' }),
    }))
    this.providerStatus = options.providerStatus
    this.loadManifest = options.loadManifest
    this.loadBehaviorManifest = options.loadBehaviorManifest
    this.rescue = options.rescue
    this.behaviorRunner = options.behaviorRunner
    this.trace = options.trace
    this.owner = options.owner ?? 'host'
    this.newRunId = options.newRunId ?? (() => `run-${++this.sequence}`)
  }

  async check(request: CheckHostRequest): Promise<CheckHostResult> {
    const kind = request.artifactKind ?? 'behavior'
    if (kind === 'act') return this.checkAct(request)
    if (kind === 'policy') return this.checkPolicy(request)
    if (kind === 'op') return this.checkOp(request)
    if (request.format === 'js') return this.checkJsBehavior(request)
    return this.checkBehavior(request)
  }

  private async checkBehavior(request: CheckHostRequest): Promise<CheckHostResult> {
    const result = await checkBehavior({
      sourcePath: request.sourcePath,
      ...(request.sourceRoot === undefined ? {} : { sourceRoot: request.sourceRoot }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      bindingId: this.bindingId,
      resolveAct: definitionId => this.registry.resolveDefault('act', definitionId)?.artifactId,
      resolvePolicy: definitionId => this.registry.find('policy', definitionId)?.artifactId,
    })
    this.credentials.set(result.artifact.artifactId, result.credential)
    this.registry.add(result.artifact, result.credential)
    return {
      artifactId: result.artifact.artifactId,
      definitionId: result.artifact.definition.id,
      sourceDigest: result.artifact.sourceDigest,
      kind: 'behavior',
      artifact: result.artifact,
    }
  }

  private async checkJsBehavior(request: CheckHostRequest): Promise<CheckHostResult> {
    const loadManifest = this.loadBehaviorManifest
    const result = await checkBehaviorJs({
      sourcePath: request.sourcePath,
      ...(request.sourceRoot === undefined ? {} : { sourceRoot: request.sourceRoot }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      bindingId: this.bindingId,
      ...(loadManifest === undefined
        ? {}
        : { loadManifest: (code: string, artifactId: string) => loadManifest(code, artifactId) }),
      resolveDependency: (kind, definitionId) => {
        const artifact = kind === 'act'
          ? this.registry.resolveDefault('act', definitionId)
          : this.registry.find('policy', definitionId)
        return artifact === undefined
          ? undefined
          : { artifactId: artifact.artifactId, digest: artifact.artifactDigest }
      },
    })
    this.credentials.set(result.artifact.artifactId, result.credential)
    this.registry.add(result.artifact, result.credential)
    return {
      artifactId: result.artifact.artifactId,
      definitionId: result.artifact.definition.id,
      sourceDigest: result.artifact.sourceDigest,
      kind: 'behavior',
      artifact: result.artifact,
    }
  }

  private async checkAct(request: CheckHostRequest): Promise<CheckHostResult> {
    if (this.loadManifest === undefined) {
      throw new CheckerError('ACT_CHECK_UNAVAILABLE', 'this host cannot load act artifacts')
    }
    const loadManifest = this.loadManifest
    const result = await checkAct({
      sourcePath: request.sourcePath,
      ...(request.sourceRoot === undefined ? {} : { sourceRoot: request.sourceRoot }),
      bindingId: this.bindingId,
      loadManifest: (code, artifactId) => loadManifest('act', code, artifactId),
      resolveOperation: name => this.opContract(name),
    })
    this.credentials.set(result.artifact.artifactId, result.credential)
    this.registry.add(result.artifact, result.credential)
    return {
      artifactId: result.artifact.artifactId,
      definitionId: result.artifact.definitionId,
      sourceDigest: result.artifact.sourceDigest,
      kind: 'act',
      artifact: result.artifact,
    }
  }

  private async checkPolicy(request: CheckHostRequest): Promise<CheckHostResult> {
    if (this.loadManifest === undefined) {
      throw new CheckerError('POLICY_CHECK_UNAVAILABLE', 'this host cannot load policy artifacts')
    }
    const loadManifest = this.loadManifest
    const result = await checkPolicy({
      sourcePath: request.sourcePath,
      ...(request.sourceRoot === undefined ? {} : { sourceRoot: request.sourceRoot }),
      bindingId: this.bindingId,
      loadManifest: (code, artifactId) => loadManifest('policy', code, artifactId),
    })
    this.credentials.set(result.artifact.artifactId, result.credential)
    this.registry.add(result.artifact, result.credential)
    return {
      artifactId: result.artifact.artifactId,
      definitionId: result.artifact.definitionId,
      sourceDigest: result.artifact.sourceDigest,
      kind: 'policy',
      artifact: result.artifact,
    }
  }

  private async checkOp(request: CheckHostRequest): Promise<CheckHostResult> {
    const result = await checkOp({
      sourcePath: request.sourcePath,
      ...(request.sourceRoot === undefined ? {} : { sourceRoot: request.sourceRoot }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      bindingId: this.bindingId,
    })
    this.credentials.set(result.artifact.artifactId, result.credential)
    this.registry.add(result.artifact, result.credential)
    return {
      artifactId: result.artifact.artifactId,
      definitionId: result.artifact.definitionId,
      sourceDigest: result.artifact.sourceDigest,
      kind: 'op',
      artifact: result.artifact,
    }
  }

  setOwner(owner: string): void {
    this.owner = owner
  }

  async rescueRun(request: RescueParams): Promise<RescueResult> {
    if (this.run !== undefined && !isTerminal(this.run.status)) {
      throw p2Error('RESCUE_BUSY', 'runtime', 'stop the active behavior before using rescue', { module: 'core.host' })
    }
    if (this.rescue === undefined) {
      throw p2Error('RESCUE_UNAVAILABLE', 'capability', 'rescue is not configured for this body', { module: 'core.host' })
    }
    return this.rescue(request, { owner: this.owner })
  }

  observe(op: string, args: Record<string, JsonValue> = {}): QueryOutcome {
    return this.query({ op, args: {} }, args)
  }

  activate(artifactId: string): { artifactId: string; bindingId: string; enabled: true; kind: 'behavior' | 'act' | 'policy' | 'op' } {
    const record = this.registry.get(artifactId)
    if (record !== undefined && record.artifact.kind === 'policy') {
      throw new RegistryError('POLICY_NOT_ACTIVATABLE', 'policy artifacts are dependencies and are not enabled separately')
    }
    const credential = this.credentials.get(artifactId)
    if (credential === undefined) {
      throw new RegistryError('CHECKER_CREDENTIAL_MISSING', `no checker credential for ${artifactId}`)
    }
    const enabled = this.registry.enable(artifactId, credential)
    return { artifactId, bindingId: this.bindingId, enabled: true, kind: enabled.artifact.kind }
  }

  /** Exact act source for the runner, or undefined when it is not registered. */
  actSource(artifactId: string): ActSource | undefined {
    const record = this.registry.get(artifactId)
    if (record === undefined || record.artifact.kind !== 'act') return undefined
    return {
      artifactId: record.artifact.artifactId,
      definitionId: record.artifact.definitionId,
      code: record.artifact.code,
      ops: record.artifact.ops,
      ...(record.artifact.limits === undefined ? {} : { limits: record.artifact.limits }),
    }
  }

  /** Exact policy source for the runner, or undefined when it is not registered. */
  policySource(artifactId: string): PolicySource | undefined {
    const record = this.registry.get(artifactId)
    if (record === undefined || record.artifact.kind !== 'policy') return undefined
    return { artifactId: record.artifact.artifactId, code: record.artifact.code }
  }

  /**
   * Activated authored op for one bare op name. Activation replaces the
   * built-in implementation for the rest of the body epoch; retiring it falls
   * back to the provider.
   */
  opArtifact(name: string): AuthoredOpArtifact | undefined {
    const artifact = this.registry.resolveDefault('op', name)
    if (artifact === undefined || artifact.kind !== 'op') return undefined
    return {
      artifactId: artifact.artifactId,
      name: artifact.definitionId,
      opKind: artifact.opKind,
      effects: artifact.effects,
      stop: artifact.stop,
      capabilities: [...artifact.capabilities],
      ...(artifact.limits === undefined ? {} : { limits: artifact.limits }),
      code: artifact.code,
    }
  }

  /** Declaration used by act checks and the broker for an activated authored op. */
  opContract(name: string): OperationContract | undefined {
    const artifact = this.opArtifact(name)
    if (artifact === undefined) return undefined
    return {
      id: artifact.name,
      kind: artifact.opKind,
      effects: artifact.effects,
      stop: artifact.stop,
      capabilities: [...artifact.capabilities],
    }
  }

  switch(input: SwitchInput): SwitchResult {
    const duplicate = this.ledger.get(input.commandId)
    if (duplicate !== undefined && 'accepted' in duplicate) return duplicate

    const record = this.registry.get(input.artifactId)
    if (record === undefined) {
      const result: SwitchResult = {
        accepted: false,
        runId: null,
        status: 'rejected',
        error: p2Error('ARTIFACT_NOT_ACTIVE', 'validation', 'artifact is not active', { module: 'core.host' }),
      }
      this.ledger.record(input.commandId, result)
      return result
    }
    if (record.artifact.kind !== 'behavior') {
      const result: SwitchResult = {
        accepted: false,
        runId: null,
        status: 'rejected',
        error: p2Error('ARTIFACT_NOT_BEHAVIOR', 'validation', 'artifactId is not a behavior artifact', { module: 'core.host' }),
      }
      this.ledger.record(input.commandId, result)
      return result
    }
    if (record.retired || !record.enabled) {
      const result: SwitchResult = {
        accepted: false,
        runId: null,
        status: 'rejected',
        error: p2Error('ARTIFACT_NOT_ACTIVE', 'validation', 'artifact is not active', { module: 'core.host' }),
      }
      this.ledger.record(input.commandId, result)
      return result
    }

    let params: Record<string, JsonValue>
    try {
      params = validateParams(record.artifact, input.params)
    } catch (error) {
      const result: SwitchResult = {
        accepted: false,
        runId: null,
        status: 'rejected',
        error: p2Error('INVALID_PARAMS', 'validation', error instanceof Error ? error.message : String(error), { module: 'core.host' }),
      }
      this.ledger.record(input.commandId, result)
      return result
    }

    // A newer valid switch supersedes an unactivated pending candidate.
    this.suppressGuardPending('superseded by switch')
    this.pendingSwitch = undefined

    if (this.run !== undefined && !isTerminal(this.run.status)) {
      this.run.stop()
      for (let index = 0; index < 100 && !isTerminal(this.run.status); index += 1) this.run.tick()
      this.rememberLastRun()
      if (!isTerminal(this.run.status)) {
        if (this.run.stopState === 'stop-unconfirmed') {
          const result: SwitchResult = {
            accepted: false,
            runId: this.run.runId,
            status: 'superseded',
            error: p2Error('STOP_UNCONFIRMED', 'timeout', 'old run control release was not confirmed', { module: 'core.host' }),
          }
          this.ledger.record(input.commandId, result)
          return result
        }
        // Release is still settling: accept the candidate and activate it once
        // the old run proves control is gone.
        this.pendingSwitch = { artifactId: input.artifactId, params, commandId: input.commandId, source: 'user' }
        const result: SwitchResult = { accepted: true, runId: this.run.runId, status: 'stopping' }
        this.ledger.record(input.commandId, result)
        return result
      }
    }

    if (this.run !== undefined && !this.run.allowsTakeover) {
      // A terminal JS run may still be releasing its runner slot.
      this.pendingSwitch = { artifactId: input.artifactId, params, commandId: input.commandId, source: 'user' }
      const result: SwitchResult = { accepted: true, runId: this.run.runId, status: 'stopping' }
      this.ledger.record(input.commandId, result)
      return result
    }

    const runId = this.startRun(record, params)
    const result: SwitchResult = { accepted: true, runId, status: 'running' }
    this.ledger.record(input.commandId, result)
    return result
  }

  private startRun(record: ArtifactRecord, params: Record<string, JsonValue>): string {
    const artifact = record.artifact
    if (artifact.kind !== 'behavior') {
      throw p2Error('ARTIFACT_NOT_BEHAVIOR', 'validation', 'artifactId is not a behavior artifact', { module: 'core.host' })
    }
    const runId = this.newRunId()
    this.runTrace = {
      runId,
      name: artifact.definition.id,
      startedAt: Date.now(),
      artifactId: artifact.artifactId,
    }
    this.trace?.record('run', 'start', artifact.definition.id, {
      runId,
      detail: { artifactId: artifact.artifactId, format: artifact.format ?? 'ir' },
    })
    if (artifact.format === 'js') {
      const acts = artifact.resolvedDependencies?.acts ?? {}
      const policies = artifact.resolvedDependencies?.policies ?? {}
      this.run = new JsBehaviorRun({
        runId,
        owner: this.owner,
        artifact,
        params,
        query: this.query,
        act: this.act,
        policy: this.policy,
        allowedActs: new Set(Object.values(acts)),
        allowedPolicies: new Set(Object.values(policies)),
        resolveAct: definitionId => acts[definitionId],
        resolvePolicy: definitionId => policies[definitionId],
        ...(this.trace === undefined ? {} : { trace: this.trace }),
        ...(this.behaviorRunner === undefined
          ? {}
          : { driver: new RunnerBehaviorDriver(this.behaviorRunner, artifact, runId) }),
      })
    } else {
      this.run = new BehaviorRun({
        runId,
        owner: this.owner,
        definition: artifact.definition,
        params,
        query: this.query,
        act: this.act,
        policy: this.policy,
      })
    }
    this.runArtifact = artifact.artifactId
    return runId
  }

  private activatePending(now = Date.now()): void {
    const pending = this.pendingSwitch
    if (pending === undefined) return
    if (this.run !== undefined && !this.run.allowsTakeover) return
    this.pendingSwitch = undefined
    if (pending.source === 'guard') {
      const guard = this.guard
      if (guard === undefined || guard.id !== pending.guardId || guard.attemptId !== pending.attemptId) {
        this.emitGuard('suppressed', {
          guardId: pending.guardId ?? 'unknown',
          attemptId: pending.attemptId,
          message: 'guard attempt was invalidated before activation',
        })
        return
      }
      if (now >= guard.expiresAt) {
        guard.state = 'expired'
        this.lastSwitch = guardSwitchOf(guard, pending.attemptId, 'failed', 'guard expired before target start', now, pending.fromRunId ?? null)
        this.emitGuard('expired', { guardId: guard.id, attemptId: guard.attemptId, at: now })
        return
      }
      const record = this.registry.get(guard.targetArtifactId)
      if (record === undefined || record.retired || !record.enabled || record.artifact.kind !== 'behavior') {
        this.failGuardTarget(guard, now, 'target is not active at handoff', undefined, pending.fromRunId ?? null)
        return
      }
      this.startGuardTarget(guard, record, now, pending.fromRunId ?? null)
      return
    }
    const record = this.registry.get(pending.artifactId)
    // A candidate that retired while the old run was stopping must not take over.
    if (record === undefined || record.retired || !record.enabled || record.artifact.kind !== 'behavior') return
    this.startRun(record, pending.params)
  }

  tick(now = Date.now()): RunStatus | undefined {
    const status = this.run?.tick(now)
    if (this.run !== undefined && isTerminal(this.run.status)) this.rememberLastRun()
    this.checkGuardPending(now)
    this.activatePending(now)
    this.evaluateGuard(now)
    return status
  }

  private checkGuardPending(now: number): void {
    const pending = this.pendingSwitch
    if (pending?.source !== 'guard') return
    const guard = this.guard
    if (guard === undefined || guard.id !== pending.guardId || guard.attemptId !== pending.attemptId) {
      this.pendingSwitch = undefined
      this.emitGuard('suppressed', {
        guardId: pending.guardId ?? 'unknown',
        attemptId: pending.attemptId,
        message: 'guard attempt was invalidated',
      })
      return
    }
    if (now >= guard.expiresAt) {
      this.pendingSwitch = undefined
      guard.state = 'expired'
      this.lastSwitch = guardSwitchOf(guard, guard.attemptId, 'failed', 'guard expired before target start', now, pending.fromRunId ?? null)
      this.emitGuard('expired', { guardId: guard.id, attemptId: guard.attemptId, at: now })
      return
    }
    if (this.run !== undefined && !isTerminal(this.run.status) && this.run.stopState === 'stop-unconfirmed') {
      this.pendingSwitch = undefined
      const error = p2Error('STOP_UNCONFIRMED', 'timeout', 'old run control release was not confirmed', { module: 'core.host' })
      this.failGuardTarget(guard, now, 'old run stop was not confirmed', error, pending.fromRunId ?? null)
    }
  }

  private evaluateGuard(now: number): void {
    const guard = this.guard
    if (guard === undefined || guard.state !== 'active') return
    if (now >= guard.expiresAt) {
      guard.state = 'expired'
      this.guardInFlight = undefined
      this.emitGuard('expired', { guardId: guard.id, at: now })
      return
    }
    if (this.pendingSwitch !== undefined) return
    if (now < this.guardNextEvalAt) return
    this.guardNextEvalAt = now + GUARD_EVAL_INTERVAL_MS
    if (this.guardInFlight !== undefined) {
      if (now - this.guardInFlight.startedAt > GUARD_QUERY_TIMEOUT_MS) {
        this.guardInFlight = undefined
        this.failGuardEvaluation(guard, now, p2Error('GUARD_QUERY_TIMEOUT', 'timeout', 'guard health query timed out', { module: 'core.host' }))
        return
      }
      const outcome = this.guardInFlight.poll()
      if (outcome.status === 'pending') return
      this.guardInFlight = undefined
      this.handleGuardOutcome(guard, outcome, now)
      return
    }
    const outcome = this.query({ op: 'health', args: {} }, {})
    if (outcome.status === 'pending') {
      this.guardInFlight = { poll: outcome.poll, startedAt: now }
      return
    }
    this.handleGuardOutcome(guard, outcome, now)
  }

  private handleGuardOutcome(guard: ActiveGuard, outcome: QueryOutcome, now: number): void {
    if (this.guard !== guard || guard.state !== 'active') return
    if (outcome.status === 'failed') {
      this.failGuardEvaluation(guard, now, outcome.error)
      return
    }
    if (outcome.status !== 'ok') return
    const meta = outcome.meta
    if (meta?.validUntil !== undefined && now > meta.validUntil) {
      this.failGuardEvaluation(guard, now, p2Error('STALE_OBSERVATION', 'runtime', 'guard health observation is stale', { module: 'core.host' }))
      return
    }
    const value = outcome.value
    const health = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as { health?: unknown }).health
      : undefined
    if (typeof health !== 'number' || !Number.isFinite(health) || health <= 0) {
      this.failGuardEvaluation(guard, now, p2Error('GUARD_HEALTH_UNKNOWN', 'runtime', 'guard health is unavailable', { module: 'core.host' }))
      return
    }
    this.guardFailures = 0
    if (health <= guard.condition.hpBelow) {
      this.fireGuard(guard, now, { health, sampledAt: meta?.sampledAt ?? now })
    }
  }

  private failGuardEvaluation(guard: ActiveGuard, now: number, error: P2Error): void {
    if (this.guard !== guard || guard.state !== 'active') return
    this.guardFailures += 1
    guard.lastError = error
    this.emitGuard('error', {
      guardId: guard.id,
      error,
      message: `guard evaluation failed (${this.guardFailures}/${GUARD_ERROR_LIMIT})`,
      at: now,
    })
    if (this.guardFailures >= GUARD_ERROR_LIMIT) {
      guard.state = 'error'
      this.emitGuard('error', { guardId: guard.id, error, message: 'guard disabled after repeated evaluation failures', at: now })
    }
  }

  private fireGuard(guard: ActiveGuard, now: number, evidence: JsonValue): void {
    if (this.guard !== guard || guard.state !== 'active') return
    const attemptId = `attempt-${++this.attemptSequence}`
    guard.state = 'firing'
    guard.attemptId = attemptId
    this.guardInFlight = undefined
    const fromRunId = this.run?.runId ?? null
    this.emitGuard('fired', {
      guardId: guard.id,
      attemptId,
      condition: guard.condition,
      evidence,
      targetArtifactId: guard.targetArtifactId,
      fromRunId,
      at: now,
    })
    const record = this.registry.get(guard.targetArtifactId)
    if (record === undefined || record.retired || !record.enabled || record.artifact.kind !== 'behavior') {
      guard.state = 'fired'
      guard.lastError = p2Error('GUARD_TARGET_NOT_ACTIVE', 'validation', 'target is not active before stop', { module: 'core.host' })
      this.lastSwitch = guardSwitchOf(guard, attemptId, 'precheck-failed', 'target is not active before stop', now, fromRunId)
      this.emitGuard('precheck-failed', {
        guardId: guard.id,
        attemptId,
        targetArtifactId: guard.targetArtifactId,
        fromRunId,
        message: 'target is not active before stop',
        at: now,
      })
      return
    }
    if (this.run === undefined || isTerminal(this.run.status)) {
      this.startGuardTarget(guard, record, now, fromRunId)
      return
    }
    this.run.stop()
    this.pendingSwitch = {
      artifactId: guard.targetArtifactId,
      params: guard.params,
      commandId: `guard:${attemptId}`,
      source: 'guard',
      guardId: guard.id,
      attemptId,
      fromRunId,
    }
    this.lastSwitch = guardSwitchOf(guard, attemptId, 'stopping', 'guard fired', now, fromRunId)
    this.emitGuard('stopping', {
      guardId: guard.id,
      attemptId,
      targetArtifactId: guard.targetArtifactId,
      fromRunId,
      at: now,
    })
  }

  private startGuardTarget(guard: ActiveGuard, record: ArtifactRecord, now: number, fromRunId: string | null): void {
    const attemptId = guard.attemptId
    if (this.guard !== guard || attemptId === undefined) return
    if (now >= guard.expiresAt) {
      guard.state = 'expired'
      this.lastSwitch = guardSwitchOf(guard, attemptId, 'failed', 'guard expired before target start', now, fromRunId)
      this.emitGuard('expired', { guardId: guard.id, attemptId, at: now })
      return
    }
    if (record.retired || !record.enabled) {
      this.failGuardTarget(guard, now, 'target is not active at handoff', undefined, fromRunId)
      return
    }
    try {
      const runId = this.startRun(record, guard.params)
      guard.state = 'fired'
      this.lastSwitch = {
        ...guardSwitchOf(guard, attemptId, 'started', 'guard target started', now),
        fromRunId,
        toRunId: runId,
      }
      this.emitGuard('started', {
        guardId: guard.id,
        attemptId,
        targetArtifactId: guard.targetArtifactId,
        fromRunId,
        toRunId: runId,
        at: now,
      })
    } catch (error) {
      const failure = p2Error(
        'GUARD_START_FAILED',
        'runtime',
        error instanceof Error ? error.message : String(error),
        { module: 'core.host' },
      )
      this.failGuardTarget(guard, now, failure.message, failure, fromRunId)
    }
  }

  private failGuardTarget(guard: ActiveGuard, now: number, message: string, error?: P2Error, fromRunId: string | null = null): void {
    guard.state = 'error'
    const failure = error ?? p2Error('GUARD_START_FAILED', 'runtime', message, { module: 'core.host' })
    guard.lastError = failure
    const attemptId = guard.attemptId ?? 'unknown'
    this.lastSwitch = guardSwitchOf(guard, attemptId, 'failed', message, now, fromRunId)
    this.emitGuard('failed', {
      guardId: guard.id,
      attemptId: guard.attemptId,
      targetArtifactId: guard.targetArtifactId,
      error: failure,
      message,
      at: now,
    })
  }

  private suppressGuardPending(reason: string): void {
    const pending = this.pendingSwitch
    if (pending?.source !== 'guard') return
    const guard = this.guard
    if (guard !== undefined && guard.id === pending.guardId) {
      guard.state = 'fired'
      this.lastSwitch = guardSwitchOf(guard, pending.attemptId, 'suppressed', reason, Date.now(), pending.fromRunId ?? null)
      this.emitGuard('suppressed', {
        guardId: guard.id,
        attemptId: pending.attemptId,
        targetArtifactId: guard.targetArtifactId,
        message: reason,
      })
    }
  }

  private emitGuard(phase: GuardEventPhase, input: {
    guardId: string
    attemptId?: string | undefined
    condition?: GuardCondition
    evidence?: JsonValue
    targetArtifactId?: string
    fromRunId?: string | null
    toRunId?: string | null
    message?: string
    error?: P2Error
    at?: number
  }): void {
    this.guardEventSeq += 1
    const event: GuardEvent = {
      seq: this.guardEventSeq,
      guardId: input.guardId,
      phase,
      at: input.at ?? Date.now(),
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      ...(input.condition === undefined ? {} : { condition: input.condition }),
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      ...(input.targetArtifactId === undefined ? {} : { targetArtifactId: input.targetArtifactId }),
      ...(input.fromRunId === undefined ? {} : { fromRunId: input.fromRunId }),
      ...(input.toRunId === undefined ? {} : { toRunId: input.toRunId }),
      ...(input.message === undefined ? {} : { message: input.message }),
      ...(input.error === undefined ? {} : { error: input.error }),
    }
    this.guardEvents.push(event)
    while (this.guardEvents.length > GUARD_EVENT_LIMIT) this.guardEvents.shift()
    this.trace?.record('guard', 'event', phase, {
      ...(this.run === undefined ? {} : { runId: this.run.runId }),
      detail: {
        guardId: input.guardId,
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        ...(input.targetArtifactId === undefined ? {} : { targetArtifactId: input.targetArtifactId }),
        ...(input.message === undefined ? {} : { message: input.message }),
      },
    })
  }

  confirm(input: ConfirmInput): ConfirmResult {
    if (this.run === undefined) {
      return {
        outcome: 'rejected',
        status: 'cancelled',
        error: p2Error('RUN_NOT_FOUND', 'validation', 'no active run', { module: 'core.host' }),
      }
    }
    const result = this.run.confirm(input)
    this.ledger.record(input.commandId, result)
    return result
  }

  stop(runId: string): { accepted: true; status: RunStatus } | { accepted: false; status: RunStatus; error: P2Error } {
    this.suppressGuardPending('superseded by stop')
    this.pendingSwitch = undefined
    if (this.run === undefined || this.run.runId !== runId) {
      return {
        accepted: false,
        status: 'cancelled',
        error: p2Error('RUN_NOT_FOUND', 'validation', 'run is not active', { module: 'core.host' }),
      }
    }
    if (isTerminal(this.run.status)) {
      return {
        accepted: false,
        status: this.run.status,
        error: p2Error('ALREADY_TERMINAL', 'validation', 'run is already terminal', { module: 'core.host' }),
      }
    }
    this.run.stop()
    this.run.tick()
    this.rememberLastRun()
    return { accepted: true, status: this.run.status }
  }

  retire(artifactId: string): void {
    this.registry.retire(artifactId)
  }

  /** Arm the single one-shot guard. Never starts the target immediately. */
  setGuard(input: GuardSetInput, now = Date.now()): GuardStatus {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs < 10_000 || input.ttlMs > 3_600_000) {
      throw p2Error('GUARD_TTL_INVALID', 'validation', 'guard ttlMs must be between 10000 and 3600000', { module: 'core.host' })
    }
    if (!Number.isFinite(input.condition.hpBelow) || input.condition.hpBelow <= 0) {
      throw p2Error('GUARD_CONDITION_INVALID', 'validation', 'health hpBelow must be a positive number', { module: 'core.host' })
    }
    const record = this.registry.get(input.targetArtifactId)
    if (record === undefined || record.artifact.kind !== 'behavior' || record.retired || !record.enabled) {
      throw p2Error('GUARD_TARGET_NOT_ACTIVE', 'validation', 'guard target is not an enabled behavior artifact', { module: 'core.host' })
    }
    let params: Record<string, JsonValue>
    try {
      params = validateParams(record.artifact, input.params)
    } catch (error) {
      throw p2Error('INVALID_PARAMS', 'validation', error instanceof Error ? error.message : String(error), { module: 'core.host' })
    }

    if (this.pendingSwitch?.source === 'guard') {
      this.suppressGuardPending('replaced by a new guard')
      this.pendingSwitch = undefined
    }
    if (this.guard !== undefined) {
      const replaced = this.guard
      this.emitGuard('cleared', { guardId: replaced.id, message: 'replaced by a new guard' })
    }
    const guard: ActiveGuard = {
      id: `guard-${++this.guardSequence}`,
      condition: { kind: 'health', hpBelow: input.condition.hpBelow },
      targetArtifactId: input.targetArtifactId,
      params,
      armedAt: now,
      expiresAt: now + input.ttlMs,
      state: 'active',
    }
    this.guard = guard
    this.guardFailures = 0
    this.guardInFlight = undefined
    this.guardNextEvalAt = now
    this.emitGuard('armed', {
      guardId: guard.id,
      condition: guard.condition,
      targetArtifactId: guard.targetArtifactId,
      at: now,
    })
    return guardStatusOf(guard)
  }

  /** Revoke the guard without touching the current behavior. */
  clearGuard(now = Date.now()): { cleared: boolean; guard: GuardStatus | null } {
    const guard = this.guard
    if (guard === undefined) return { cleared: false, guard: null }
    if (this.pendingSwitch?.source === 'guard' && this.pendingSwitch.guardId === guard.id) {
      this.suppressGuardPending('guard cleared')
      this.pendingSwitch = undefined
    }
    this.guard = undefined
    this.guardInFlight = undefined
    this.emitGuard('cleared', { guardId: guard.id, at: now })
    return { cleared: true, guard: guardStatusOf(guard) }
  }

  guardStatus(): GuardStatus | null {
    return this.guard === undefined ? null : guardStatusOf(this.guard)
  }

  guardEventLog(): GuardEvent[] {
    return [...this.guardEvents]
  }

  guardHighWatermark(): number {
    return this.guardEventSeq
  }

  /** Report a sandbox runner exit to the active JS run, if any. */
  runnerExited(message: string): void {
    if (this.run instanceof JsBehaviorRun) this.run.runnerExited(message)
  }

  status(): HostStatus {
    const run = this.run
    if (run !== undefined && isTerminal(run.status)) this.rememberLastRun()
    // A terminal run keeps its last progress report; only an active run may
    // describe what is running now. Stale act/node/target fields read as残留控制.
    const active = run !== undefined && !isTerminal(run.status) ? run : undefined
    const observation = active?.observation()
    const history = run?.observation()
    return {
      bindingId: this.bindingId,
      activeRun: active === undefined
        ? null
        : {
            runId: active.runId,
            status: active.status,
            artifactId: this.runArtifact ?? '',
            completion: active.definition.completion?.kind ?? null,
          },
      pendingConfirmation: run?.confirmation?.status === 'pending'
        ? { id: run.confirmation.id, runId: run.runId }
        : null,
      lastRun: this.lastRun,
      providerState: this.providerStatus?.() ?? null,
      commandCount: this.ledger.size,
      activeAct: active?.describe().activeAct ?? null,
      activeNode: active?.describe().activeNode ?? null,
      activeTarget: active?.describe().activeTarget ?? null,
      waiting: active?.describe().waiting ?? null,
      lastFailure: active?.describe().lastFailure ?? null,
      currentStep: observation?.currentStep ?? null,
      stepCount: history?.stepCount ?? 0,
      progress: history?.progress ?? null,
      lastError: history?.lastError ?? null,
      cleanupState: observation?.cleanupState ?? 'none',
      controlHealth: observation?.controlHealth ?? 'ok',
      switchState: this.pendingSwitch !== undefined ? 'queued' : (observation?.switchState ?? 'none'),
      guard: this.guardStatus(),
      lastSwitch: this.lastSwitch,
      guardEvents: [...this.guardEvents],
      guardEventSeq: this.guardEventSeq,
    }
  }

  dispose(): void {
    this.pendingSwitch = undefined
    if (this.run !== undefined && !isTerminal(this.run.status)) {
      this.run.stop()
      this.run.tick()
      this.rememberLastRun()
    }
  }

  private rememberLastRun(): void {
    const run = this.run
    if (run === undefined || !isTerminal(run.status)) return
    const observation = run.observation()
    this.lastRun = {
      runId: run.runId,
      status: run.status,
      ...(run.error === undefined ? {} : { error: run.error }),
      progress: observation.progress,
      ...(observation.evidence === undefined ? {} : { evidence: observation.evidence }),
    }
    const trace = this.runTrace
    if (trace !== undefined && trace.runId === run.runId) {
      this.runTrace = undefined
      this.trace?.record('run', run.status === 'succeeded' ? 'end' : 'error', trace.name, {
        runId: trace.runId,
        durationMs: Date.now() - trace.startedAt,
        detail: {
          status: run.status,
          artifactId: trace.artifactId,
          ...(run.error === undefined ? {} : { code: run.error.code }),
        },
      })
    }
  }
}

function guardStatusOf(guard: ActiveGuard): GuardStatus {
  return {
    id: guard.id,
    state: guard.state,
    condition: guard.condition,
    armedAt: guard.armedAt,
    expiresAt: guard.expiresAt,
    ...(guard.attemptId === undefined ? {} : { attemptId: guard.attemptId }),
    ...(guard.lastError === undefined ? {} : { lastError: guard.lastError }),
  }
}

function guardSwitchOf(
  guard: ActiveGuard,
  attemptId: string | undefined,
  phase: GuardSwitchSummary['phase'],
  reason: string,
  now = Date.now(),
  fromRunId: string | null = null,
): GuardSwitchSummary {
  return {
    guardId: guard.id,
    attemptId: attemptId ?? guard.attemptId ?? 'unknown',
    reason,
    targetArtifactId: guard.targetArtifactId,
    fromRunId,
    toRunId: null,
    at: now,
    phase,
  }
}

function validateParams(artifact: BehaviorArtifact, params: Record<string, JsonValue>): Record<string, JsonValue> {  const result: Record<string, JsonValue> = { ...params }
  for (const [name, spec] of Object.entries(artifact.definition.parameters)) {
    if (!(name in result)) {
      if (spec.required === true && spec.default === undefined) {
        throw new Error(`missing required parameter: ${name}`)
      }
      if (spec.default !== undefined) result[name] = spec.default
      continue
    }
    const value = result[name]
    const type = spec.type
    const valid = type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : type === 'string' ? typeof value === 'string'
      : type === 'boolean' ? typeof value === 'boolean'
      : true
    if (!valid) throw new Error(`parameter ${name} must be a ${type}`)
  }
  return result
}

function isTerminal(status: RunStatus): status is 'succeeded' | 'failed' | 'cancelled' {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

export type { ArtifactRef }

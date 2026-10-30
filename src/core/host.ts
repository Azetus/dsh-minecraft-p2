import type { ArtifactRef, BehaviorArtifact, ContentArtifact, StrategyArtifact } from '../contracts/ir.ts'
import type { LastRunSummary, ProviderRuntimeStatus, RescueParams, RescueResult } from '../contracts/protocol.ts'
import type {
  ActiveActHandleSummary,
  CleanupState,
  ControlHealth,
  CurrentStep,
  GuardCondition,
  GuardEvent,
  GuardEventPhase,
  GuardQuery,
  GuardState,
  GuardStatus,
  GuardSwitchSummary,
  SwitchState,
  WatchEdge,
  WatchEvent,
  WatchState,
  WatchStatus,
} from '../contracts/protocol.ts'
import type { JsonValue, P2Error, ValueMeta } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import { CheckerError, checkBehavior } from './checker.ts'
import type { CheckerCredential } from './checker.ts'
import { checkAct } from './act-checker.ts'
import { checkPolicy } from './policy-checker.ts'
import { checkOp } from './op-checker.ts'
import { checkBehaviorJs } from './js-checker.ts'
import { checkStrategyJs } from './strategy-checker.ts'
import type { AuthoredOpArtifact } from './op-artifact.ts'
import { requireOperation } from '../operation/index.ts'
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
import { ConditionEvaluator, policyCall } from './condition-evaluator.ts'
import type { ConditionOutcome, DeclaredQuery, PredicateCall, PredicateInput } from './condition-evaluator.ts'
import type { ActSource } from './act-port.ts'
import type { PolicySource } from './policy-port.ts'

export type CheckHostRequest = {
  sourcePath: string
  sourceRoot?: string
  timeoutMs?: number
  artifactKind?: 'behavior' | 'act' | 'policy' | 'op' | 'strategy'
  /** Experimental behavior script format; default is IR. */
  format?: 'ir' | 'js'
}

export type CheckHostResult = {
  artifactId: string
  definitionId: string
  sourceDigest: string
  kind: 'behavior' | 'act' | 'policy' | 'op' | 'strategy'
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
  activeActHandle: ActiveActHandleSummary | null
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
  guards: GuardStatus[]
  lastSwitch: GuardSwitchSummary | null
  guardEvents: GuardEvent[]
  guardEventSeq: number
  watches: WatchStatus[]
  watchEvents: WatchEvent[]
  watchEventSeq: number
}

export type WatchAddInput = {
  queries: GuardQuery[]
  predicate: string
  edge?: WatchEdge
  cooldownMs?: number
  ttlMs?: number
  name?: string
  priority?: number
}

export type GuardSetInput = {
  guardId?: string
  priority?: number
  condition: GuardCondition
  targetArtifactId: string
  params: Record<string, JsonValue>
  ttlMs: number
}

/** One armed guard authorization; the target snapshot is fixed at set time. */
type ActiveGuard = {
  id: string
  priority: number
  condition: GuardCondition
  targetArtifactId: string
  params: Record<string, JsonValue>
  armedAt: number
  expiresAt: number
  state: GuardState
  attemptId?: string
  lastError?: P2Error
  failures: number
  nextEvalAt: number
  evaluator: ConditionEvaluator | undefined
  /** A completed evaluation that wants to fire; resolved by priority dispatch. */
  candidate: { evidence: JsonValue } | undefined
  /** Attempt id already reported as deferred, to avoid repeating the event. */
  deferredAttempt: string | undefined
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

/** One observation-only watch registration. It has no control capability. */
type ActiveWatch = {
  id: string
  name: string | null
  priority: number
  queries: DeclaredQuery[]
  predicate: string
  edge: WatchEdge
  cooldownMs: number
  armedAt: number
  expiresAt: number
  state: WatchState
  lastFire: number | undefined
  lastKey: string | undefined
  lastValue: boolean | undefined
  suppressed: number
  dropped: number
  failures: number
  nextEvalAt: number
  evaluator: ConditionEvaluator | undefined
  lastError?: P2Error
}

const GUARD_EVAL_INTERVAL_MS = 250
const GUARD_QUERY_TIMEOUT_MS = 1000
const GUARD_ERROR_LIMIT = 3
const GUARD_EVENT_LIMIT = 64
const GUARD_LIMIT = 8
const GUARD_MAX_QUERIES = 4
const GUARD_SAMPLING_LIMIT = 2
const GUARD_MAX_PRIORITY = 1000

const WATCH_EVAL_INTERVAL_MS = 500
const WATCH_SAMPLING_LIMIT = 4
const WATCH_ERROR_LIMIT = 3
const WATCH_EVENT_LIMIT = 64
const WATCH_LIMIT = 16
const WATCH_MAX_QUERIES = 4
const WATCH_RATE_LIMIT = 60
const WATCH_RATE_WINDOW_MS = 60_000
const WATCH_COOLDOWN_MIN_MS = 1000
const WATCH_COOLDOWN_DEFAULT_MS = 5000
const WATCH_TTL_DEFAULT_MS = 3_600_000
const WATCH_SUMMARY_MAX = 256
const WATCH_KEY_MAX = 128

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
  private guards: ActiveGuard[] = []
  private guardSequence = 0
  private attemptSequence = 0
  private lastSwitch: GuardSwitchSummary | null = null
  private readonly guardEvents: GuardEvent[] = []
  private guardEventSeq = 0
  private watches: ActiveWatch[] = []
  private watchSequence = 0
  private watchEventSeq = 0
  private readonly watchEvents: WatchEvent[] = []
  private watchNotifications: number[] = []

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
    if (kind === 'strategy') return this.checkStrategy(request)
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

  private async checkPolicy(request: CheckHostRequest): Promise<CheckHostResult> {    if (this.loadManifest === undefined) {
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

  private async checkStrategy(request: CheckHostRequest): Promise<CheckHostResult> {
    const result = await checkStrategyJs({
      sourcePath: request.sourcePath,
      ...(request.sourceRoot === undefined ? {} : { sourceRoot: request.sourceRoot }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      bindingId: this.bindingId,
      resolveAct: definitionId => {
        const artifact = this.registry.resolveDefault('act', definitionId)
        return artifact === undefined
          ? undefined
          : { artifactId: artifact.artifactId, digest: artifact.artifactDigest }
      },
    })
    this.credentials.set(result.artifact.artifactId, result.credential)
    this.registry.add(result.artifact, result.credential)
    return {
      artifactId: result.artifact.artifactId,
      definitionId: result.artifact.definitionId,
      sourceDigest: result.artifact.sourceDigest,
      kind: 'strategy',
      artifact: result.artifact,
    }
  }

  setOwner(owner: string): void {
    this.owner = owner
  }

  async rescueRun(request: RescueParams): Promise<RescueResult> {
    // Self-heal effects do not touch control, so they stay available while a run
    // is active (a creeper chase cannot afford "stop the behavior first").
    // Positional rescue still conflicts with the run's control path.
    if (request.action !== 'effect' && this.run !== undefined && !isTerminal(this.run.status)) {
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

  activate(artifactId: string): { artifactId: string; bindingId: string; enabled: true; kind: 'behavior' | 'act' | 'policy' | 'op' | 'strategy' } {
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

  /** Enabled strategy artifact, or undefined when it is not activated. */
  strategySource(artifactId: string): StrategyArtifact | undefined {
    const record = this.registry.get(artifactId)
    if (record === undefined || record.artifact.kind !== 'strategy' || !record.enabled || record.retired) return undefined
    return record.artifact
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
      ...(artifact.limits === undefined ? {} : { limits: artifact.limits }),
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
      const guard = this.findGuard(pending.guardId)
      if (guard === undefined || guard.attemptId !== pending.attemptId) {
        this.emitGuard('suppressed', {
          guardId: pending.guardId ?? 'unknown',
          attemptId: pending.attemptId,
          message: 'guard attempt was invalidated before activation',
        })
        this.rearmGuards(now)
        return
      }
      if (now >= guard.expiresAt) {
        guard.state = 'expired'
        this.lastSwitch = guardSwitchOf(guard, pending.attemptId, 'failed', 'guard expired before target start', now, pending.fromRunId ?? null)
        this.emitGuard('expired', { guardId: guard.id, attemptId: guard.attemptId, at: now })
        this.rearmGuards(now)
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
    this.evaluateGuards(now)
    this.evaluateWatches(now)
    return status
  }

  private checkGuardPending(now: number): void {
    const pending = this.pendingSwitch
    if (pending?.source !== 'guard') return
    const guard = this.findGuard(pending.guardId)
    if (guard === undefined || guard.attemptId !== pending.attemptId) {
      this.pendingSwitch = undefined
      this.emitGuard('suppressed', {
        guardId: pending.guardId ?? 'unknown',
        attemptId: pending.attemptId,
        message: 'guard attempt was invalidated',
      })
      this.rearmGuards(now)
      return
    }
    if (now >= guard.expiresAt) {
      this.pendingSwitch = undefined
      guard.state = 'expired'
      this.lastSwitch = guardSwitchOf(guard, guard.attemptId, 'failed', 'guard expired before target start', now, pending.fromRunId ?? null)
      this.emitGuard('expired', { guardId: guard.id, attemptId: guard.attemptId, at: now })
      this.rearmGuards(now)
      return
    }
    if (this.run !== undefined && !isTerminal(this.run.status) && this.run.stopState === 'stop-unconfirmed') {
      this.pendingSwitch = undefined
      const error = p2Error('STOP_UNCONFIRMED', 'timeout', 'old run control release was not confirmed', { module: 'core.host' })
      this.failGuardTarget(guard, now, 'old run stop was not confirmed', error, pending.fromRunId ?? null)
    }
  }

  /** One dispatch per pass; lower-priority matches are recorded as deferred. */
  private evaluateGuards(now: number): void {
    for (const guard of [...this.guards]) {
      if (!this.isEvaluable(guard)) continue
      this.evaluateGuard(guard, now)
    }
    this.dispatchGuardCandidates(now)
  }

  private dispatchGuardCandidates(now: number): void {
    const candidates = this.guards
      .map((guard, index) => ({ guard, index }))
      .filter(entry => this.isEvaluable(entry.guard) && entry.guard.candidate !== undefined)
      .sort((left, right) => right.guard.priority - left.guard.priority || left.index - right.index)
    if (candidates.length === 0) return
    const selected = candidates[0] as { guard: ActiveGuard; index: number }
    const fromRunId = this.activeRunId()
    if (this.pendingSwitch !== undefined) {
      const attemptId = this.pendingSwitch.attemptId
      for (const { guard } of candidates) {
        const evidence = guard.candidate?.evidence
        this.deferGuard(guard, now)
        if (attemptId !== undefined && guard.deferredAttempt === attemptId) continue
        guard.deferredAttempt = attemptId
        this.emitGuard('deferred', {
          guardId: guard.id,
          ...(attemptId === undefined ? {} : { attemptId }),
          condition: guard.condition,
          ...(evidence === undefined ? {} : { evidence }),
          targetArtifactId: guard.targetArtifactId,
          fromRunId,
          message: `deferred behind ${this.pendingSwitch.guardId ?? 'a pending switch'}`,
          at: now,
        })
      }
      return
    }
    const deferred = candidates.slice(1)
    for (const { guard } of deferred) this.deferGuard(guard, now)
    const evidence = selected.guard.candidate?.evidence
    selected.guard.candidate = undefined
    if (evidence !== undefined) this.fireGuard(selected.guard, now, evidence)
    if (this.pendingSwitch !== undefined) return
    // The winner started immediately (body idle), so the losers are deferred
    // against that completed switch rather than an attempt id.
    for (const { guard } of deferred) {
      if (guard.deferredAttempt === selected.guard.id) continue
      guard.deferredAttempt = selected.guard.id
      this.emitGuard('deferred', {
        guardId: guard.id,
        condition: guard.condition,
        targetArtifactId: guard.targetArtifactId,
        fromRunId,
        message: `deferred behind ${selected.guard.id} by priority`,
        at: now,
      })
    }
  }

  private deferGuard(guard: ActiveGuard, now: number): void {
    guard.candidate = undefined
    guard.state = 'deferred'
    // Re-evaluate shortly after the in-flight switch concludes.
    guard.nextEvalAt = now + GUARD_EVAL_INTERVAL_MS
  }

  /** Let deferred guards re-check immediately after an attempt settles. */
  private rearmGuards(now: number): void {
    for (const guard of this.guards) {
      if (guard.state !== 'active' && guard.state !== 'deferred') continue
      if (guard.state === 'deferred') guard.state = 'active'
      guard.candidate = undefined
      guard.nextEvalAt = now
    }
  }

  private isEvaluable(guard: ActiveGuard): boolean {
    return guard.state === 'active' || guard.state === 'deferred'
  }

  private evaluateGuard(guard: ActiveGuard, now: number): void {
    if (!this.isEvaluable(guard) || this.findGuard(guard.id) !== guard) return
    if (now >= guard.expiresAt) {
      guard.state = 'expired'
      guard.evaluator = undefined
      this.emitGuard('expired', { guardId: guard.id, at: now })
      return
    }
    if (guard.evaluator === undefined) {
      if (now < guard.nextEvalAt) return
      if (this.samplingInFlight() >= GUARD_SAMPLING_LIMIT) return
      guard.state = 'active'
      guard.nextEvalAt = now + GUARD_EVAL_INTERVAL_MS
      guard.evaluator = this.createGuardEvaluator(guard)
      guard.evaluator.start()
    }
    const outcome = guard.evaluator.advance(now)
    if (outcome === undefined) return
    guard.evaluator = undefined
    if (outcome.status === 'failed') {
      this.failGuardRound(guard, now, outcome.error)
      return
    }
    guard.failures = 0
    if (outcome.status === 'fire') {
      guard.candidate = {
        evidence: {
          samples: outcome.samples,
          sampledAt: outcome.sampledAt,
          ...(outcome.evidence === undefined ? {} : { policy: outcome.evidence }),
        },
      }
    }
  }

  private samplingInFlight(): number {
    let count = 0
    for (const guard of this.guards) if (guard.evaluator !== undefined) count += 1
    return count
  }

  private guardQueries(guard: ActiveGuard): DeclaredQuery[] {
    if (guard.condition.kind === 'health') return [{ op: 'health' }]
    return guard.condition.queries.map(query => ({
      op: query.op,
      ...(query.args === undefined ? {} : { args: query.args as Record<string, JsonValue> }),
    }))
  }

  private createGuardEvaluator(guard: ActiveGuard): ConditionEvaluator {
    return new ConditionEvaluator({
      queries: this.guardQueries(guard),
      query: this.query,
      queryTimeoutMs: GUARD_QUERY_TIMEOUT_MS,
      predicateTimeoutMs: GUARD_QUERY_TIMEOUT_MS,
      evaluate: input => this.evaluateGuardPredicate(guard, input),
    })
  }

  private evaluateGuardPredicate(guard: ActiveGuard, input: PredicateInput): PredicateCall {
    if (guard.condition.kind === 'health') {
      const sample = input.samples['0']
      const value = typeof sample === 'object' && sample !== null && !Array.isArray(sample)
        ? (sample as { value?: JsonValue }).value
        : undefined
      const health = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as { health?: unknown }).health
        : undefined
      if (typeof health !== 'number' || !Number.isFinite(health) || health <= 0) {
        return {
          status: 'failed',
          error: p2Error('GUARD_HEALTH_UNKNOWN', 'runtime', `guard ${guard.id} health is unavailable`, { module: 'core.host' }),
        }
      }
      return { status: 'ok', value: health <= guard.condition.hpBelow }
    }
    const record = this.registry.get(guard.condition.predicate)
    if (record === undefined || record.artifact.kind !== 'policy') {
      return {
        status: 'failed',
        error: p2Error('GUARD_PREDICATE_NOT_FOUND', 'validation', `guard ${guard.id} predicate policy is not registered`, { module: 'core.host' }),
      }
    }
    try {
      return policyCall(this.policy.call(
        { definitionId: record.artifact.definitionId, artifactId: record.artifact.artifactId },
        { samples: input.samples, now: input.now },
      ))
    } catch (error) {
      return {
        status: 'failed',
        error: p2Error('GUARD_POLICY_FAILED', 'runtime', error instanceof Error ? error.message : String(error), { module: 'core.host' }),
      }
    }
  }

  private failGuardRound(guard: ActiveGuard, now: number, error: P2Error): void {
    guard.evaluator = undefined
    if (!this.isEvaluable(guard) || this.findGuard(guard.id) !== guard) return
    guard.failures += 1
    guard.lastError = error
    this.emitGuard('error', {
      guardId: guard.id,
      error,
      message: `guard ${guard.id} evaluation failed (${guard.failures}/${GUARD_ERROR_LIMIT})`,
      at: now,
    })
    if (guard.failures >= GUARD_ERROR_LIMIT) {
      guard.state = 'error'
      this.emitGuard('error', { guardId: guard.id, error, message: `guard ${guard.id} disabled after repeated evaluation failures`, at: now })
    }
  }

  private activeRunId(): string | null {
    return this.run !== undefined && !isTerminal(this.run.status) ? this.run.runId : null
  }

  private fireGuard(guard: ActiveGuard, now: number, evidence: JsonValue): void {
    if (!this.isEvaluable(guard) || this.findGuard(guard.id) !== guard) return
    if (this.pendingSwitch !== undefined) return
    const attemptId = `attempt-${++this.attemptSequence}`
    guard.state = 'firing'
    guard.attemptId = attemptId
    guard.evaluator = undefined
    guard.candidate = undefined
    guard.deferredAttempt = undefined
    const fromRunId = this.activeRunId()
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
      this.rearmGuards(now)
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
    if (this.findGuard(guard.id) !== guard || attemptId === undefined) return
    if (now >= guard.expiresAt) {
      guard.state = 'expired'
      this.lastSwitch = guardSwitchOf(guard, attemptId, 'failed', 'guard expired before target start', now, fromRunId)
      this.emitGuard('expired', { guardId: guard.id, attemptId, at: now })
      this.rearmGuards(now)
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
      this.rearmGuards(now)
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
    this.rearmGuards(now)
  }

  private suppressGuardPending(reason: string): void {
    const pending = this.pendingSwitch
    if (pending?.source !== 'guard') return
    const guard = this.findGuard(pending.guardId)
    if (guard !== undefined) {
      guard.state = 'fired'
      this.lastSwitch = guardSwitchOf(guard, pending.attemptId, 'suppressed', reason, Date.now(), pending.fromRunId ?? null)
      this.emitGuard('suppressed', {
        guardId: guard.id,
        attemptId: pending.attemptId,
        targetArtifactId: guard.targetArtifactId,
        message: reason,
      })
      this.rearmGuards(Date.now())
    }
  }

  private findGuard(id: string | undefined): ActiveGuard | undefined {
    if (id === undefined) return undefined
    return this.guards.find(guard => guard.id === id)
  }

  /** Validate a declared guard query against the binding's query catalog. */
  private requireGuardQuery(op: string): void {
    const authored = this.opContract(op)
    if (authored !== undefined) {
      if (authored.kind !== 'query') {
        throw p2Error('OP_KIND_MISMATCH', 'validation', `guard query ${op} is control, not query`, { module: 'core.host', opId: op })
      }
      return
    }
    requireOperation(op, 'query', 'core.host')
  }

  // ---- watch: observation-only notifications, no control capability ----

  addWatch(input: WatchAddInput, now = Date.now()): WatchStatus {
    const queries = validateWatchQueries(input.queries)
    for (const query of queries) this.requireGuardQuery(query.op)
    const predicate = this.registry.get(input.predicate)
    if (predicate === undefined || predicate.artifact.kind !== 'policy') {
      throw p2Error('WATCH_PREDICATE_NOT_FOUND', 'validation', 'watch predicate must be a checked policy artifact', { module: 'core.host' })
    }
    const edge = input.edge ?? 'rising'
    if (edge !== 'rising' && edge !== 'falling' && edge !== 'both') {
      throw p2Error('WATCH_EDGE_INVALID', 'validation', 'watch edge must be rising, falling or both', { module: 'core.host' })
    }
    const cooldownMs = input.cooldownMs ?? WATCH_COOLDOWN_DEFAULT_MS
    if (!Number.isFinite(cooldownMs) || cooldownMs < WATCH_COOLDOWN_MIN_MS) {
      throw p2Error('WATCH_COOLDOWN_INVALID', 'validation', `watch cooldownMs must be at least ${WATCH_COOLDOWN_MIN_MS}`, { module: 'core.host' })
    }
    const ttlMs = input.ttlMs ?? WATCH_TTL_DEFAULT_MS
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw p2Error('WATCH_TTL_INVALID', 'validation', 'watch ttlMs must be a positive number', { module: 'core.host' })
    }
    const priority = input.priority ?? 0
    if (!Number.isInteger(priority) || Math.abs(priority) > GUARD_MAX_PRIORITY) {
      throw p2Error('WATCH_PRIORITY_INVALID', 'validation', `watch priority must be an integer within ±${GUARD_MAX_PRIORITY}`, { module: 'core.host' })
    }
    const name = input.name
    if (name !== undefined && (name.length === 0 || name.length > 64)) {
      throw p2Error('WATCH_NAME_INVALID', 'validation', 'watch name must be 1-64 characters', { module: 'core.host' })
    }
    if (this.watches.filter(watch => watch.state === 'active').length >= WATCH_LIMIT) {
      throw p2Error('WATCH_LIMIT', 'capability', `at most ${WATCH_LIMIT} active watches may exist`, { module: 'core.host' })
    }
    this.pruneWatchRecords()
    const watch: ActiveWatch = {
      id: `watch-${++this.watchSequence}`,
      name: name ?? null,
      priority,
      queries,
      predicate: input.predicate,
      edge,
      cooldownMs,
      armedAt: now,
      expiresAt: now + ttlMs,
      state: 'active',
      lastFire: undefined,
      lastKey: undefined,
      lastValue: undefined,
      suppressed: 0,
      dropped: 0,
      failures: 0,
      nextEvalAt: now,
      evaluator: undefined,
    }
    this.watches.push(watch)
    return watchStatusOf(watch)
  }

  removeWatch(watchId?: string): { removed: number; watches: WatchStatus[] } {
    const targets = watchId === undefined ? [...this.watches] : this.watches.filter(watch => watch.id === watchId)
    if (targets.length === 0) return { removed: 0, watches: [] }
    this.watches = this.watches.filter(watch => !targets.includes(watch))
    return { removed: targets.length, watches: targets.map(watchStatusOf) }
  }

  listWatches(): WatchStatus[] {
    return this.watches.map(watchStatusOf)
  }

  watchEventLog(): WatchEvent[] {
    return [...this.watchEvents]
  }

  watchHighWatermark(): number {
    return this.watchEventSeq
  }

  private pruneWatchRecords(): void {
    if (this.watches.length < WATCH_LIMIT * 4) return
    this.watches = this.watches.filter(watch => watch.state === 'active' || watch.state === 'expired')
  }

  private evaluateWatches(now: number): void {
    for (const watch of [...this.watches]) {
      if (watch.state !== 'active') continue
      this.evaluateWatch(watch, now)
    }
  }

  private watchSamplingInFlight(): number {
    let count = 0
    for (const watch of this.watches) if (watch.evaluator !== undefined) count += 1
    return count
  }

  private evaluateWatch(watch: ActiveWatch, now: number): void {
    if (now >= watch.expiresAt) {
      watch.state = 'expired'
      watch.evaluator = undefined
      return
    }
    if (watch.evaluator === undefined) {
      if (now < watch.nextEvalAt) return
      if (this.watchSamplingInFlight() >= WATCH_SAMPLING_LIMIT) return
      watch.nextEvalAt = now + WATCH_EVAL_INTERVAL_MS
      watch.evaluator = new ConditionEvaluator({
        queries: watch.queries,
        query: this.query,
        queryTimeoutMs: GUARD_QUERY_TIMEOUT_MS,
        predicateTimeoutMs: GUARD_QUERY_TIMEOUT_MS,
        evaluate: input => this.evaluateWatchPredicate(watch, input),
      })
      watch.evaluator.start()
    }
    const outcome = watch.evaluator.advance(now)
    if (outcome === undefined) return
    watch.evaluator = undefined
    if (outcome.status === 'failed') {
      watch.failures += 1
      watch.lastError = outcome.error
      if (watch.failures >= WATCH_ERROR_LIMIT) watch.state = 'error'
      return
    }
    watch.failures = 0
    this.considerWatchEdge(watch, outcome, now)
  }

  private evaluateWatchPredicate(watch: ActiveWatch, input: PredicateInput): PredicateCall {
    const record = this.registry.get(watch.predicate)
    if (record === undefined || record.artifact.kind !== 'policy') {
      return {
        status: 'failed',
        error: p2Error('WATCH_PREDICATE_NOT_FOUND', 'validation', `watch ${watch.id} predicate policy is not registered`, { module: 'core.host' }),
      }
    }
    try {
      return policyCall(this.policy.call(
        { definitionId: record.artifact.definitionId, artifactId: record.artifact.artifactId },
        { samples: input.samples, now: input.now },
      ))
    } catch (error) {
      return {
        status: 'failed',
        error: p2Error('WATCH_POLICY_FAILED', 'runtime', error instanceof Error ? error.message : String(error), { module: 'core.host' }),
      }
    }
  }

  private considerWatchEdge(
    watch: ActiveWatch,
    outcome: Extract<ConditionOutcome, { status: 'fire' | 'quiet' }>,
    now: number,
  ): void {
    const current = outcome.status === 'fire'
    const key = outcome.key?.slice(0, WATCH_KEY_MAX)
    const rising = current && watch.lastValue !== true
    const falling = !current && watch.lastValue === true
    const keyChanged = current && key !== undefined && key !== watch.lastKey && watch.edge !== 'falling'
    let hit = false
    if (watch.edge === 'rising') hit = rising
    else if (watch.edge === 'falling') hit = falling
    else hit = watch.lastValue === undefined ? current : current !== watch.lastValue
    if (keyChanged && current) hit = true
    watch.lastValue = current
    watch.lastKey = key
    if (!hit) return
    this.emitWatchEvent(watch, outcome, now)
  }

  private emitWatchEvent(
    watch: ActiveWatch,
    outcome: Extract<ConditionOutcome, { status: 'fire' | 'quiet' }>,
    now: number,
  ): void {
    if (watch.lastFire !== undefined && now - watch.lastFire < watch.cooldownMs) {
      watch.suppressed += 1
      return
    }
    this.watchNotifications = this.watchNotifications.filter(at => now - at < WATCH_RATE_WINDOW_MS)
    if (this.watchNotifications.length >= WATCH_RATE_LIMIT) {
      watch.dropped += 1
      return
    }
    this.watchNotifications.push(now)
    watch.lastFire = now
    this.watchEventSeq += 1
    const event: WatchEvent = {
      seq: this.watchEventSeq,
      watchId: watch.id,
      key: outcome.key ?? null,
      summary: outcome.summary === undefined ? null : outcome.summary.slice(0, WATCH_SUMMARY_MAX),
      evidence: { samples: outcome.samples, sampledAt: outcome.sampledAt },
      firedAt: now,
      dropped: watch.dropped,
    }
    this.watchEvents.push(event)
    while (this.watchEvents.length > WATCH_EVENT_LIMIT) this.watchEvents.shift()
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

  /** Arm one guard authorization; setting the same id replaces it atomically. */
  setGuard(input: GuardSetInput, now = Date.now()): GuardStatus {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs < 10_000 || input.ttlMs > 3_600_000) {
      throw p2Error('GUARD_TTL_INVALID', 'validation', 'guard ttlMs must be between 10000 and 3600000', { module: 'core.host' })
    }
    const priority = input.priority ?? 0
    if (!Number.isInteger(priority) || Math.abs(priority) > GUARD_MAX_PRIORITY) {
      throw p2Error('GUARD_PRIORITY_INVALID', 'validation', `guard priority must be an integer within ±${GUARD_MAX_PRIORITY}`, { module: 'core.host' })
    }
    const guardId = input.guardId
    if (guardId !== undefined && (guardId.length === 0 || guardId.length > 64)) {
      throw p2Error('GUARD_ID_INVALID', 'validation', 'guardId must be 1-64 characters', { module: 'core.host' })
    }
    const condition = validateGuardCondition(input.condition)
    if (condition.kind === 'policy') {
      const predicate = this.registry.get(condition.predicate)
      if (predicate === undefined || predicate.artifact.kind !== 'policy') {
        throw p2Error('GUARD_PREDICATE_NOT_FOUND', 'validation', 'guard predicate must be a checked policy artifact', { module: 'core.host' })
      }
      for (const query of condition.queries) this.requireGuardQuery(query.op)
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

    const existing = guardId === undefined ? undefined : this.findGuard(guardId)
    if (existing === undefined) {
      this.pruneSettledGuards()
      if (this.guards.length >= GUARD_LIMIT) {
        throw p2Error('GUARD_LIMIT', 'capability', `at most ${GUARD_LIMIT} guards may exist at once`, { module: 'core.host' })
      }
    }
    if (this.pendingSwitch?.source === 'guard' && (existing === undefined || this.pendingSwitch.guardId === existing.id)) {
      this.suppressGuardPending('replaced by a new guard')
      this.pendingSwitch = undefined
    }

    const guard: ActiveGuard = {
      id: existing?.id ?? guardId ?? `guard-${++this.guardSequence}`,
      priority,
      condition,
      targetArtifactId: input.targetArtifactId,
      params,
      armedAt: now,
      expiresAt: now + input.ttlMs,
      state: 'active',
      failures: 0,
      nextEvalAt: now,
      evaluator: undefined,
      candidate: undefined,
      deferredAttempt: undefined,
    }
    if (existing === undefined) this.guards.push(guard)
    else this.guards[this.guards.indexOf(existing)] = guard
    this.emitGuard('armed', {
      guardId: guard.id,
      condition: guard.condition,
      targetArtifactId: guard.targetArtifactId,
      at: now,
    })
    return guardStatusOf(guard)
  }

  /** Revoke one guard id, or every guard, without touching the current behavior. */
  clearGuard(guardId?: string, now = Date.now()): { cleared: number; guards: GuardStatus[] } {
    const targets = guardId === undefined
      ? [...this.guards]
      : this.guards.filter(guard => guard.id === guardId)
    if (targets.length === 0) return { cleared: 0, guards: [] }
    for (const guard of targets) {
      if (this.pendingSwitch?.source === 'guard' && this.pendingSwitch.guardId === guard.id) {
        this.suppressGuardPending('guard cleared')
        this.pendingSwitch = undefined
      }
      guard.evaluator = undefined
      this.guards = this.guards.filter(candidate => candidate !== guard)
      this.emitGuard('cleared', { guardId: guard.id, at: now })
    }
    return { cleared: targets.length, guards: targets.map(guardStatusOf) }
  }

  private pruneSettledGuards(): void {
    this.guards = this.guards.filter(guard => guard.state === 'active' || guard.state === 'firing' || guard.state === 'deferred')
  }

  guardStatus(): GuardStatus[] {
    return this.guards.map(guardStatusOf)
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
      activeActHandle: observation?.activeActHandle ?? null,
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
      lastSwitch: this.lastSwitch,
      guardEvents: [...this.guardEvents],
      guardEventSeq: this.guardEventSeq,
      guards: this.guardStatus(),
      watches: this.listWatches(),
      watchEvents: [...this.watchEvents],
      watchEventSeq: this.watchEventSeq,
    }
  }

  dispose(): void {
    this.pendingSwitch = undefined
    this.guards = []
    this.watches = []
    this.watchEvents.length = 0
    this.watchNotifications = []
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
      definitionId: run.definition.id,
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
    priority: guard.priority,
    state: guard.state,
    condition: guard.condition,
    target: { artifactId: guard.targetArtifactId, params: guard.params },
    armedAt: guard.armedAt,
    expiresAt: guard.expiresAt,
    ...(guard.attemptId === undefined ? {} : { attemptId: guard.attemptId }),
    ...(guard.lastError === undefined ? {} : { lastError: guard.lastError }),
  }
}

/** Validate the declared condition shape; policy artifact resolution is G2. */
function validateGuardCondition(condition: GuardCondition): GuardCondition {
  if (condition.kind === 'health') {
    if (!Number.isFinite(condition.hpBelow) || condition.hpBelow <= 0) {
      throw p2Error('GUARD_CONDITION_INVALID', 'validation', 'health hpBelow must be a positive number', { module: 'core.host' })
    }
    return { kind: 'health', hpBelow: condition.hpBelow }
  }
  if (condition.kind !== 'policy') {
    throw p2Error('GUARD_CONDITION_INVALID', 'validation', 'guard condition must be health or policy', { module: 'core.host' })
  }
  if (typeof condition.predicate !== 'string' || condition.predicate.length === 0) {
    throw p2Error('GUARD_CONDITION_INVALID', 'validation', 'policy guard requires a predicate artifactId', { module: 'core.host' })
  }
  if (!Array.isArray(condition.queries) || condition.queries.length === 0) {
    throw p2Error('GUARD_CONDITION_INVALID', 'validation', 'policy guard requires at least one query', { module: 'core.host' })
  }
  if (condition.queries.length > GUARD_MAX_QUERIES) {
    throw p2Error('GUARD_CONDITION_INVALID', 'validation', `policy guard allows at most ${GUARD_MAX_QUERIES} queries`, { module: 'core.host' })
  }
  const queries = condition.queries.map(query => {
    if (typeof query !== 'object' || query === null || typeof query.op !== 'string' || query.op.length === 0) {
      throw p2Error('GUARD_CONDITION_INVALID', 'validation', 'each guard query requires an op name', { module: 'core.host' })
    }
    if (query.args !== undefined && (typeof query.args !== 'object' || query.args === null || Array.isArray(query.args))) {
      throw p2Error('GUARD_CONDITION_INVALID', 'validation', 'guard query args must be an object', { module: 'core.host' })
    }
    return {
      op: query.op,
      ...(query.args === undefined ? {} : { args: query.args }),
    }
  })
  return { kind: 'policy', queries, predicate: condition.predicate }
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

function watchStatusOf(watch: ActiveWatch): WatchStatus {
  return {
    id: watch.id,
    name: watch.name,
    priority: watch.priority,
    state: watch.state,
    queries: watch.queries.map(query => ({
      op: query.op,
      ...(query.args === undefined ? {} : { args: query.args }),
    })),
    predicate: watch.predicate,
    edge: watch.edge,
    cooldownMs: watch.cooldownMs,
    armedAt: watch.armedAt,
    expiresAt: watch.expiresAt,
    lastFire: watch.lastFire ?? null,
    lastKey: watch.lastKey ?? null,
    suppressed: watch.suppressed,
    dropped: watch.dropped,
    ...(watch.lastError === undefined ? {} : { lastError: watch.lastError }),
  }
}

function validateWatchQueries(queries: GuardQuery[]): DeclaredQuery[] {
  if (!Array.isArray(queries) || queries.length === 0) {
    throw p2Error('WATCH_CONDITION_INVALID', 'validation', 'watch requires at least one query', { module: 'core.host' })
  }
  if (queries.length > WATCH_MAX_QUERIES) {
    throw p2Error('WATCH_CONDITION_INVALID', 'validation', `watch allows at most ${WATCH_MAX_QUERIES} queries`, { module: 'core.host' })
  }
  return queries.map(query => {
    if (typeof query !== 'object' || query === null || typeof query.op !== 'string' || query.op.length === 0) {
      throw p2Error('WATCH_CONDITION_INVALID', 'validation', 'each watch query requires an op name', { module: 'core.host' })
    }
    if (query.args !== undefined && (typeof query.args !== 'object' || query.args === null || Array.isArray(query.args))) {
      throw p2Error('WATCH_CONDITION_INVALID', 'validation', 'watch query args must be an object', { module: 'core.host' })
    }
    return {
      op: query.op,
      ...(query.args === undefined ? {} : { args: query.args as Record<string, JsonValue> }),
    }
  })
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


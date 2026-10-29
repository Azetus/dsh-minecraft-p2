import type { ArtifactRef, BehaviorArtifact, ContentArtifact } from '../contracts/ir.ts'
import type { LastRunSummary, ProviderRuntimeStatus, RescueParams, RescueResult } from '../contracts/protocol.ts'
import type { CleanupState, ControlHealth, CurrentStep, SwitchState } from '../contracts/protocol.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import { CheckerError, checkBehavior } from './checker.ts'
import type { CheckerCredential } from './checker.ts'
import { checkAct } from './act-checker.ts'
import { checkPolicy } from './policy-checker.ts'
import { checkBehaviorJs } from './js-checker.ts'
import { CommandLedger } from './logging.ts'
import { BehaviorRun } from './run.ts'
import { JsBehaviorRun } from './js-runtime.ts'
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
  artifactKind?: 'behavior' | 'act' | 'policy'
  /** Experimental behavior script format; default is IR. */
  format?: 'ir' | 'js'
}

export type CheckHostResult = {
  artifactId: string
  definitionId: string
  sourceDigest: string
  kind: 'behavior' | 'act' | 'policy'
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
}

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
  /** Experiment-only rescue channel; behavior/act cannot reach it. */
  rescue?: (request: RescueParams, context: { owner: string }) => Promise<RescueResult>
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
  private readonly rescue: BehaviorHostOptions['rescue']
  private owner: string
  private readonly newRunId: () => string
  private run: BehaviorRun | JsBehaviorRun | undefined
  private runArtifact: string | undefined
  private pendingSwitch: { artifactId: string; params: Record<string, JsonValue>; commandId: string } | undefined
  private lastRun: LastRunSummary | null = null
  private sequence = 0

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
    this.rescue = options.rescue
    this.owner = options.owner ?? 'host'
    this.newRunId = options.newRunId ?? (() => `run-${++this.sequence}`)
  }

  async check(request: CheckHostRequest): Promise<CheckHostResult> {
    const kind = request.artifactKind ?? 'behavior'
    if (kind === 'act') return this.checkAct(request)
    if (kind === 'policy') return this.checkPolicy(request)
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
    const result = await checkBehaviorJs({
      sourcePath: request.sourcePath,
      ...(request.sourceRoot === undefined ? {} : { sourceRoot: request.sourceRoot }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      bindingId: this.bindingId,
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

  activate(artifactId: string): { artifactId: string; bindingId: string; enabled: true; kind: 'behavior' | 'act' | 'policy' } {
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
        this.pendingSwitch = { artifactId: input.artifactId, params, commandId: input.commandId }
        const result: SwitchResult = { accepted: true, runId: this.run.runId, status: 'stopping' }
        this.ledger.record(input.commandId, result)
        return result
      }
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
    if (artifact.format === 'js') {
      this.run = new JsBehaviorRun({
        runId,
        owner: this.owner,
        artifact,
        params,
        query: this.query,
        act: this.act,
        policy: this.policy,
        resolveAct: definitionId => this.registry.resolveDefault('act', definitionId)?.artifactId,
        resolvePolicy: definitionId => this.registry.find('policy', definitionId)?.artifactId,
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

  private activatePending(): void {
    const pending = this.pendingSwitch
    if (pending === undefined) return
    if (this.run !== undefined && !isTerminal(this.run.status)) return
    this.pendingSwitch = undefined
    const record = this.registry.get(pending.artifactId)
    // A candidate that retired while the old run was stopping must not take over.
    if (record === undefined || record.retired || !record.enabled || record.artifact.kind !== 'behavior') return
    this.startRun(record, pending.params)
  }

  tick(now = Date.now()): RunStatus | undefined {
    const status = this.run?.tick(now)
    if (this.run !== undefined && isTerminal(this.run.status)) this.rememberLastRun()
    this.activatePending()
    return status
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
  }
}

function validateParams(artifact: BehaviorArtifact, params: Record<string, JsonValue>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = { ...params }
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

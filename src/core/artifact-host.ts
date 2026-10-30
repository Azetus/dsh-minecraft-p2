import type { ContentArtifact, StrategyArtifact } from '../contracts/artifacts.ts'
import type { ProviderRuntimeStatus, RescueParams, RescueResult, WatchEdge, WatchEvent, WatchQuery, WatchState, WatchStatus } from '../contracts/protocol.ts'
import { p2Error } from '../contracts/protocol.ts'
import type { JsonValue, P2Error, ValueMeta } from '../contracts/types.ts'
import { checkAct } from './act-checker.ts'
import { checkOp } from './op-checker.ts'
import { checkPolicy } from './policy-checker.ts'
import { checkStrategyJs } from './strategy-checker.ts'
import { CheckerError } from './checker-errors.ts'
import type { CheckerCredential } from './checker-errors.ts'
import type { AuthoredOpArtifact } from './op-artifact.ts'
import { requireOperation } from '../operation/index.ts'
import type { OperationContract } from '../operation/index.ts'
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
  artifactKind?: 'act' | 'policy' | 'op' | 'strategy'
}

export type CheckHostResult = {
  artifactId: string
  definitionId: string
  sourceDigest: string
  kind: 'act' | 'policy' | 'op' | 'strategy'
  artifact: ContentArtifact
}

export type HostStatus = {
  bindingId: string
  watches: WatchStatus[]
  watchEvents: WatchEvent[]
  watchEventSeq: number
  providerState: ProviderRuntimeStatus | null
}

export type WatchAddInput = {
  queries: WatchQuery[]
  predicate: string
  edge?: WatchEdge
  cooldownMs?: number
  ttlMs?: number
  name?: string
  priority?: number
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

const WATCH_EVAL_INTERVAL_MS = 500
const WATCH_SAMPLING_LIMIT = 4
const WATCH_ERROR_LIMIT = 3
const WATCH_EVENT_LIMIT = 64
const WATCH_LIMIT = 16
const WATCH_MAX_QUERIES = 4
const WATCH_QUERY_TIMEOUT_MS = 1000
const WATCH_RATE_LIMIT = 60
const WATCH_RATE_WINDOW_MS = 60_000
const WATCH_COOLDOWN_MIN_MS = 1000
const WATCH_COOLDOWN_DEFAULT_MS = 5000
const WATCH_TTL_DEFAULT_MS = 3_600_000
const WATCH_SUMMARY_MAX = 256
const WATCH_KEY_MAX = 128
const WATCH_MAX_PRIORITY = 1000

export type ArtifactHostOptions = {
  bindingId: string
  query: QueryPort
  act: ActPort
  policy?: PolicyPort
  providerStatus?: () => ProviderRuntimeStatus
  /** Load act/policy code in a sandbox to extract its manifest. */
  loadManifest?: (kind: 'act' | 'policy', code: string, artifactId: string) => Promise<JsonValue>
  /** Experiment-only rescue channel; content cannot reach it. */
  rescue?: (request: RescueParams, context: { owner: string }) => Promise<RescueResult>
  /** True while a positional rescue would conflict with controller control. */
  rescueBusy?: () => boolean
}

/**
 * Artifact registry and observation host for the Controller-only body.
 *
 * It checks and enables act/policy/op/strategy artifacts, evaluates watch
 * predicates and serves observation queries. It has no run, switch, guard or
 * confirmation state: autonomous action belongs to P2Controller.
 */
export class ArtifactHost {
  private readonly registry: ArtifactRegistry
  private readonly bindingId: string
  private readonly credentials = new Map<string, CheckerCredential>()
  private readonly query: QueryPort
  private readonly policy: PolicyPort
  private readonly providerStatus: (() => ProviderRuntimeStatus) | undefined
  private readonly loadManifest: ArtifactHostOptions['loadManifest']
  private readonly rescue: ArtifactHostOptions['rescue']
  private readonly rescueBusy: ArtifactHostOptions['rescueBusy']
  private owner: string
  private watches: ActiveWatch[] = []
  private watchSequence = 0
  private watchEventSeq = 0
  private readonly watchEvents: WatchEvent[] = []
  private watchNotifications: number[] = []

  constructor(options: ArtifactHostOptions) {
    this.bindingId = options.bindingId
    this.registry = new ArtifactRegistry({ bindingId: options.bindingId })
    this.query = options.query
    this.policy = options.policy ?? (() => ({
      status: 'failed',
      error: p2Error('POLICY_UNAVAILABLE', 'capability', 'no policy runner is configured', { module: 'core.host' }),
    }))
    this.providerStatus = options.providerStatus
    this.loadManifest = options.loadManifest
    this.rescue = options.rescue
    this.rescueBusy = options.rescueBusy
    this.owner = 'host'
  }

  async check(request: CheckHostRequest): Promise<CheckHostResult> {
    const kind = request.artifactKind ?? 'act'
    if (kind === 'act') return this.checkAct(request)
    if (kind === 'policy') return this.checkPolicy(request)
    if (kind === 'op') return this.checkOp(request)
    return this.checkStrategy(request)
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
    if (request.action !== 'effect' && request.force !== true && this.rescueBusy !== undefined && this.rescueBusy()) {
      throw p2Error('RESCUE_BUSY', 'runtime', 'stop the active controller action before using positional rescue', { module: 'core.host' })
    }
    if (this.rescue === undefined) {
      throw p2Error('RESCUE_UNAVAILABLE', 'capability', 'rescue is not configured for this body', { module: 'core.host' })
    }
    return this.rescue(request, { owner: this.owner })
  }

  observe(op: string, args: Record<string, JsonValue> = {}): QueryOutcome {
    return this.query({ op, args: {} }, args)
  }

  activate(artifactId: string): { artifactId: string; bindingId: string; enabled: true; kind: 'act' | 'policy' | 'op' | 'strategy' } {
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

  retire(artifactId: string): void {
    this.registry.retire(artifactId)
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

  // ---- watch: observation-only notifications, no control capability ----

  addWatch(input: WatchAddInput, now = Date.now()): WatchStatus {
    const queries = validateWatchQueries(input.queries)
    for (const query of queries) this.requireQuery(query.op)
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
    if (!Number.isInteger(priority) || Math.abs(priority) > WATCH_MAX_PRIORITY) {
      throw p2Error('WATCH_PRIORITY_INVALID', 'validation', `watch priority must be an integer within ±${WATCH_MAX_PRIORITY}`, { module: 'core.host' })
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

  /** Advance watch sampling. Called on every body tick, regardless of mode. */
  tick(now = Date.now()): void {
    this.evaluateWatches(now)
  }

  status(now = Date.now()): HostStatus {
    return {
      bindingId: this.bindingId,
      watches: this.listWatches(),
      watchEvents: this.watchEventLog(),
      watchEventSeq: this.watchHighWatermark(),
      providerState: this.providerStatus === undefined ? null : this.providerStatus(),
    }
  }

  private requireQuery(op: string): void {
    const authored = this.opContract(op)
    if (authored !== undefined) {
      if (authored.kind !== 'query') {
        throw p2Error('OP_KIND_MISMATCH', 'validation', `watch query ${op} is control, not query`, { module: 'core.host', opId: op })
      }
      return
    }
    requireOperation(op, 'query', 'core.host')
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
        queryTimeoutMs: WATCH_QUERY_TIMEOUT_MS,
        predicateTimeoutMs: WATCH_QUERY_TIMEOUT_MS,
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

  /** The runner exited: abandon pending watch samples but keep registrations. */
  runnerExited(_message: string): void {
    for (const watch of this.watches) watch.evaluator = undefined
  }

  dispose(): void {
    this.watches = []
    this.watchEvents.length = 0
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

function validateWatchQueries(queries: WatchQuery[]): DeclaredQuery[] {
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







import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { BehaviorHost } from '../core/host.ts'
import { CheckerError } from '../core/checker.ts'
import { RegistryError } from '../core/registry.ts'
import type { DebugLog } from '../core/logging.ts'
import type { WorkQuota } from '../core/quota.ts'
import type { TraceSink } from '../core/trace.ts'

import {
  PROTOCOL_VERSION,
  invalidMessageError,
  isOwnerContext,
  isRecord,
  p2Error,
  unknownMethodError,
  unsupportedProtocolError,
} from '../contracts/protocol.ts'
import type {
  BodyInfo,
  BodyRuntimeOptions,
  CheckParams,
  CheckResult,
  CommandRecord,
  ConfirmParams,
  ConfirmationResult,
  DescribeResult,
  DevOpsStatus,
  HeartbeatParams,
  HelloParams,
  HelloResult,
  OwnerContext,
  ProviderRuntimeStatus,
  RequestEnvelope,
  ResponseEnvelope,
  ShutdownResult,
  StatusResult,
  StopParams,
  StopResult,
  SwitchParams,
  SwitchResult,
  ActivateParams,
  ActivateResult,
  TraceParams,
  TraceResult,
  GuardCondition,
  GuardQuery,
  SnapshotOp,
  SnapshotPart,
  SnapshotResult,
} from '../contracts/protocol.ts'
import { ErrorCodes } from '../contracts/types.ts'
import type { BodyEpoch, CommandId, JsonValue, P2Error, RunId } from '../contracts/types.ts'

export class BodyRuntime {
  readonly body: BodyInfo
  readonly bodyEpoch: BodyEpoch
  private behavior: BehaviorHost | undefined
  private readonly debugLog: DebugLog | undefined
  private readonly workQuota: WorkQuota | undefined
  private lastBehaviorStatus: string | undefined
  private owner: OwnerContext | null = null
  private initialized = false
  private closing = false
  private readonly commands = new Map<string, CommandRecord>()
  private readonly now: () => number
  private readonly heartbeatTimeoutMs: number | undefined
  private lastHeartbeatSeq = -1
  private lastHeartbeatAt = 0
  private readonly rescueState: { enabled: boolean; tpRadius: number } | undefined
  private readonly devOpsState: (() => DevOpsStatus | null) | undefined
  private readonly trace: TraceSink | undefined

  constructor(options: BodyRuntimeOptions & { behavior?: BehaviorHost; debugLog?: DebugLog; workQuota?: WorkQuota; trace?: TraceSink }) {
    this.body = options.body
    this.bodyEpoch = (options.newEpoch?.() ?? randomUUID()) as BodyEpoch
    this.behavior = options.behavior
    this.debugLog = options.debugLog
    this.workQuota = options.workQuota
    this.owner = options.owner ?? null
    this.initialized = this.owner !== null
    this.now = options.now ?? Date.now
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs
    this.rescueState = options.rescue
    this.devOpsState = options.devOps
    this.trace = options.trace
    if (this.owner !== null) this.lastHeartbeatAt = this.now()
  }

  get isClosing(): boolean {
    return this.closing
  }

  get currentOwner(): OwnerContext | null {
    return this.owner
  }

  get leaseTimeoutMs(): number | undefined {
    return this.heartbeatTimeoutMs
  }

  /** Advance the lease check; returns false when the owner lease expired. */
  checkHeartbeat(now = this.now()): boolean {
    if (this.closing || this.owner === null || this.heartbeatTimeoutMs === undefined) return true
    if (now - this.lastHeartbeatAt > this.heartbeatTimeoutMs) {
      this.closing = true
      return false
    }
    return true
  }

  handleRequest(envelope: RequestEnvelope): ResponseEnvelope {
    const base = {
      protocol: PROTOCOL_VERSION as 1,
      requestId: envelope.requestId,
      bodyEpoch: this.bodyEpoch,
    }

    if (envelope.method !== 'hello') {
      if (this.closing) return { ...base, error: this.shuttingDown() }
      if (!this.initialized) return { ...base, error: this.notInitialized() }
      if (envelope.bodyEpoch !== this.bodyEpoch) {
        return { ...base, error: this.staleEpoch(envelope.bodyEpoch) }
      }
    }

    switch (envelope.method) {
      case 'hello':
        return this.handleHello(base, envelope)
      case 'heartbeat':
        return this.handleHeartbeat(base, envelope)
      case 'describe':
        return { ...base, result: this.describe() }
      case 'status':
        return { ...base, result: this.status() }
      case 'trace':
        return { ...base, result: this.traceResult(envelope.params) as unknown as JsonValue }
      case 'watch.list':
        return {
          ...base,
          result: { watches: this.behavior?.listWatches() ?? [] } as unknown as JsonValue,
        }
      case 'stop':
        return this.handleStop(base, envelope)
      case 'shutdown':
        return this.handleShutdown(base, envelope)
      case 'command.get':
        return this.handleCommandGet(base, envelope)
      default:
        return { ...base, error: unknownMethodError(envelope.method) }
    }
  }

  async handleRequestAsync(envelope: RequestEnvelope): Promise<ResponseEnvelope> {
    if (envelope.method !== 'check'
      && envelope.method !== 'activate'
      && envelope.method !== 'switch'
      && envelope.method !== 'confirm'
      && envelope.method !== 'behavior.stop'
      && envelope.method !== 'guard.set'
      && envelope.method !== 'guard.clear'
      && envelope.method !== 'watch.add'
      && envelope.method !== 'watch.remove'
      && envelope.method !== 'observe'
      && envelope.method !== 'snapshot'
      && envelope.method !== 'rescue') {
      return this.handleRequest(envelope)
    }

    const base = {
      protocol: PROTOCOL_VERSION as 1,
      requestId: envelope.requestId,
      bodyEpoch: this.bodyEpoch,
    }
    if (this.closing) return { ...base, error: this.shuttingDown() }
    if (!this.initialized) return { ...base, error: this.notInitialized() }
    if (envelope.bodyEpoch !== this.bodyEpoch) return { ...base, error: this.staleEpoch(envelope.bodyEpoch) }
    if (this.behavior === undefined) {
      return {
        ...base,
        error: p2Error('BEHAVIOR_UNAVAILABLE', 'runtime', 'body has no behavior host', { module: 'body.behavior' }),
      }
    }
    const params = asRecord(envelope.params)
    if (params === undefined) return { ...base, error: invalidMessageError('params must be an object') }

    if (envelope.method === 'observe') {
      const op = typeof params.op === 'string' ? params.op : undefined
      if (op === undefined) return { ...base, error: invalidMessageError('observe op is required') }
      const args = asRecord(params.args ?? {}) ?? {}
      const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
        ? Math.min(10_000, Math.max(0, params.timeoutMs))
        : 3000
      let observed = this.behavior.observe(op, args)
      const deadline = Date.now() + timeoutMs
      // Container/villager queries open a window asynchronously; poll the same
      // pending observation instead of failing the tool call outright.
      while (observed.status === 'pending' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
        observed = observed.poll()
      }
      if (observed.status === 'failed') return { ...base, error: observed.error }
      if (observed.status === 'pending') {
        return {
          ...base,
          error: p2Error('OBSERVE_TIMEOUT', 'timeout', `observation did not finish within ${timeoutMs}ms`, { module: 'body.behavior' }),
        }
      }
      return {
        ...base,
        result: {
          op,
          value: observed.value,
          ...(observed.meta === undefined ? {} : { meta: observed.meta }),
        } as unknown as JsonValue,
      }
    }

    if (envelope.method === 'snapshot') {
      const ops = parseSnapshotOps(params.ops)
      if (ops === undefined) {
        return { ...base, error: invalidMessageError('snapshot ops must be 1-8 { key, op, args? } entries') }
      }
      const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
        ? Math.min(5000, Math.max(0, params.timeoutMs))
        : 1000
      const outcomes = ops.map(entry => {
        try {
          return this.behavior?.observe(entry.op, asRecord(entry.args ?? {}) ?? {}) ?? {
            status: 'failed' as const,
            error: p2Error('BEHAVIOR_UNAVAILABLE', 'runtime', 'body has no behavior host', { module: 'body.behavior' }),
          }
        } catch (error) {
          return {
            status: 'failed' as const,
            error: p2Error('SNAPSHOT_PART_FAILED', 'runtime', error instanceof Error ? error.message : String(error), { module: 'body.snapshot', opId: entry.op }),
          }
        }
      })
      const deadline = Date.now() + timeoutMs
      while (outcomes.some(outcome => outcome.status === 'pending') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
        for (let index = 0; index < outcomes.length; index += 1) {
          const outcome = outcomes[index]
          if (outcome?.status === 'pending') outcomes[index] = outcome.poll()
        }
      }
      const parts: SnapshotPart[] = ops.map((entry, index) => {
        const outcome = outcomes[index]
        if (outcome === undefined) {
          return {
            key: entry.key,
            op: entry.op,
            status: 'failed',
            error: p2Error('SNAPSHOT_PART_FAILED', 'runtime', 'snapshot part is missing', { module: 'body.snapshot', opId: entry.op }),
          }
        }
        if (outcome.status === 'ok') {
          return {
            key: entry.key,
            op: entry.op,
            status: 'ok',
            value: outcome.value,
            ...(outcome.meta === undefined ? {} : { meta: outcome.meta }),
          }
        }
        if (outcome.status === 'failed') {
          return { key: entry.key, op: entry.op, status: 'failed', error: outcome.error }
        }
        return { key: entry.key, op: entry.op, status: 'pending' }
      })
      const result: SnapshotResult = {
        parts,
        partial: parts.some(part => part.status !== 'ok'),
        sampledAt: Date.now(),
      }
      return { ...base, result: result as unknown as JsonValue }
    }

    const commandId = this.requireCommandId(envelope)
    if (typeof commandId !== 'string') return { ...base, error: commandId.error }
    const existing = this.commands.get(commandId)
    if (existing !== undefined) {
      if (existing.method !== envelope.method) return { ...base, error: duplicateCommand(commandId) }
      if (existing.state === 'pending') {
        return { ...base, error: p2Error('COMMAND_PENDING', 'control', `command is still pending: ${commandId}`, { module: 'body.commands' }) }
      }
      return existing.error === undefined
        ? { ...base, result: existing.result as JsonValue }
        : { ...base, error: existing.error }
    }

    try {
      switch (envelope.method) {
        case 'check': {
          const sourcePath = typeof params.sourcePath === 'string' ? params.sourcePath : undefined
          if (sourcePath === undefined) return { ...base, error: invalidMessageError('sourcePath is required') }
          const owner = this.owner
          if (owner === null || !inside(owner.cwd, sourcePath)) {
            return {
              ...base,
              error: p2Error('SOURCE_OUTSIDE_PROJECT', 'validation', 'sourcePath must be inside the owner project', { module: 'body.behavior' }),
            }
          }
          this.commands.set(commandId, {
            commandId: commandId as CommandId,
            method: 'check',
            state: 'pending',
          })
          this.debugLog?.log({ event: 'command', commandId, method: 'check', state: 'pending' })
          if (this.workQuota !== undefined && !this.workQuota.tryAcquire()) {
            const quotaError = p2Error('QUOTA_EXCEEDED', 'control', 'normal work quota is full', { module: 'body.quota' })
            this.commands.set(commandId, {
              commandId: commandId as CommandId,
              method: 'check',
              state: 'rejected',
              error: quotaError,
            })
            return { ...base, error: quotaError }
          }
          const rawKind = params.artifactKind
          if (rawKind !== undefined && rawKind !== 'behavior' && rawKind !== 'act' && rawKind !== 'policy' && rawKind !== 'op') {
            return { ...base, error: invalidMessageError('artifactKind must be behavior, act, policy or op') }
          }
          const artifactKind = rawKind as 'behavior' | 'act' | 'policy' | 'op' | undefined
          const rawFormat = params.format
          if (rawFormat !== undefined && rawFormat !== 'ir' && rawFormat !== 'js') {
            return { ...base, error: invalidMessageError('format must be ir or js') }
          }
          const format = rawFormat as 'ir' | 'js' | undefined
          let checked
          try {
            checked = await this.behavior.check({
              sourcePath,
              ...(artifactKind === undefined ? {} : { artifactKind }),
              ...(typeof params.sourceRoot === 'string' ? { sourceRoot: params.sourceRoot } : {}),
              ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
              ...(format === undefined ? {} : { format }),
            })
          } finally {
            this.workQuota?.release()
          }
          const result: CheckResult = {
            artifactId: checked.artifactId,
            definitionId: checked.definitionId,
            sourceDigest: checked.sourceDigest,
            bindingId: checked.artifact.bindingId,
            kind: checked.kind,
            enabled: false,
          }
          this.recordCommand(commandId, 'check', result)
          return { ...base, result: result as unknown as JsonValue }
        }
        case 'activate': {
          const artifactId = typeof params.artifactId === 'string' ? params.artifactId : undefined
          if (artifactId === undefined) return { ...base, error: invalidMessageError('artifactId is required') }
          const activated = this.behavior.activate(artifactId)
          const result: ActivateResult = activated
          this.recordCommand(commandId, 'activate', result)
          return { ...base, result: result as unknown as JsonValue }
        }
        case 'rescue': {
          const rescued = await this.behavior.rescueRun(params as never)
          this.recordCommand(commandId, 'rescue', rescued)
          return { ...base, result: rescued as unknown as JsonValue }
        }
        case 'switch': {
          const artifactId = typeof params.artifactId === 'string' ? params.artifactId : undefined
          if (artifactId === undefined) return { ...base, error: invalidMessageError('artifactId is required') }
          const switchParams = asRecord(params.params ?? {}) ?? {}
          const switched = this.behavior.switch({
            artifactId,
            params: switchParams,
            commandId,
          })
          const result: SwitchResult = switched
          this.recordCommand(commandId, 'switch', result)
          return { ...base, result: result as unknown as JsonValue }
        }
        case 'confirm': {
          const runId = typeof params.runId === 'string' ? params.runId : undefined
          const confirmationId = typeof params.confirmationId === 'string' ? params.confirmationId : undefined
          const decision = params.decision === 'confirm' || params.decision === 'deny' ? params.decision : undefined
          const owner = this.owner
          if (runId === undefined || confirmationId === undefined || decision === undefined || owner === null) {
            return { ...base, error: invalidMessageError('runId, confirmationId, decision, and owner are required') }
          }
          const confirmed = this.behavior.confirm({
            runId,
            confirmationId,
            decision,
            owner: `${owner.sessionId}/${owner.agentId}`,
            source: 'agent',
            commandId,
          })
          const result: ConfirmationResult = confirmed
          this.recordCommand(commandId, 'confirm', result)
          return { ...base, result: result as unknown as JsonValue }
        }
        case 'behavior.stop': {
          const requested = typeof params.runId === 'string' ? params.runId : undefined
          const runId = requested ?? this.behavior.status().activeRun?.runId
          if (runId === undefined) {
            return { ...base, error: invalidMessageError('no active behavior run') }
          }
          const stopped = this.behavior.stop(runId)
          this.recordCommand(commandId, 'behavior.stop', stopped)
          return { ...base, result: stopped as unknown as JsonValue }
        }
        case 'guard.set': {
          const condition = parseGuardCondition(params.condition)
          const target = params.target as { artifactId?: unknown; params?: unknown } | undefined
          const ttlMs = typeof params.ttlMs === 'number' ? params.ttlMs : undefined
          if (condition === undefined || target === undefined || typeof target.artifactId !== 'string' || ttlMs === undefined) {
            return { ...base, error: invalidMessageError('condition, target.artifactId, and ttlMs are required') }
          }
          const targetParams = target.params !== undefined && typeof target.params === 'object' && target.params !== null && !Array.isArray(target.params)
            ? target.params as Record<string, JsonValue>
            : {}
          const guardId = typeof params.guardId === 'string' ? params.guardId : undefined
          const priority = typeof params.priority === 'number' ? params.priority : undefined
          const guarded = this.behavior.setGuard({
            ...(guardId === undefined ? {} : { guardId }),
            ...(priority === undefined ? {} : { priority }),
            condition,
            targetArtifactId: target.artifactId,
            params: targetParams,
            ttlMs,
          })
          this.recordCommand(commandId, 'guard.set', guarded)
          return { ...base, result: guarded as unknown as JsonValue }
        }
        case 'guard.clear': {
          const guardId = typeof params.guardId === 'string' ? params.guardId : undefined
          const cleared = this.behavior.clearGuard(guardId)
          this.recordCommand(commandId, 'guard.clear', cleared)
          return { ...base, result: cleared as unknown as JsonValue }
        }
        case 'watch.add': {
          const queries = parseWatchQueries(params.queries)
          const predicate = typeof params.predicate === 'string' ? params.predicate : undefined
          if (queries === undefined || predicate === undefined || predicate.length === 0) {
            return { ...base, error: invalidMessageError('queries and predicate are required') }
          }
          const rawEdge = params.edge
          if (rawEdge !== undefined && rawEdge !== 'rising' && rawEdge !== 'falling' && rawEdge !== 'both') {
            return { ...base, error: invalidMessageError('watch edge must be rising, falling or both') }
          }
          const edge = rawEdge as 'rising' | 'falling' | 'both' | undefined
          const cooldownMs = typeof params.cooldownMs === 'number' ? params.cooldownMs : undefined
          const ttlMs = typeof params.ttlMs === 'number' ? params.ttlMs : undefined
          const name = typeof params.name === 'string' ? params.name : undefined
          const priority = typeof params.priority === 'number' ? params.priority : undefined
          const watch = this.behavior.addWatch({
            queries,
            predicate,
            ...(edge === undefined ? {} : { edge }),
            ...(cooldownMs === undefined ? {} : { cooldownMs }),
            ...(ttlMs === undefined ? {} : { ttlMs }),
            ...(name === undefined ? {} : { name }),
            ...(priority === undefined ? {} : { priority }),
          })
          this.recordCommand(commandId, 'watch.add', watch)
          return { ...base, result: watch as unknown as JsonValue }
        }
        case 'watch.remove': {
          const watchId = typeof params.watchId === 'string' ? params.watchId : undefined
          const removed = this.behavior.removeWatch(watchId)
          this.recordCommand(commandId, 'watch.remove', removed)
          return { ...base, result: removed as unknown as JsonValue }
        }
        default:
          return { ...base, error: unknownMethodError(envelope.method) }
      }
    } catch (error) {
      const p2 = error instanceof CheckerError || error instanceof RegistryError
        ? p2Error(error.code, 'validation', error.message, { module: 'body.behavior' })
        : p2Error('BEHAVIOR_ERROR', 'runtime', error instanceof Error ? error.message : String(error), { module: 'body.behavior' })
      this.commands.set(commandId, {
        commandId: commandId as CommandId,
        method: envelope.method,
        state: 'rejected',
        error: p2,
      })
      this.debugLog?.log({ event: 'command', commandId, method: envelope.method, state: 'rejected', code: p2.code })
      return { ...base, error: p2 }
    }
  }

  private recordCommand(commandId: string, method: string, result: unknown): void {
    this.commands.set(commandId, {
      commandId: commandId as CommandId,
      method,
      state: 'completed',
      result: result as JsonValue,
    })
    this.debugLog?.log({
      event: 'command',
      commandId,
      method,
      state: 'completed',
    })
  }

  describe(): DescribeResult {
    return {
      protocolVersion: PROTOCOL_VERSION,
      body: {
        version: this.body.manifest.bodyVersion,
        protocolVersion: this.body.manifest.protocolVersion,
        manifestDigest: this.body.manifestDigest,
      },
      bindingId: this.body.bindingId,
      capabilities: this.body.capabilities,
      provider: this.body.provider,
    }
  }

  status(): StatusResult {
    const behavior = this.behavior?.status()
    const providerState = behavior?.providerState ?? null
    const connected = providerState === null || providerState === undefined
      ? this.behavior === undefined
      : providerState.connected !== false
    return {
      bodyEpoch: this.bodyEpoch,
      version: this.body.manifest.bodyVersion,
      owner: this.owner,
      health: this.closing ? 'faulted' : 'ready',
      connection: connected ? 'connected' : 'disconnected',
      activeRun: behavior?.activeRun ?? null,
      lastRun: behavior?.lastRun ?? null,
      pendingConfirmation: behavior?.pendingConfirmation ?? null,
      bindingId: this.body.bindingId,
      capabilities: this.body.capabilities,
      provider: this.body.provider,
      providerState,
      commandCount: this.commands.size,
      activeAct: this.behavior?.status().activeAct ?? null,
      activeActHandle: this.behavior?.status().activeActHandle ?? null,
      activeNode: this.behavior?.status().activeNode ?? null,
      activeTarget: this.behavior?.status().activeTarget ?? null,
      waiting: this.behavior?.status().waiting ?? null,
      lastFailure: this.behavior?.status().lastFailure ?? null,
      currentStep: this.behavior?.status().currentStep ?? null,
      stepCount: this.behavior?.status().stepCount ?? 0,
      progress: this.behavior?.status().progress ?? null,
      lastError: this.behavior?.status().lastError ?? null,
      cleanupState: this.behavior?.status().cleanupState ?? 'none',
      controlHealth: this.behavior?.status().controlHealth ?? 'ok',
      switchState: this.behavior?.status().switchState ?? 'none',
      guards: behavior?.guards ?? [],
      lastSwitch: behavior?.lastSwitch ?? null,
      guardEvents: behavior?.guardEvents ?? [],
      guardEventSeq: behavior?.guardEventSeq ?? 0,
      watches: behavior?.watches ?? [],
      watchEvents: behavior?.watchEvents ?? [],
      watchEventSeq: behavior?.watchEventSeq ?? 0,
      rescue: this.rescueState ?? null,
      devOps: this.devOpsState?.() ?? null,
      ...(this.debugLog === undefined ? {} : {
        loggingUnavailable: this.debugLog.loggingUnavailable,
        droppedLogCount: this.debugLog.droppedCount,
      }),
    }
  }

  private traceResult(params: JsonValue): TraceResult {
    if (this.trace === undefined) {
      return { events: [], stats: {}, dropped: 0, capacity: 0, seq: 0, gap: false }
    }
    return this.trace.read(parseTraceParams(params))
  }

  tickBehavior(now = this.now()): string | undefined {
    const status = this.behavior?.tick(now)
    if (status !== undefined && status !== this.lastBehaviorStatus) {
      this.lastBehaviorStatus = status
      if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
        this.debugLog?.log({ event: 'run/terminal', status })
      }
    }
    return status
  }

  private handleHello(
    base: { protocol: 1; requestId: string; bodyEpoch: string },
    envelope: RequestEnvelope,
  ): ResponseEnvelope {
    if (this.closing) return { ...base, error: this.shuttingDown() }
    const params = parseHelloParams(envelope.params)
    if ('error' in params) return { ...base, error: params.error }
    if (!params.value.protocols.includes(PROTOCOL_VERSION)) {
      return { ...base, error: unsupportedProtocolError(params.value.protocols) }
    }

    if (this.initialized) {
      if (this.owner !== null && this.owner.sessionId !== params.value.owner.sessionId) {
        return { ...base, error: this.invalidOwner() }
      }
      this.behavior?.setOwner(`${params.value.owner.sessionId}/${params.value.owner.agentId}`)
      return { ...base, result: this.helloResult(params.value.owner) }
    }

    this.owner = params.value.owner
    this.behavior?.setOwner(`${params.value.owner.sessionId}/${params.value.owner.agentId}`)
    this.initialized = true
    this.lastHeartbeatAt = this.now()
    return { ...base, result: this.helloResult(params.value.owner) }
  }

  private handleHeartbeat(
    base: { protocol: 1; requestId: string; bodyEpoch: string },
    envelope: RequestEnvelope,
  ): ResponseEnvelope {
    const params = parseHeartbeatParams(envelope.params)
    if ('error' in params) return { ...base, error: params.error }
    if (params.value.seq > this.lastHeartbeatSeq) {
      this.lastHeartbeatSeq = params.value.seq
      this.lastHeartbeatAt = this.now()
    }
    return { ...base, result: { seq: params.value.seq, alive: true } }
  }

  private handleStop(
    base: { protocol: 1; requestId: string; bodyEpoch: string },
    envelope: RequestEnvelope,
  ): ResponseEnvelope {
    const commandId = this.requireCommandId(envelope)
    if (typeof commandId !== 'string') return { ...base, error: commandId.error }
    const existing = this.commands.get(commandId)
    if (existing !== undefined) {
      if (existing.method !== 'stop') {
        return { ...base, error: duplicateCommand(commandId) }
      }
      return { ...base, result: existing.result as JsonValue }
    }
    const params = parseStopParams(envelope.params)
    if ('error' in params) return { ...base, error: params.error }
    const result: StopResult = { accepted: true, runId: params.value.runId ?? null }
    this.commands.set(commandId, {
      commandId: commandId as CommandId,
      method: 'stop',
      state: 'completed',
      result: result as unknown as JsonValue,
    })
    return { ...base, result: result as unknown as JsonValue }
  }

  private handleShutdown(
    base: { protocol: 1; requestId: string; bodyEpoch: string },
    envelope: RequestEnvelope,
  ): ResponseEnvelope {
    const commandId = this.requireCommandId(envelope)
    if (typeof commandId !== 'string') return { ...base, error: commandId.error }
    const existing = this.commands.get(commandId)
    if (existing !== undefined) {
      if (existing.method !== 'shutdown') {
        return { ...base, error: duplicateCommand(commandId) }
      }
      return { ...base, result: existing.result as JsonValue }
    }
    const result: ShutdownResult = { closing: true }
    this.commands.set(commandId, {
      commandId: commandId as CommandId,
      method: 'shutdown',
      state: 'completed',
      result: result as unknown as JsonValue,
    })
    this.closing = true
    return { ...base, result: result as unknown as JsonValue }
  }

  private handleCommandGet(
    base: { protocol: 1; requestId: string; bodyEpoch: string },
    envelope: RequestEnvelope,
  ): ResponseEnvelope {
    const params = asRecord(envelope.params)
    const commandId = typeof params?.commandId === 'string' ? params.commandId : undefined
    if (commandId === undefined) return { ...base, error: invalidMessageError('commandId is required') }
    const record = this.commands.get(commandId)
    if (record === undefined) {
      return {
        ...base,
        error: p2Error(
          ErrorCodes.COMMAND_NOT_FOUND,
          'validation',
          `command not found: ${commandId}`,
          { module: 'body.commands' },
          { commandId },
        ),
      }
    }
    return { ...base, result: record as unknown as JsonValue }
  }

  private helloResult(owner: OwnerContext): HelloResult {
    return {
      protocolVersion: PROTOCOL_VERSION,
      bodyEpoch: this.bodyEpoch,
      body: {
        version: this.body.manifest.bodyVersion,
        protocolVersion: this.body.manifest.protocolVersion,
        manifestDigest: this.body.manifestDigest,
      },
      owner,
      bindingId: this.body.bindingId,
      capabilities: this.body.capabilities,
      provider: this.body.provider,
    }
  }

  private requireCommandId(envelope: RequestEnvelope): string | { error: P2Error } {
    if (typeof envelope.commandId === 'string' && envelope.commandId.length > 0) {
      return envelope.commandId
    }
    return { error: invalidMessageError(`${envelope.method} requires commandId`) }
  }

  private notInitialized(): P2Error {
    return p2Error(
      ErrorCodes.NOT_INITIALIZED,
      'validation',
      'body has not completed hello',
      { module: 'body.protocol' },
    )
  }

  private staleEpoch(epoch: string | undefined): P2Error {
    return p2Error(
      ErrorCodes.STALE_EPOCH,
      'validation',
      `stale bodyEpoch: ${epoch ?? '(missing)'}`,
      { module: 'body.protocol' },
      { current: this.bodyEpoch },
    )
  }

  private invalidOwner(): P2Error {
    return p2Error(
      ErrorCodes.INVALID_OWNER,
      'validation',
      'owner does not match the active hello',
      { module: 'body.owner' },
    )
  }

  private shuttingDown(): P2Error {
    return p2Error(
      ErrorCodes.SHUTTING_DOWN,
      'control',
      'body is shutting down',
      { module: 'body.lifecycle' },
    )
  }
}

function inside(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path))
  return relativePath === ''
    || (!isAbsolute(relativePath)
      && !relativePath.startsWith('..')
      && !relativePath.split(sep).includes('..'))
}

function parseHelloParams(params: JsonValue): { value: HelloParams } | { error: P2Error } {
  const record = asRecord(params)
  if (record === undefined) return { error: invalidMessageError('hello params must be an object') }
  if (!Array.isArray(record.protocols)
    || record.protocols.length === 0
    || !record.protocols.every(value => typeof value === 'number' && Number.isInteger(value))) {
    return { error: invalidMessageError('hello protocols must be integers') }
  }
  const owner = record.owner
  if (!isOwnerContext(owner)) {
    return { error: invalidMessageError('hello owner is invalid') }
  }
  if (!isAbsolute(owner.cwd)) {
    return { error: invalidMessageError('hello owner.cwd must be absolute') }
  }
  return {
    value: {
      protocols: record.protocols as number[],
      owner,
    },
  }
}

function parseHeartbeatParams(params: JsonValue): { value: HeartbeatParams } | { error: P2Error } {
  const record = asRecord(params)
  if (record === undefined
    || typeof record.seq !== 'number'
    || !Number.isInteger(record.seq)
    || record.seq < 0) {
    return { error: invalidMessageError('heartbeat seq must be a non-negative integer') }
  }
  return { value: { seq: record.seq } }
}

function parseStopParams(params: JsonValue): { value: StopParams } | { error: P2Error } {
  const record = asRecord(params)
  if (record === undefined) return { error: invalidMessageError('stop params must be an object') }
  const runId = record.runId
  if (runId === undefined) return { value: {} }
  if (typeof runId !== 'string') {
    return { error: invalidMessageError('stop runId must be a string') }
  }
  return { value: { runId: runId as RunId } }
}

const TRACE_KINDS: ReadonlySet<string> = new Set(['run', 'behavior', 'act', 'op', 'guard', 'watch'])

function parseSnapshotOps(value: JsonValue | undefined): SnapshotOp[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return undefined
  const seen = new Set<string>()
  const ops: SnapshotOp[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const record = entry as Record<string, JsonValue>
    if (typeof record.key !== 'string' || record.key.length === 0 || record.key.length > 64) return undefined
    if (typeof record.op !== 'string' || record.op.length === 0) return undefined
    if (seen.has(record.key)) return undefined
    seen.add(record.key)
    if (record.args !== undefined && (typeof record.args !== 'object' || record.args === null || Array.isArray(record.args))) {
      return undefined
    }
    ops.push({
      key: record.key,
      op: record.op,
      ...(record.args === undefined ? {} : { args: record.args }),
    })
  }
  return ops
}

function parseWatchQueries(value: JsonValue | undefined): GuardQuery[] | undefined {  if (!Array.isArray(value) || value.length === 0 || value.length > 4) return undefined
  const queries: GuardQuery[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const record = entry as Record<string, JsonValue>
    if (typeof record.op !== 'string' || record.op.length === 0) return undefined
    if (record.args === undefined) {
      queries.push({ op: record.op })
      continue
    }
    if (typeof record.args !== 'object' || record.args === null || Array.isArray(record.args)) return undefined
    queries.push({ op: record.op, args: record.args })
  }
  return queries
}

/** Wire-level guard condition shape; semantic checks stay in the host. */
function parseGuardCondition(value: JsonValue | undefined): GuardCondition | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, JsonValue>
  if (record.kind === 'health') {
    return typeof record.hpBelow === 'number' && Number.isFinite(record.hpBelow) && record.hpBelow > 0
      ? { kind: 'health', hpBelow: record.hpBelow }
      : undefined
  }
  if (record.kind !== 'policy') return undefined
  if (typeof record.predicate !== 'string' || record.predicate.length === 0) return undefined
  if (!Array.isArray(record.queries) || record.queries.length === 0 || record.queries.length > 4) return undefined
  const queries: Array<{ op: string; args?: JsonValue }> = []
  for (const entry of record.queries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const query = entry as Record<string, JsonValue>
    if (typeof query.op !== 'string' || query.op.length === 0) return undefined
    if (query.args === undefined) {
      queries.push({ op: query.op })
      continue
    }
    if (typeof query.args !== 'object' || query.args === null || Array.isArray(query.args)) return undefined
    queries.push({ op: query.op, args: query.args })
  }
  return { kind: 'policy', queries, predicate: record.predicate }
}

/** Invalid trace filters are ignored field by field; tracing never fails a request. */
function parseTraceParams(params: JsonValue): TraceParams {
  const record = asRecord(params)
  if (record === undefined) return {}
  const filter: TraceParams = {}
  if (typeof record.kind === 'string' && TRACE_KINDS.has(record.kind)) {
    filter.kind = record.kind as NonNullable<TraceParams['kind']>
  }
  if (typeof record.runId === 'string' && record.runId.length > 0) filter.runId = record.runId
  if (typeof record.act === 'string' && record.act.length > 0) filter.act = record.act
  if (typeof record.op === 'string' && record.op.length > 0) filter.op = record.op
  if (typeof record.sinceSeq === 'number' && Number.isInteger(record.sinceSeq) && record.sinceSeq >= 0) {
    filter.sinceSeq = record.sinceSeq
  }
  if (typeof record.limit === 'number' && Number.isInteger(record.limit) && record.limit > 0) {
    filter.limit = record.limit
  }
  return filter
}

function asRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return isRecord(value) ? value : undefined
}

function duplicateCommand(commandId: string): P2Error {
  return p2Error(
    ErrorCodes.DUPLICATE_COMMAND,
    'validation',
    `commandId already used by another method: ${commandId}`,
    { module: 'body.commands' },
    { commandId },
  )
}


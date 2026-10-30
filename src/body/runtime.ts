import { randomUUID } from 'node:crypto'

import {
  PROTOCOL_VERSION,
  asP2Error,
  isOwnerContext,
  isRecord,
  p2Error,
  unknownMethodError,
  unsupportedProtocolError,
} from '../contracts/protocol.ts'
import type {
  ActivateParams,
  ActivateResult,
  BodyInfo,
  CardParams,
  CardResult,
  CheckParams,
  CheckResult,
  CommandGetParams,
  CommandRecord,
  ControllerCancelParams,
  ControllerCommitParams,
  ControllerEventsParams,
  ControllerInstallParams,
  DescribeResult,
  HeartbeatParams,
  HelloParams,
  HelloResult,
  ObserveParams,
  ObserveResult,
  OwnerContext,
  ProviderRuntimeStatus,
  RequestEnvelope,
  ResponseEnvelope,
  RescueParams,
  SnapshotParams,
  SnapshotPart,
  SnapshotResult,
  StatusResult,
  WatchQuery,
  WatchStatus,
} from '../contracts/protocol.ts'
import { ErrorCodes } from '../contracts/types.ts'
import type { BodyEpoch, JsonValue, P2Error } from '../contracts/types.ts'
import { ArtifactHost } from '../core/artifact-host.ts'
import type { ControllerRuntime } from './controller-host.ts'
import { CommandLedger as Ledger } from '../core/logging.ts'
import type { QueryOutcome } from '../core/node-runtime.ts'

export type BodyRuntimeOptions = {
  body: BodyInfo
  host?: ArtifactHost
  controller?: ControllerRuntime
  owner?: OwnerContext
  heartbeatTimeoutMs?: number
  now?: () => number
  newEpoch?: () => string
  newCommandId?: () => string
  shutdownGraceMs?: number
  rescue?: { enabled: boolean; tpRadius: number }
  devOps?: () => { enabled: boolean; path: string; generation: number; operations: string[]; lastError: string | null } | null
}

type LedgerValue = { method: string; result?: JsonValue; error?: P2Error }

/**
 * Controller-only body runtime: artifacts (act/policy/op/strategy), observation,
 * watches and the single P2Controller control mode. There is no behavior run,
 * switch, guard or confirmation state.
 */
export class BodyRuntime {
  private readonly body: BodyInfo
  private readonly host: ArtifactHost
  private readonly controller: ControllerRuntime | undefined
  private readonly now: () => number
  private readonly newCommandId: () => string
  private readonly heartbeatTimeoutMs: number | undefined
  private readonly rescue: { enabled: boolean; tpRadius: number } | undefined
  private readonly devOps: BodyRuntimeOptions['devOps']
  private owner: OwnerContext | undefined
  private lastHeartbeatAt = 0
  private closing = false
  private readonly ledger: Ledger<LedgerValue> = new Ledger(1000)
  readonly bodyEpoch: BodyEpoch
  readonly leaseTimeoutMs: number | undefined

  constructor(options: BodyRuntimeOptions) {
    this.body = options.body
    this.host = options.host ?? new ArtifactHost({
      bindingId: options.body.bindingId ?? 'unbound',
      query: () => ({
        status: 'failed',
        error: p2Error('PROVIDER_UNAVAILABLE', 'environment', 'no provider is connected in this body', { module: 'body.runtime' }),
      }),
      act: { start: () => { throw new Error('no provider is connected in this body') } },
    })
    this.controller = options.controller
    this.now = options.now ?? (() => Date.now())
    this.newCommandId = options.newCommandId ?? (() => `cmd-${randomUUID()}`)
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs
    this.leaseTimeoutMs = options.heartbeatTimeoutMs
    this.rescue = options.rescue
    this.devOps = options.devOps
    this.bodyEpoch = (options.newEpoch?.() ?? randomUUID()) as BodyEpoch
    if (options.owner !== undefined) {
      this.owner = options.owner
      this.lastHeartbeatAt = this.now()
      this.host.setOwner(this.owner.agentId)
    }
  }

  get isClosing(): boolean {
    return this.closing
  }

  get agentId(): string | undefined {
    return this.owner?.agentId
  }

  /** Heartbeat lease check; false means the owner lease expired. */
  checkHeartbeat(now = this.now()): boolean {
    if (this.heartbeatTimeoutMs === undefined) return true
    if (this.owner === undefined) return true
    return now - this.lastHeartbeatAt <= this.heartbeatTimeoutMs
  }

  /** Advance observation-only watches and, when engaged, the controller. */
  tick(now = this.now()): void {
    this.host.tick(now)
    if (this.controller?.engaged === true) this.controller.tick(now)
  }

  async handleRequestAsync(envelope: RequestEnvelope): Promise<ResponseEnvelope> {
    const requestId = envelope.requestId
    try {
      if (this.closing && envelope.method !== 'shutdown') {
        throw p2Error(ErrorCodes.SHUTTING_DOWN, 'runtime', 'body is shutting down', { module: 'body.runtime' })
      }
      if (envelope.bodyEpoch !== undefined && envelope.bodyEpoch !== this.bodyEpoch) {
        throw p2Error(ErrorCodes.STALE_EPOCH, 'validation', 'request targets a different body epoch', {
          module: 'body.runtime',
        }, { bodyEpoch: this.bodyEpoch })
      }
      const result = await this.dispatch(envelope)
      return { protocol: 1, requestId, bodyEpoch: this.bodyEpoch, result }
    } catch (error) {
      const p2 = asP2Error(error) ?? p2Error(
        ErrorCodes.INTERNAL_ERROR,
        'runtime',
        error instanceof Error ? error.message : String(error),
        { module: 'body.runtime' },
      )
      return { protocol: 1, requestId, bodyEpoch: this.bodyEpoch, error: p2 }
    }
  }

  /**
   * Sync entry for methods that never await. Async methods (check/observe/
   * snapshot/card/rescue) must use handleRequestAsync.
   */
  handleRequest(envelope: RequestEnvelope): ResponseEnvelope {
    try {
      const params = isRecord(envelope.params) ? envelope.params : {}
      let result: JsonValue
      switch (envelope.method) {
        case 'hello': result = this.hello(params) as unknown as JsonValue; break
        case 'heartbeat': result = this.heartbeat(params) as unknown as JsonValue; break
        case 'describe': result = this.describe() as unknown as JsonValue; break
        case 'status': result = this.status() as unknown as JsonValue; break
        case 'watch.list': result = { watches: this.host.listWatches() } as unknown as JsonValue; break
        case 'controller.enable': result = this.controllerEnable(envelope); break
        case 'controller.disable': result = this.controllerDisable(envelope); break
        case 'controller.status': result = this.controllerStatus(); break
        case 'controller.install': result = this.controllerInstall(envelope, params as unknown as ControllerInstallParams); break
        case 'controller.commit': result = this.controllerCommit(envelope, params as unknown as ControllerCommitParams); break
        case 'controller.cancel': result = this.controllerCancel(envelope, params as unknown as ControllerCancelParams); break
        case 'controller.events': result = this.controllerEvents(params as unknown as ControllerEventsParams); break
        case 'command.get': result = this.commandGet(params as unknown as CommandGetParams) as unknown as JsonValue; break
        case 'shutdown': this.closing = true; result = { closing: true }; break
        default:
          throw p2Error('METHOD_ASYNC', 'validation', `method needs the async path: ${envelope.method}`, { module: 'body.runtime' })
      }
      return { protocol: 1, requestId: envelope.requestId, bodyEpoch: this.bodyEpoch, result }
    } catch (error) {
      const p2 = asP2Error(error) ?? p2Error(
        ErrorCodes.INTERNAL_ERROR,
        'runtime',
        error instanceof Error ? error.message : String(error),
        { module: 'body.runtime' },
      )
      return { protocol: 1, requestId: envelope.requestId, bodyEpoch: this.bodyEpoch, error: p2 }
    }
  }

  /** Convenience for tests: run the async path and unwrap the result. */
  async request(method: string, params: JsonValue = {}, commandId?: string): Promise<JsonValue> {
    const envelope: RequestEnvelope = {
      protocol: 1,
      requestId: `req-${randomUUID()}`,
      method,
      params,
      ...(commandId === undefined ? {} : { commandId }),
    }
    const response = await this.handleRequestAsync(envelope)
    if (response.error !== undefined) throw response.error
    return response.result as JsonValue
  }

  private async dispatch(envelope: RequestEnvelope): Promise<JsonValue> {
    const params = isRecord(envelope.params) ? envelope.params : {}
    switch (envelope.method) {
      case 'hello': return this.hello(params) as unknown as JsonValue
      case 'heartbeat': return this.heartbeat(params) as unknown as JsonValue
      case 'describe': return this.describe() as unknown as JsonValue
      case 'status': return this.status() as unknown as JsonValue
      case 'observe': return await this.observe(params as unknown as ObserveParams) as unknown as JsonValue
      case 'snapshot': return await this.snapshot(params as unknown as SnapshotParams) as unknown as JsonValue
      case 'card': return await this.card(params as CardParams) as unknown as JsonValue
      case 'check': return await this.check(envelope, params as unknown as CheckParams) as unknown as JsonValue
      case 'activate': return this.activate(envelope, params as unknown as ActivateParams) as unknown as JsonValue
      case 'watch.add': return this.watchAdd(envelope, params) as unknown as JsonValue
      case 'watch.remove': return this.watchRemove(params) as unknown as JsonValue
      case 'watch.list': return { watches: this.host.listWatches() } as unknown as JsonValue
      case 'rescue': return await this.rescueRequest(params as unknown as RescueParams) as unknown as JsonValue
      case 'controller.enable': return this.controllerEnable(envelope) as unknown as JsonValue
      case 'controller.disable': return this.controllerDisable(envelope) as unknown as JsonValue
      case 'controller.status': return this.controllerStatus() as unknown as JsonValue
      case 'controller.install': return this.controllerInstall(envelope, params as unknown as ControllerInstallParams) as unknown as JsonValue
      case 'controller.commit': return this.controllerCommit(envelope, params as unknown as ControllerCommitParams) as unknown as JsonValue
      case 'controller.cancel': return this.controllerCancel(envelope, params as unknown as ControllerCancelParams) as unknown as JsonValue
      case 'controller.events': return this.controllerEvents(params as unknown as ControllerEventsParams) as unknown as JsonValue
      case 'shutdown': this.closing = true; return { closing: true }
      case 'command.get': return this.commandGet(params as unknown as CommandGetParams) as unknown as JsonValue
      default:
        throw unknownMethodError(envelope.method)
    }
  }

  private requireOwner(): OwnerContext {
    if (this.owner === undefined) {
      throw p2Error(ErrorCodes.NOT_INITIALIZED, 'runtime', 'hello must be called before this request', {
        module: 'body.runtime',
      })
    }
    return this.owner
  }

  private hello(params: Record<string, JsonValue>): HelloResult {
    const protocols = Array.isArray(params.protocols)
      ? params.protocols.filter((item): item is number => typeof item === 'number')
      : []
    if (!protocols.includes(PROTOCOL_VERSION)) throw unsupportedProtocolError(protocols)
    if (!isOwnerContext(params.owner)) {
      throw p2Error(ErrorCodes.INVALID_OWNER, 'validation', 'owner context is invalid', { module: 'body.runtime' })
    }
    this.owner = params.owner
    this.lastHeartbeatAt = this.now()
    this.host.setOwner(params.owner.agentId)
    return this.helloResult(params.owner)
  }

  private helloResult(owner: OwnerContext): HelloResult {
    return {
      protocolVersion: PROTOCOL_VERSION,
      bodyEpoch: this.bodyEpoch,
      body: {
        version: this.body.manifest.bodyVersion,
        protocolVersion: PROTOCOL_VERSION,
        manifestDigest: this.body.manifestDigest,
      },
      owner,
      bindingId: this.body.bindingId,
      capabilities: this.body.capabilities,
      provider: this.body.provider,
    }
  }

  private heartbeat(params: Record<string, JsonValue>): { seq: number; alive: true } {
    this.requireOwner()
    const seq = typeof params.seq === 'number' ? params.seq : 0
    this.lastHeartbeatAt = this.now()
    return { seq, alive: true }
  }

  describe(): DescribeResult {
    return {
      protocolVersion: PROTOCOL_VERSION,
      body: {
        version: this.body.manifest.bodyVersion,
        protocolVersion: PROTOCOL_VERSION,
        manifestDigest: this.body.manifestDigest,
      },
      bindingId: this.body.bindingId,
      capabilities: this.body.capabilities,
      provider: this.body.provider,
    }
  }

  status(): StatusResult {
    const hostStatus = this.host.status(this.now())
    return {
      bodyEpoch: this.bodyEpoch,
      version: this.body.manifest.bodyVersion,
      owner: this.owner ?? null,
      health: 'ready',
      connection: hostStatus.providerState?.connected === true ? 'connected' : 'disconnected',
      bindingId: this.body.bindingId,
      capabilities: this.body.capabilities,
      provider: this.body.provider,
      providerState: hostStatus.providerState,
      commandCount: this.ledger.size,
      watches: hostStatus.watches,
      watchEvents: hostStatus.watchEvents,
      watchEventSeq: hostStatus.watchEventSeq,
      rescue: this.rescue ?? null,
      devOps: this.devOps?.() ?? null,
      controller: this.controller?.status() ?? null,
    }
  }

  private async observe(params: ObserveParams): Promise<ObserveResult> {
    this.requireOwner()
    if (typeof params.op !== 'string' || params.op.length === 0) {
      throw p2Error('INVALID_MESSAGE', 'validation', 'observe requires an op name', { module: 'body.runtime' })
    }
    const args = isRecord(params.args) ? params.args : {}
    const outcome = await this.awaitQuery(this.host.observe(params.op, args))
    if (outcome.status === 'failed') throw outcome.error
    return {
      op: params.op,
      value: outcome.value,
      ...(outcome.meta === undefined ? {} : { meta: outcome.meta }),
    }
  }

  private async snapshot(params: SnapshotParams): Promise<SnapshotResult> {
    this.requireOwner()
    const ops = Array.isArray(params.ops) ? params.ops : []
    const parts: SnapshotPart[] = []
    for (const op of ops) {
      if (typeof op.key !== 'string' || typeof op.op !== 'string') continue
      const outcome = await this.awaitQuery(this.host.observe(op.op, isRecord(op.args) ? op.args as Record<string, JsonValue> : {}))
      if (outcome.status === 'failed') {
        parts.push({ key: op.key, op: op.op, status: 'failed', error: outcome.error })
      } else {
        parts.push({
          key: op.key,
          op: op.op,
          status: 'ok',
          value: outcome.value,
          ...(outcome.meta === undefined ? {} : { meta: outcome.meta }),
        })
      }
    }
    return {
      parts,
      partial: parts.some(part => part.status !== 'ok'),
      sampledAt: this.now(),
    }
  }

  private async card(params: CardParams): Promise<CardResult> {
    this.requireOwner()
    const radius = typeof params.radius === 'number' ? params.radius : 16
    const [position, health, entities] = await Promise.all([
      this.awaitQuery(this.host.observe('position')),
      this.awaitQuery(this.host.observe('health')),
      this.awaitQuery(this.host.observe('entities', { radius, count: 64 })),
    ])
    const positionValue = position.status === 'ok' && isRecord(position.value) ? position.value : null
    const healthValue = health.status === 'ok' && isRecord(health.value) ? health.value : null
    const hostiles = entities.status === 'ok' && Array.isArray(entities.value)
      ? entities.value.filter(item => isRecord(item) && item.kind === 'hostile').length
      : null
    const watches = this.host.listWatches()
    return {
      bodyEpoch: this.bodyEpoch,
      health: 'ready',
      connection: this.host.status(this.now()).providerState?.connected === true ? 'connected' : 'disconnected',
      healthValue: healthValue !== null && typeof healthValue.health === 'number' ? healthValue.health : null,
      food: healthValue !== null && typeof healthValue.food === 'number' ? healthValue.food : null,
      position: positionValue !== null
        && typeof positionValue.x === 'number'
        && typeof positionValue.y === 'number'
        && typeof positionValue.z === 'number'
        ? { x: positionValue.x, y: positionValue.y, z: positionValue.z }
        : null,
      hostiles,
      watches: {
        active: watches.filter(watch => watch.state === 'active').length,
        error: watches.filter(watch => watch.state === 'error').length,
      },
      provider: this.host.status(this.now()).providerState,
      sampledAt: this.now(),
    }
  }

  private async check(envelope: RequestEnvelope, params: CheckParams): Promise<CheckResult> {
    this.requireOwner()
    const commandId = this.requireCommandId(envelope)
    const duplicate = this.ledger.get(commandId)
    if (duplicate !== undefined) return duplicate.result as unknown as CheckResult
    const result = await this.host.check({
      sourcePath: params.sourcePath,
      ...(params.sourceRoot === undefined ? {} : { sourceRoot: params.sourceRoot }),
      ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
      ...(params.artifactKind === undefined ? {} : { artifactKind: params.artifactKind }),
    })
    const value: CheckResult = {
      artifactId: result.artifactId,
      definitionId: result.definitionId,
      sourceDigest: result.sourceDigest,
      bindingId: this.body.bindingId ?? 'unbound',
      kind: result.kind,
      enabled: false,
    }
    this.recordCommand(commandId, 'check', value as unknown as JsonValue)
    return value
  }

  private activate(envelope: RequestEnvelope, params: ActivateParams): ActivateResult {
    this.requireOwner()
    const commandId = this.requireCommandId(envelope)
    const duplicate = this.ledger.get(commandId)
    if (duplicate !== undefined) return duplicate.result as unknown as ActivateResult
    if (typeof params.artifactId !== 'string' || params.artifactId.length === 0) {
      throw p2Error('INVALID_MESSAGE', 'validation', 'activate requires artifactId', { module: 'body.runtime' })
    }
    const result = this.host.activate(params.artifactId)
    this.recordCommand(commandId, 'activate', result as unknown as JsonValue)
    return result
  }

  private watchAdd(envelope: RequestEnvelope, params: Record<string, JsonValue>): WatchStatus {
    this.requireOwner()
    const commandId = this.requireCommandId(envelope)
    void commandId
    const queries = Array.isArray(params.queries) ? params.queries as unknown as WatchQuery[] : []
    return this.host.addWatch({
      queries,
      predicate: typeof params.predicate === 'string' ? params.predicate : '',
      ...(params.edge === 'rising' || params.edge === 'falling' || params.edge === 'both' ? { edge: params.edge } : {}),
      ...(typeof params.cooldownMs === 'number' ? { cooldownMs: params.cooldownMs } : {}),
      ...(typeof params.ttlMs === 'number' ? { ttlMs: params.ttlMs } : {}),
      ...(typeof params.name === 'string' ? { name: params.name } : {}),
      ...(typeof params.priority === 'number' ? { priority: params.priority } : {}),
    }, this.now())
  }

  private watchRemove(params: Record<string, JsonValue>): { removed: number; watches: WatchStatus[] } {
    this.requireOwner()
    return this.host.removeWatch(typeof params.watchId === 'string' ? params.watchId : undefined)
  }

  private async rescueRequest(params: RescueParams): Promise<JsonValue> {
    this.requireOwner()
    return await this.host.rescueRun(params) as unknown as JsonValue
  }

  private controllerEnable(envelope: RequestEnvelope): JsonValue {
    this.requireOwner()
    const commandId = this.requireCommandId(envelope)
    const duplicate = this.ledger.get(commandId)
    if (duplicate !== undefined) return duplicate.result as JsonValue
    const result = this.requireController().enable(this.now())
    this.recordCommand(commandId, 'controller.enable', result as unknown as JsonValue)
    return result as unknown as JsonValue
  }

  private controllerDisable(envelope: RequestEnvelope): JsonValue {
    this.requireOwner()
    const commandId = this.requireCommandId(envelope)
    const duplicate = this.ledger.get(commandId)
    if (duplicate !== undefined) return duplicate.result as JsonValue
    const result = this.requireController().disable(this.now())
    this.recordCommand(commandId, 'controller.disable', result as unknown as JsonValue)
    return result as unknown as JsonValue
  }

  private controllerStatus(): JsonValue {
    this.requireOwner()
    return this.requireController().status() as unknown as JsonValue
  }

  private controllerInstall(envelope: RequestEnvelope, params: ControllerInstallParams): JsonValue {
    this.requireOwner()
    const commandId = this.requireCommandId(envelope)
    const duplicate = this.ledger.get(commandId)
    if (duplicate !== undefined) return duplicate.result as JsonValue
    const result = this.requireController().install(params, this.now())
    this.recordCommand(commandId, 'controller.install', result as unknown as JsonValue)
    return result as unknown as JsonValue
  }

  private controllerCommit(envelope: RequestEnvelope, params: ControllerCommitParams): JsonValue {
    this.requireOwner()
    const commandId = this.requireCommandId(envelope)
    const duplicate = this.ledger.get(commandId)
    if (duplicate !== undefined) return duplicate.result as JsonValue
    const result = this.requireController().commit(params, this.now())
    this.recordCommand(commandId, 'controller.commit', result as unknown as JsonValue)
    return result as unknown as JsonValue
  }

  private controllerCancel(envelope: RequestEnvelope, params: ControllerCancelParams): JsonValue {
    this.requireOwner()
    const commandId = this.requireCommandId(envelope)
    const duplicate = this.ledger.get(commandId)
    if (duplicate !== undefined) return duplicate.result as JsonValue
    const result = this.requireController().cancel(params, this.now())
    this.recordCommand(commandId, 'controller.cancel', result as unknown as JsonValue)
    return result as unknown as JsonValue
  }

  private controllerEvents(params: ControllerEventsParams): JsonValue {
    this.requireOwner()
    return this.requireController().events(params) as unknown as JsonValue
  }

  private requireController(): ControllerRuntime {
    if (this.controller === undefined) {
      throw p2Error('CONTROLLER_UNAVAILABLE', 'capability', 'this body has no controller host', {
        module: 'body.runtime',
      })
    }
    return this.controller
  }

  private commandGet(params: CommandGetParams): CommandRecord {
    this.requireOwner()
    const value = this.ledger.get(params.commandId)
    if (value === undefined) {
      throw p2Error(ErrorCodes.COMMAND_NOT_FOUND, 'validation', 'unknown command', { module: 'body.runtime' })
    }
    return {
      commandId: params.commandId,
      method: value.method,
      state: 'completed',
      ...(value.result === undefined ? {} : { result: value.result }),
      ...(value.error === undefined ? {} : { error: value.error }),
    }
  }

  private recordCommand(commandId: string, method: string, result: JsonValue): void {
    this.ledger.record(commandId, { method, result })
  }

  private requireCommandId(envelope: RequestEnvelope): string {
    if (envelope.commandId === undefined || envelope.commandId.length === 0) {
      return this.newCommandId()
    }
    return envelope.commandId
  }

  private async awaitQuery(outcome: QueryOutcome, timeoutMs = 1000): Promise<Exclude<QueryOutcome, { status: 'pending' }>> {
    let current = outcome
    const startedAt = this.now()
    while (current.status === 'pending') {
      if (this.now() - startedAt > timeoutMs) {
        return {
          status: 'failed',
          error: p2Error('QUERY_TIMEOUT', 'timeout', 'observation query timed out', { module: 'body.runtime' }),
        }
      }
      await new Promise(resolve => setTimeout(resolve, 5))
      current = current.poll()
    }
    return current
  }
}

export type { ProviderRuntimeStatus }






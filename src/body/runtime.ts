import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { BehaviorHost } from '../core/host.ts'
import { CheckerError } from '../core/checker.ts'
import { RegistryError } from '../core/registry.ts'

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
  HeartbeatParams,
  HelloParams,
  HelloResult,
  OwnerContext,
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
} from '../contracts/protocol.ts'
import { ErrorCodes } from '../contracts/types.ts'
import type { BodyEpoch, CommandId, JsonValue, P2Error, RunId } from '../contracts/types.ts'

export class BodyRuntime {
  readonly body: BodyInfo
  readonly bodyEpoch: BodyEpoch
  private behavior: BehaviorHost | undefined
  private owner: OwnerContext | null = null
  private initialized = false
  private closing = false
  private readonly commands = new Map<string, CommandRecord>()
  private readonly now: () => number
  private readonly heartbeatTimeoutMs: number | undefined
  private lastHeartbeatSeq = -1
  private lastHeartbeatAt = 0

  constructor(options: BodyRuntimeOptions & { behavior?: BehaviorHost }) {
    this.body = options.body
    this.bodyEpoch = (options.newEpoch?.() ?? randomUUID()) as BodyEpoch
    this.behavior = options.behavior
    this.owner = options.owner ?? null
    this.initialized = this.owner !== null
    this.now = options.now ?? Date.now
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs
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
      && envelope.method !== 'confirm') {
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
    const commandId = this.requireCommandId(envelope)
    if (typeof commandId !== 'string') return { ...base, error: commandId.error }
    const existing = this.commands.get(commandId)
    if (existing !== undefined) {
      if (existing.method !== envelope.method) return { ...base, error: duplicateCommand(commandId) }
      return existing.error === undefined
        ? { ...base, result: existing.result as JsonValue }
        : { ...base, error: existing.error }
    }
    const params = asRecord(envelope.params)
    if (params === undefined) return { ...base, error: invalidMessageError('params must be an object') }

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
          const checked = await this.behavior.check({
            sourcePath,
            ...(typeof params.sourceRoot === 'string' ? { sourceRoot: params.sourceRoot } : {}),
            ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
          })
          const result: CheckResult = {
            artifactId: checked.artifactId,
            definitionId: checked.artifact.definition.id,
            sourceDigest: checked.artifact.sourceDigest,
            bindingId: checked.artifact.bindingId,
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
            source: 'bridge',
            commandId,
          })
          const result: ConfirmationResult = confirmed
          this.recordCommand(commandId, 'confirm', result)
          return { ...base, result: result as unknown as JsonValue }
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
    return {
      bodyEpoch: this.bodyEpoch,
      owner: this.owner,
      health: this.closing ? 'faulted' : 'ready',
      connection: 'connected',
      activeRun: behavior?.activeRun ?? null,
      pendingConfirmation: behavior?.pendingConfirmation ?? null,
      bindingId: this.body.bindingId,
      capabilities: this.body.capabilities,
      provider: this.body.provider,
      commandCount: this.commands.size,
    }
  }

  tickBehavior(now = this.now()): string | undefined {
    return this.behavior?.tick(now)
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
      return { ...base, result: this.helloResult(params.value.owner) }
    }

    this.owner = params.value.owner
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


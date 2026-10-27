import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

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
  CommandRecord,
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
} from '../contracts/protocol.ts'
import { ErrorCodes } from '../contracts/types.ts'
import type { BodyEpoch, CommandId, JsonValue, P2Error, RunId } from '../contracts/types.ts'

export class BodyRuntime {
  readonly body: BodyInfo
  readonly bodyEpoch: BodyEpoch
  private owner: OwnerContext | null = null
  private initialized = false
  private closing = false
  private readonly commands = new Map<string, CommandRecord>()
  private readonly now: () => number
  private readonly heartbeatTimeoutMs: number | undefined
  private lastHeartbeatSeq = -1
  private lastHeartbeatAt = 0

  constructor(options: BodyRuntimeOptions) {
    this.body = options.body
    this.bodyEpoch = (options.newEpoch?.() ?? randomUUID()) as BodyEpoch
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
    return {
      bodyEpoch: this.bodyEpoch,
      owner: this.owner,
      health: this.closing ? 'faulted' : 'ready',
      connection: 'connected',
      activeRun: null,
      bindingId: this.body.bindingId,
      capabilities: this.body.capabilities,
      provider: this.body.provider,
      commandCount: this.commands.size,
    }
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


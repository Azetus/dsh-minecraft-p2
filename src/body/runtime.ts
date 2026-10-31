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
  BodyInfo,
  DescribeResult,
  HeartbeatParams,
  HeartbeatResult,
  HelloParams,
  HelloResult,
  MindStatusView,
  OwnerContext,
  ProviderRuntimeStatus,
  RequestEnvelope,
  ResponseEnvelope,
  StatusResult,
} from '../contracts/protocol.ts'
import { ErrorCodes } from '../contracts/types.ts'
import type { BodyEpoch, JsonValue, P2Error } from '../contracts/types.ts'

export type BodyRuntimeOptions = {
  body: BodyInfo
  owner?: OwnerContext
  heartbeatTimeoutMs?: number
  now?: () => number
  newEpoch?: () => string
  /** Live provider state; absent when the body was started without a provider. */
  providerStatus?: () => ProviderRuntimeStatus
  /** P2Mind loop; absent without a provider. */
  mind?: { tick(): void; status(): MindStatusView }
}

/**
 * Body-side lifecycle and health surface. Game access belongs to the provider
 * and (after M0-02/M0-03) to the ClientPort adapter; P2Mind is not wired yet.
 */
export class BodyRuntime {
  private readonly body: BodyInfo
  private readonly now: () => number
  private readonly heartbeatTimeoutMs: number | undefined
  private readonly providerStatus: (() => ProviderRuntimeStatus) | undefined
  private readonly mind: { tick(): void; status(): MindStatusView } | undefined
  private owner: OwnerContext | undefined
  private lastHeartbeatAt = 0
  private closing = false
  readonly bodyEpoch: BodyEpoch
  readonly leaseTimeoutMs: number | undefined

  constructor(options: BodyRuntimeOptions) {
    this.body = options.body
    this.now = options.now ?? (() => Date.now())
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs
    this.leaseTimeoutMs = options.heartbeatTimeoutMs
    this.providerStatus = options.providerStatus
    this.mind = options.mind
    this.bodyEpoch = (options.newEpoch?.() ?? randomUUID()) as BodyEpoch
    if (options.owner !== undefined) {
      this.owner = options.owner
      this.lastHeartbeatAt = this.now()
    }
  }

  get isClosing(): boolean {
    return this.closing
  }

  /** Heartbeat lease check; false means the owner lease expired. */
  checkHeartbeat(now = this.now()): boolean {
    if (this.heartbeatTimeoutMs === undefined) return true
    if (this.owner === undefined) return true
    return now - this.lastHeartbeatAt <= this.heartbeatTimeoutMs
  }

  /** One 50 ms mind step; a providerless body has nothing to advance. */
  tick(): void {
    this.mind?.tick()
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
      const result = this.dispatch(envelope)
      return { protocol: 1, requestId, bodyEpoch: this.bodyEpoch, result }
    } catch (error) {
      return { protocol: 1, requestId, bodyEpoch: this.bodyEpoch, error: normalizeError(error) }
    }
  }

  private dispatch(envelope: RequestEnvelope): JsonValue {
    const params = isRecord(envelope.params) ? envelope.params : {}
    switch (envelope.method) {
      case 'hello': return this.hello(params) as unknown as JsonValue
      case 'heartbeat': return this.heartbeat(params as unknown as HeartbeatParams) as unknown as JsonValue
      case 'describe': return this.describe() as unknown as JsonValue
      case 'status': return this.status() as unknown as JsonValue
      case 'shutdown':
        this.closing = true
        return { closing: true }
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
    if (this.owner !== undefined
      && (this.owner.sessionId !== params.owner.sessionId || this.owner.agentId !== params.owner.agentId)) {
      throw p2Error(ErrorCodes.INVALID_OWNER, 'validation', 'owner is already initialized', { module: 'body.runtime' })
    }
    this.owner = params.owner
    this.lastHeartbeatAt = this.now()
    return {
      protocolVersion: PROTOCOL_VERSION,
      bodyEpoch: this.bodyEpoch,
      body: {
        version: this.body.manifest.bodyVersion,
        protocolVersion: PROTOCOL_VERSION,
        manifestDigest: this.body.manifestDigest,
      },
      owner: params.owner,
      bindingId: this.body.bindingId,
      capabilities: this.body.capabilities,
      provider: this.body.provider,
    }
  }

  private heartbeat(params: HeartbeatParams): HeartbeatResult {
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
    const providerState = this.providerStatus?.()
    return {
      bodyEpoch: this.bodyEpoch,
      version: this.body.manifest.bodyVersion,
      owner: this.owner ?? null,
      health: 'ready',
      connection: providerState?.connected === true ? 'connected' : 'disconnected',
      bindingId: this.body.bindingId,
      capabilities: this.body.capabilities,
      provider: this.body.provider,
      ...(providerState === undefined ? {} : { providerState }),
      ...(this.mind === undefined ? {} : { mind: this.mind.status() }),
    }
  }
}

function normalizeError(error: unknown): P2Error {
  return asP2Error(error) ?? p2Error(
    ErrorCodes.INTERNAL_ERROR,
    'runtime',
    error instanceof Error ? error.message : String(error),
    { module: 'body.runtime' },
  )
}

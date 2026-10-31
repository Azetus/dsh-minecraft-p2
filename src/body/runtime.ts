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
  ChatPollResult,
  ChatSayResult,
  DescribeResult,
  HeartbeatParams,
  HeartbeatResult,
  HelloParams,
  HelloResult,
  MindCancelResult,
  MindEventsParams,
  MindEventsResult,
  MindOrderResult,
  MindOrdersResult,
  MindReportResult,
  MindStatusView,
  OwnerContext,
  PerceptionNotice,
  PerceptionPollResult,
  ProviderRuntimeStatus,
  RequestEnvelope,
  ResponseEnvelope,
  StatusResult,
  WorldEntitiesResult,
  WorldObserveResult,
} from '../contracts/protocol.ts'
import { ErrorCodes } from '../contracts/types.ts'
import type { BodyEpoch, JsonValue, P2Error } from '../contracts/types.ts'
import type { ClientPort } from '../port/index.ts'
import { boxAround } from '../mind/sensors.ts'
import { feetOf, HOSTILE_NAMES } from '../mind/givers/common.ts'
import { previewBlueprint } from './blueprint-preview.ts'
import type { BlueprintPreview } from './blueprint-preview.ts'
import { observeEntities } from './entities.ts'
import type { MindRuntime } from './mind.ts'
import { observeWorld } from './observe.ts'

export type BodyRuntimeOptions = {
  body: BodyInfo
  owner?: OwnerContext
  heartbeatTimeoutMs?: number
  now?: () => number
  newEpoch?: () => string
  /** Live provider state; absent when the body was started without a provider. */
  providerStatus?: () => ProviderRuntimeStatus
  /** P2Mind loop; absent without a provider. */
  mind?: MindRuntime
  /** Read-only provider view for `world.observe`; absent without a provider. */
  port?: ClientPort
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
  private readonly mind: MindRuntime | undefined
  private readonly port: ClientPort | undefined
  private readonly chatMessages: Array<{ seq: number; at: number; username: string; message: string }> = []
  private chatSeq = 0
  private readonly perceptionNotices: PerceptionNotice[] = []
  private perceptionSeq = 0
  private lastHealth: number | undefined
  private lastDamageNoticeAt = Number.NEGATIVE_INFINITY
  private readonly lastBlockNotice = new Map<string, number>()
  private readonly nearHostiles = new Set<string>()
  private readonly lastHostileNotice = new Map<string, number>()
  private readonly entityTimer: ReturnType<typeof setInterval> | undefined
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
    this.port = options.port
    if (this.port !== undefined && typeof this.port.on === 'function') {
      this.port.on('chat', payload => this.recordChat(payload))
      this.port.on('damaged', payload => this.recordDamaged(payload))
      this.port.on('died', () => this.recordDied())
      this.port.on('blockUpdated', payload => this.recordBlockUpdate(payload))
      try {
        this.lastHealth = this.port.self().health
      } catch {
        this.lastHealth = undefined
      }
      this.entityTimer = setInterval(() => this.sampleHostiles(), 500)
      this.entityTimer.unref?.()
    }
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
      case 'world.observe': return this.worldObserve(params) as unknown as JsonValue
      case 'world.entities': return this.worldEntities(params) as unknown as JsonValue
      case 'blueprint.preview': return this.blueprintPreview(params) as unknown as JsonValue
      case 'chat.poll': return this.chatPoll(params) as unknown as JsonValue
      case 'chat.say': return this.chatSay(params) as unknown as JsonValue
      case 'perception.poll': return this.perceptionPoll(params) as unknown as JsonValue
      case 'mind.order': return this.mindOrder(params) as unknown as JsonValue
      case 'mind.orders': return this.mindOrders() as unknown as JsonValue
      case 'mind.cancel': return this.mindCancel(params) as unknown as JsonValue
      case 'mind.report': return this.mindReport() as unknown as JsonValue
      case 'mind.events': return this.mindEvents(params as unknown as MindEventsParams) as unknown as JsonValue
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

  private mindOrder(params: Record<string, JsonValue>): MindOrderResult {
    this.requireOwner()
    return this.requireMind().enqueueOrder(params)
  }

  private worldObserve(params: Record<string, JsonValue>): WorldObserveResult {
    this.requireOwner()
    if (this.port === undefined) {
      throw p2Error(
        ErrorCodes.NOT_INITIALIZED,
        'runtime',
        'body has no provider to observe',
        { module: 'body.runtime' },
      )
    }
    return observeWorld(this.port, params, this.now())
  }

  private worldEntities(params: Record<string, JsonValue>): WorldEntitiesResult {
    this.requireOwner()
    if (this.port === undefined) {
      throw p2Error(
        ErrorCodes.NOT_INITIALIZED,
        'runtime',
        'body has no provider to observe',
        { module: 'body.runtime' },
      )
    }
    return observeEntities(this.port, params, this.now())
  }

  private blueprintPreview(params: Record<string, JsonValue>): BlueprintPreview {
    this.requireOwner()
    if (this.port === undefined) {
      throw p2Error(
        ErrorCodes.NOT_INITIALIZED,
        'runtime',
        'body has no provider to observe',
        { module: 'body.runtime' },
      )
    }
    return previewBlueprint(this.port, params.blueprint, this.now())
  }

  private recordChat(payload: JsonValue): void {
    if (!isRecord(payload)) return
    const username = payload.username
    const message = payload.message
    if (typeof username !== 'string' || typeof message !== 'string') return
    if (username.length === 0 || message.length === 0) return
    this.chatSeq += 1
    this.chatMessages.push({ seq: this.chatSeq, at: this.now(), username, message })
    while (this.chatMessages.length > 100) this.chatMessages.shift()
  }

  private chatPoll(params: Record<string, JsonValue>): ChatPollResult {
    this.requireOwner()
    const afterSeq = typeof params.afterSeq === 'number' ? Math.floor(params.afterSeq) : 0
    if (afterSeq < 0) {
      throw p2Error(ErrorCodes.INVALID_MESSAGE, 'validation', 'afterSeq must be non-negative', {
        module: 'body.runtime',
      })
    }
    return {
      messages: this.chatMessages.filter(message => message.seq > afterSeq),
      seq: this.chatSeq,
    }
  }

  private chatSay(params: Record<string, JsonValue>): ChatSayResult {
    this.requireOwner()
    if (this.port === undefined) {
      throw p2Error(ErrorCodes.NOT_INITIALIZED, 'runtime', 'body has no provider to chat', {
        module: 'body.runtime',
      })
    }
    const text = params.text
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > 256) {
      throw p2Error(ErrorCodes.INVALID_MESSAGE, 'validation', 'chat.say requires text (1..256)', {
        module: 'body.runtime',
      })
    }
    try {
      this.port.say(text)
      return { sent: true }
    } catch (error) {
      throw p2Error(
        'CHAT_SEND_FAILED',
        'runtime',
        error instanceof Error ? error.message : String(error),
        { module: 'body.runtime' },
      )
    }
  }

  private recordDamaged(payload: JsonValue): void {
    if (!isRecord(payload) || typeof payload.health !== 'number') return
    const health = payload.health
    const previous = this.lastHealth
    this.lastHealth = health
    if (previous !== undefined && health >= previous) return
    const at = this.now()
    if (at - this.lastDamageNoticeAt < 1_000 && health > 4) return
    this.lastDamageNoticeAt = at
    this.pushNotice({
      kind: 'damaged',
      severity: health <= 4 ? 'critical' : 'warning',
      key: 'damaged',
      summary: `health ${previous ?? '?'} -> ${health}`,
      data: { health, previous: previous ?? null },
    })
  }

  private recordDied(): void {
    this.pushNotice({
      kind: 'died',
      severity: 'critical',
      key: 'died',
      summary: 'the body died',
    })
  }

  private recordBlockUpdate(payload: JsonValue): void {
    if (!isRecord(payload)) return
    if (typeof payload.x !== 'number' || typeof payload.y !== 'number' || typeof payload.z !== 'number') return
    if (typeof payload.name !== 'string') return
    const mind = this.mind
    if (mind === undefined) return
    const pos = { x: payload.x, y: payload.y, z: payload.z }
    const expected = mind.watchedBlock(pos)
    if (expected === undefined || expected === payload.name) return
    const key = `task-block:${pos.x},${pos.y},${pos.z}`
    const at = this.now()
    const last = this.lastBlockNotice.get(key)
    if (last !== undefined && at - last < 5_000) return
    this.lastBlockNotice.set(key, at)
    this.pushNotice({
      kind: 'task-block',
      severity: 'warning',
      key,
      summary: `watched block ${pos.x},${pos.y},${pos.z} expected ${expected}, now ${payload.name}`,
      data: { ...pos, expected, actual: payload.name },
    })
  }

  private sampleHostiles(): void {
    if (this.port === undefined) return
    try {
      const self = this.port.self()
      const feet = feetOf(self.pos)
      const entities = this.port.entities(boxAround(feet, 8, 3))
      const current = new Set<string>()
      for (const entity of entities) {
        if (!HOSTILE_NAMES.has(entity.name)) continue
        current.add(entity.id)
        if (this.nearHostiles.has(entity.id)) continue
        const at = this.now()
        const last = this.lastHostileNotice.get(entity.id)
        if (last !== undefined && at - last < 30_000) continue
        this.lastHostileNotice.set(entity.id, at)
        this.pushNotice({
          kind: 'hostile-near',
          severity: 'warning',
          key: `hostile:${entity.id}`,
          summary: `hostile ${entity.name} within 8 blocks at ${Math.floor(entity.position.x)},${Math.floor(entity.position.y)},${Math.floor(entity.position.z)}`,
          data: { id: entity.id, name: entity.name, position: entity.position },
        })
      }
      this.nearHostiles.clear()
      for (const id of current) this.nearHostiles.add(id)
    } catch {
      // Perception sampling must never break the request loop.
    }
  }

  private pushNotice(notice: Omit<PerceptionNotice, 'seq' | 'at'>): void {
    this.perceptionSeq += 1
    this.perceptionNotices.push({ ...notice, seq: this.perceptionSeq, at: this.now() })
    while (this.perceptionNotices.length > 100) this.perceptionNotices.shift()
  }

  private perceptionPoll(params: Record<string, JsonValue>): PerceptionPollResult {
    this.requireOwner()
    const afterSeq = typeof params.afterSeq === 'number' ? Math.floor(params.afterSeq) : 0
    if (afterSeq < 0) {
      throw p2Error(ErrorCodes.INVALID_MESSAGE, 'validation', 'afterSeq must be non-negative', {
        module: 'body.runtime',
      })
    }
    return {
      notices: this.perceptionNotices.filter(notice => notice.seq > afterSeq),
      seq: this.perceptionSeq,
    }
  }

  private mindOrders(): MindOrdersResult {
    this.requireOwner()
    return this.requireMind().listOrders()
  }

  private mindCancel(params: Record<string, JsonValue>): MindCancelResult {
    this.requireOwner()
    if (typeof params.id !== 'string' || params.id.length === 0) {
      throw p2Error('INVALID_MESSAGE', 'validation', 'mind.cancel requires an order id', { module: 'body.runtime' })
    }
    return this.requireMind().cancelOrder(params.id)
  }

  private mindReport(): MindReportResult {
    this.requireOwner()
    return { report: this.requireMind().report() }
  }

  private mindEvents(params: MindEventsParams): MindEventsResult {
    this.requireOwner()
    const sinceSeq = typeof params.sinceSeq === 'number' ? Math.max(0, Math.floor(params.sinceSeq)) : 0
    const limit = typeof params.limit === 'number'
      ? Math.max(1, Math.min(500, Math.floor(params.limit)))
      : 100
    return this.requireMind().sinceEvents(sinceSeq, limit)
  }

  private requireMind(): MindRuntime {
    if (this.mind === undefined) {
      throw p2Error('MIND_UNAVAILABLE', 'capability', 'this body has no P2Mind runtime', {
        module: 'body.runtime',
      })
    }
    return this.mind
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

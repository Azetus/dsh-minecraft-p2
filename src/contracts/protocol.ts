import type {
  BindingId,
  BodyEpoch,
  BodyManifest,
  JsonValue,
  P2Error,
} from './types.ts'
import { ErrorCodes } from './types.ts'

export const PROTOCOL_VERSION = 1
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024

/**
 * Body/bridge control plane: lifecycle, health, order and observation methods.
 */
export const METHODS = [
  'hello',
  'heartbeat',
  'describe',
  'status',
  'world.observe',
  'world.entities',
  'blueprint.preview',
  'chat.poll',
  'chat.say',
  'perception.poll',
  'mind.order',
  'mind.orders',
  'mind.cancel',
  'mind.report',
  'mind.events',
  'shutdown',
] as const

export type OwnerContext = {
  sessionId: string
  agentId: string
  cwd: string
}

export type RequestEnvelope = {
  protocol: 1
  requestId: string
  method: string
  bodyEpoch?: string
  params: JsonValue
}

export type ResponseEnvelope = {
  protocol: 1
  requestId: string
  bodyEpoch: string
  result?: JsonValue
  error?: P2Error
}

export type HelloParams = {
  protocols: number[]
  owner: OwnerContext
}

export type HelloResult = {
  protocolVersion: number
  bodyEpoch: BodyEpoch
  body: {
    version: string
    protocolVersion: number
    manifestDigest: string
  }
  owner: OwnerContext
  bindingId: BindingId | null
  capabilities: string[]
  provider: ProviderSummary | null
}

export type ProviderSummary = {
  id: string
  version: string
  capabilities: string[]
}

/** Live server-observation state maintained by the provider. */
export type ProviderRuntimeStatus = {
  connected: boolean
  paused: boolean
  serverAge: number | null
  idleMs: number
  /** Provider-visible control release state for the current handle. */
  controlState?: 'idle' | 'active' | 'unknown'
  /** `best-effort` means stop was issued but release could not be confirmed. */
  controlRelease?: 'confirmed' | 'best-effort' | null
  /** Wall-clock time of the last observed bot death, when any. */
  lastDeathAt?: number | null
  /** Where the bot died, when the provider observed it. */
  lastDeathPosition?: { x: number; y: number; z: number } | null
  /** Diagnostics used to tell server pause, client stall and our loop lag apart. */
  pauseDiagnostics?: PauseDiagnostics
}

export type PauseDiagnostics = {
  /** Wall-clock time the current suspension was first observed. */
  suspendedSince?: number
  /** How many distinct server ages were observed in this connection. */
  ageChanges: number
  /** `update_time` packets observed (or age changes when the event is absent). */
  timePackets: number
  /** Worst delay of the 250 ms watchdog interval, a proxy for a blocked loop. */
  eventLoopLagMs: number
  /** Wall-clock ms since the last age change. */
  ageIdleMs: number
  /** Best explanation consistent with the counters. */
  verdict: 'running' | 'server-paused' | 'client-stalled' | 'event-loop-blocked' | 'unknown'
  /** Current world age and the wall clock when it was sampled. */
  lastAgeAt: number
  lastAge: number | null
}

/** Provider-reported pause transition; a pause is never an action failure. */
export type SuspensionState = {
  suspended: boolean
  at: number
  idleMs: number
  serverAge: number | null
  diagnostics: PauseDiagnostics
}

export type DescribeResult = {
  protocolVersion: number
  body: {
    version: string
    protocolVersion: number
    manifestDigest: string
  }
  bindingId: BindingId | null
  capabilities: string[]
  provider: ProviderSummary | null
}

export type DutyStatusView = {
  id: string
  kind: string
  item: string
  quota: number
  collected: number
  jobs: number
  state: 'active' | 'completed' | 'blocked' | 'stopped'
  startedAt: number
  deadline?: number
  lastError?: string
}

export type MindMetricsView = {
  orders: { accepted: number; succeeded: number; failed: number; blocked: number; cancelled: number }
  jobs: { started: number; succeeded: number; failed: number; interrupted: number; retried: number; preempted: number }
  holds: number
  holdReasons: Record<string, number>
  failureCodes: Record<string, number>
  completionRate: number | null
  lastFailure: { code: string; category: string; hint: string } | null
  updatedAt: number
}

export type MindStatusView = {
  tracker: 'idle' | 'starting' | 'running' | 'stopping' | 'fault'
  job: { runId: string; driverId: string } | null
  fault: { code: string; since: number } | null
  home: { x: number; y: number; z: number } | null
  activeOrder: { id: string; verb: string } | null
  queuedOrders: number
  eventsSeq: number
  /** The provider paused the server; work is frozen, not failed. */
  suspended?: boolean
  plan?: {
    id: string
    template: string
    satisfied: boolean
    blocked: boolean
    /** Current build stage (1..5), when the plan is staged. */
    stage?: number
    total?: number
    done?: number
  } | null
  duty?: DutyStatusView | null
  metrics?: MindMetricsView
}

export type StatusResult = {
  bodyEpoch: BodyEpoch
  /** Package/body version from body.manifest.json. */
  version: string
  owner: OwnerContext | null
  health: 'ready' | 'faulted'
  connection: 'connected' | 'disconnected'
  bindingId: BindingId | null
  capabilities: string[]
  provider: ProviderSummary | null
  providerState?: ProviderRuntimeStatus | null
  /** P2Mind state; null when this body has no provider/mind. */
  mind?: MindStatusView | null
}

export type HeartbeatParams = { seq: number }
export type HeartbeatResult = { seq: number; alive: true }

export const OBSERVE_MAX_BLOCKS = 4096
export const OBSERVE_MAX_AXIS = 64

export type ObserveVec3 = { x: number; y: number; z: number }

export type WorldObserveParams = {
  /** Box query; provide min+max, or `points` instead. */
  min?: ObserveVec3
  max?: ObserveVec3
  /** Targeted query (1..256 unique points); no box, no entities. */
  points?: ObserveVec3[]
  includeEntities?: boolean
  /** Box detail level; ignored for a points query. */
  detail?: 'blocks' | 'counts' | 'surface'
  /** Block names to include in the blocks view; unknown cells stay visible. */
  only?: string[]
  /** Omit loaded air from the blocks view. */
  excludeAir?: boolean
}

export type WorldObserveBlock = {
  x: number
  y: number
  z: number
  name: string
  loaded: boolean
  /** Provider collision hint; undefined when the adapter cannot tell. */
  solid?: boolean
  state?: Record<string, string>
}

export type WorldObserveCounts = {
  total: number
  loaded: number
  unloaded: number
  byName: Record<string, number>
}

export type WorldObserveSurface = {
  x: number
  z: number
  /** Highest non-air block (includes plants/fluids); null when all air. */
  y: number | null
  name: string | null
  /** Highest block with a collision box (ground/structure); null if none. */
  solidY: number | null
  solidName: string | null
  /** false when any cell in the column is unloaded: the surface is unknown. */
  loaded: boolean
}

export type WorldObserveResult = {
  at: number
  mode: 'box' | 'points'
  detail: 'blocks' | 'counts' | 'surface' | 'points'
  box?: { min: ObserveVec3; max: ObserveVec3 }
  self: {
    pos: ObserveVec3
    yaw: number
    pitch: number
    health: number
    food: number
    onGround: boolean
    inWater: boolean
    inLava: boolean
  }
  inventory: Array<{ slot: number; name: string; count: number }>
  time: { timeOfDay: number; worldAge: number }
  /** Biome at the body position; null when the adapter cannot tell. */
  biome?: { id: number; name: string } | null
  /** Present for detail=blocks / points; includes loaded:false cells. */
  blocks?: WorldObserveBlock[]
  counts?: WorldObserveCounts
  surface?: WorldObserveSurface[]
  entities?: Array<{ id: string; name: string; position: ObserveVec3 }>
}

export const ENTITIES_MAX_RADIUS = 160
export const ENTITIES_MAX_LIMIT = 512

export type WorldEntitiesParams = {
  /** Defaults to the body position. */
  center?: ObserveVec3
  /** Defaults to 64; capped at 160 (server tracking range still applies). */
  radius?: number
  /** Entity categories such as animal/hostile/player/other. */
  types?: string[]
  /** Entity names such as sheep/item; max 32. */
  names?: string[]
  /** Defaults to 128. */
  limit?: number
}

export type WorldEntityView = {
  id: string
  name: string
  type?: string
  kind?: string
  username?: string
  /** Dropped item stack when the adapter could resolve it. */
  item?: { name: string; count: number }
  position: ObserveVec3
  distance: number
}

export type WorldEntitiesResult = {
  at: number
  center: ObserveVec3
  radius: number
  /** Matches before limit; entities is sorted by distance. */
  total: number
  entities: WorldEntityView[]
}

export type ShutdownResult = { closing: true }

export type MindOrderView = {
  id: string
  verb: string
  state: string
  attempts?: number
  lastCode?: string
  blockedKeys?: string[]
  /** Set for a timed hold that is active. */
  expiresAt?: number
}

export type MindQueueSummary = {
  active: { id: string; verb: string } | null
  queued: number
  /** Active order that will keep a newly queued order from starting. */
  blockedBy?: { id: string; verb: string }
  /** True when the accepted order itself is the active hold barrier. */
  holdsActiveSlot?: boolean
  /** Orders already queued behind an active hold. */
  queuedBehind?: number
  /** Explicit release instruction for a hold barrier. */
  release?: string
  /** Wall-clock expiry of a timed hold (ms since epoch). */
  expiresAt?: number
}

export type MindOrderResult = {
  id: string
  state: string
  queue?: MindQueueSummary
}

export type MindOrdersResult = {
  active: MindOrderView | null
  queued: MindOrderView[]
  /** Set when the active order is a barrier that never finishes by itself. */
  queueBlockedBy: { id: string; verb: string } | null
}

export type MindCancelResult = { id: string; state: string; cancelled?: number }

export type MindReportResult = { report: JsonValue | null }

export type MindEventsParams = { sinceSeq?: number; limit?: number }

export type MindEventsResult = {
  events: Array<{ seq: number; at: number; kind: string; data: JsonValue }>
  seq: number
}

export type ChatMessage = {
  seq: number
  at: number
  username: string
  message: string
}

export type ChatPollParams = { afterSeq?: number }
export type ChatPollResult = { messages: ChatMessage[]; seq: number }
export type ChatSayParams = { text: string }
export type ChatSayResult = { sent: true }

export type PerceptionNotice = {
  seq: number
  at: number
  kind: 'damaged' | 'died' | 'task-block' | 'hostile-near'
  severity: 'info' | 'warning' | 'critical'
  key: string
  summary: string
  data?: JsonValue
}

export type PerceptionPollParams = { afterSeq?: number }
export type PerceptionPollResult = { notices: PerceptionNotice[]; seq: number }

export type BodyInfo = {
  manifest: BodyManifest
  manifestDigest: string
  bindingId: BindingId | null
  capabilities: string[]
  provider: ProviderSummary | null
}

export function p2Error(
  code: string,
  category: P2Error['category'],
  message: string,
  source: P2Error['source'] = { module: 'p2' },
  details?: JsonValue,
): P2Error {
  const error: P2Error = { code, category, message, source, retry: 'never' }
  if (details !== undefined) error.details = details
  return error
}

export function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Recognize a P2Error value thrown across a host boundary. */
export function asP2Error(value: unknown): P2Error | undefined {
  if (!isRecord(value)) return undefined
  const { code, category, message, retry, source } = value
  if (typeof code !== 'string'
    || typeof category !== 'string'
    || typeof message !== 'string'
    || typeof retry !== 'string'
    || !isRecord(source)) {
    return undefined
  }
  return value as unknown as P2Error
}

export function isOwnerContext(value: unknown): value is OwnerContext {
  return isRecord(value)
    && typeof value.sessionId === 'string'
    && typeof value.agentId === 'string'
    && typeof value.cwd === 'string'
}

export function unsupportedProtocolError(protocols: number[]): P2Error {
  return p2Error(
    ErrorCodes.UNSUPPORTED_PROTOCOL,
    'validation',
    `unsupported protocol: ${protocols.join(', ')}`,
    { module: 'body.protocol' },
    { supported: [PROTOCOL_VERSION] },
  )
}

export function invalidMessageError(message: string, details?: JsonValue): P2Error {
  return p2Error(ErrorCodes.INVALID_MESSAGE, 'validation', message, { module: 'body.protocol' }, details)
}

export function unknownMethodError(method: string): P2Error {
  return p2Error(
    ErrorCodes.UNKNOWN_METHOD,
    'validation',
    `unknown method: ${method}`,
    { module: 'body.protocol' },
    { method },
  )
}

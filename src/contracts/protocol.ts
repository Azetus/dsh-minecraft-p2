import type {
  BindingId,
  BodyEpoch,
  BodyManifest,
  CommandId,
  JsonValue,
  P2Error,
  ValueMeta,
} from './types.ts'
import { ErrorCodes } from './types.ts'

export const PROTOCOL_VERSION = 1
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024

/**
 * Controller-only control plane. There is no behavior run, switch, guard or
 * confirmation method: autonomous action is `controller.enable` + strategies,
 * and stopping it is `controller.disable` / `controller.cancel`.
 */
export const METHODS = [
  'hello',
  'heartbeat',
  'describe',
  'status',
  'observe',
  'check',
  'activate',
  'watch.add',
  'watch.remove',
  'watch.list',
  'snapshot',
  'card',
  'rescue',
  'controller.enable',
  'controller.disable',
  'controller.status',
  'controller.install',
  'controller.commit',
  'controller.cancel',
  'controller.events',
  'shutdown',
  'command.get',
] as const

export type Method = (typeof METHODS)[number]

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
  commandId?: string
  params: JsonValue
}

export type ResponseEnvelope = {
  protocol: 1
  requestId: string
  bodyEpoch: string
  result?: JsonValue
  error?: P2Error
}

export type EventEnvelope = {
  protocol: 1
  bodyEpoch: string
  seq: number
  eventId: string
  kind: string
  data: JsonValue
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
}

/** Developer-mode external operation hook state. */
export type DevOpsStatus = {
  enabled: boolean
  path: string
  generation: number
  operations: string[]
  lastError: string | null
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

/** One query a watch declares; sampled by the host, never by content. */
export type WatchQuery = {
  op: string
  args?: JsonValue
}

export type WatchEdge = 'rising' | 'falling' | 'both'
export type WatchState = 'active' | 'error' | 'expired'

/** Observation-only notification registration; it has no control capability. */
export type WatchStatus = {
  id: string
  name: string | null
  priority: number
  state: WatchState
  queries: WatchQuery[]
  predicate: string
  edge: WatchEdge
  cooldownMs: number
  armedAt: number
  expiresAt: number
  lastFire: number | null
  lastKey: string | null
  suppressed: number
  dropped: number
  lastError?: P2Error
}

export type WatchEvent = {
  seq: number
  watchId: string
  key: string | null
  summary: string | null
  evidence?: JsonValue
  firedAt: number
  /** Cumulative dropped count for this watch at emission time. */
  dropped: number
}

export type ControllerMode = 'off' | 'active' | 'disabling' | 'fault'

export type ControllerStrategyView = {
  key: string
  slot: string
  state: string
  installedVersion: string
  activeVersion: string
  attemptId: string
  hazardClass?: string
}

export type ControllerEventView = {
  seq: number
  at: number
  kind: string
  slot?: string
  strategyKey?: string
  commitmentId?: string
  detail?: string
  data?: JsonValue
}

export type ControllerCommitmentView = {
  id: string
  goal: string
  strategyKey: string
  state: string
  deadline: number
  checkpoint: JsonValue
  suspendedAt?: number
  suspendReason?: string
  blocked?: JsonValue
  evidence: JsonValue[]
}

export type ControllerView = {
  mode: ControllerMode
  enabledAt: number | null
  phase: string | null
  lease: JsonValue
  action: JsonValue
  decision: JsonValue
  commitment: ControllerCommitmentView | null
  commitments: ControllerCommitmentView[]
  strategies: ControllerStrategyView[]
  verification: JsonValue
  stall: JsonValue
  memory: JsonValue
  degraded: string[]
  /** Most recent events (bounded); use controller.events for a cursor. */
  events: ControllerEventView[]
  eventSeq: number
}

export type ControllerInstallResult = {
  key: string
  status: string
  attemptId: string
  installedVersion: string
  activeVersion: string
  state: string
}

export type ControllerInstallParams = {
  artifactId: string
  mode?: 'boundary' | 'interrupt'
}

export type ControllerCommitParams = {
  id?: string
  kind?: 'task' | 'standing'
  goal: string
  strategyKey: string
  post: JsonValue
  baselineKeys?: string[]
  deadlineMs?: number
  checkpoint?: JsonValue
}

export type ControllerCancelParams = {
  commitmentId?: string
  reason?: string
}

export type ControllerEventsParams = {
  sinceSeq?: number
  limit?: number
}

export type ControllerEventsResult = {
  events: ControllerEventView[]
  seq: number
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
  commandCount: number
  watches?: WatchStatus[]
  watchEvents?: WatchEvent[]
  watchEventSeq?: number
  /** Experiment-only rescue channel state; null when the body has no provider. */
  rescue?: { enabled: boolean; tpRadius: number } | null
  /** Developer-mode external operations; null when the hook is disabled. */
  devOps?: DevOpsStatus | null
  /** P2Controller state; null when the body has no controller host. */
  controller?: ControllerView | null
  loggingUnavailable?: boolean
  droppedLogCount?: number
}

export type CheckParams = {
  sourcePath: string
  sourceRoot?: string
  timeoutMs?: number
  artifactKind?: 'act' | 'policy' | 'op' | 'strategy'
}

export type ObserveParams = {
  op: string
  args?: Record<string, JsonValue>
}

export type ObserveResult = {
  op: string
  value: JsonValue
  meta?: ValueMeta
}

export type SnapshotOp = {
  key: string
  op: string
  args?: JsonValue
}

export type SnapshotParams = {
  ops: SnapshotOp[]
  timeoutMs?: number
}

export type SnapshotPart = {
  key: string
  op: string
  status: 'ok' | 'failed' | 'pending'
  value?: JsonValue
  meta?: ValueMeta
  error?: P2Error
  /** Bridge-side pure summary (inventory counts, entity hostility). */
  summary?: JsonValue
}

export type SnapshotResult = {
  parts: SnapshotPart[]
  /** True when at least one part did not complete successfully. */
  partial: boolean
  sampledAt: number
}

export type CardParams = {
  timeoutMs?: number
  /** Hostile entity search radius (default 16). */
  radius?: number
}

/** Compact projection for high-frequency polling; no new query semantics. */
export type CardResult = {
  bodyEpoch: BodyEpoch
  health: 'ready' | 'faulted'
  connection: 'connected' | 'disconnected'
  healthValue: number | null
  food: number | null
  position: { x: number; y: number; z: number } | null
  /** Null means hostile count could not be established (not zero). */
  hostiles: number | null
  watches: { active: number; error: number }
  provider: ProviderRuntimeStatus | null
  sampledAt: number
}

export type CheckResult = {
  artifactId: string
  definitionId: string
  sourceDigest: string
  bindingId: string
  kind: 'act' | 'policy' | 'op' | 'strategy'
  enabled: false
}

export type ActivateParams = {
  artifactId: string
}

export type ActivateResult = {
  artifactId: string
  bindingId: string
  enabled: true
}

export type RescueAction = 'tp' | 'effect' | 'respawn'

export type RescueParams = {
  action: RescueAction
  x?: number
  y?: number
  z?: number
  effect?: 'instant_health' | 'regeneration' | 'saturation'
  durationSeconds?: number
  amplifier?: number
  reason: string
  category: 'stuck' | 'trapped' | 'death_loop' | 'health' | 'food' | 'other'
}

export type RescueResult = {
  auditId: string
  command: string
  sent: true
  before: { position: JsonValue; health: JsonValue }
  note: string
}

export type HeartbeatParams = { seq: number }
export type HeartbeatResult = { seq: number; alive: true }

export type ShutdownResult = { closing: true }

export type CommandGetParams = { commandId: CommandId }

export type CommandState =
  | 'accepted'
  | 'pending'
  | 'completed'
  | 'rejected'
  | 'superseded'

export type CommandRecord = {
  commandId: CommandId
  method: string
  state: CommandState
  result?: JsonValue
  error?: P2Error
}

export type BodyInfo = {
  manifest: BodyManifest
  manifestDigest: string
  bindingId: BindingId | null
  capabilities: string[]
  provider: ProviderSummary | null
}

export type BodyRuntimeOptions = {
  body: BodyInfo
  owner?: OwnerContext
  heartbeatTimeoutMs?: number
  now?: () => number
  newEpoch?: () => string
  newCommandId?: () => string
  shutdownGraceMs?: number
  /** Experiment-only rescue channel state, reported in status. */
  rescue?: { enabled: boolean; tpRadius: number }
  /** Developer-mode operation hook, read fresh on every status call. */
  devOps?: () => DevOpsStatus | null
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



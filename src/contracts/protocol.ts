import type {
  BindingId,
  BodyEpoch,
  BodyManifest,
  CommandId,
  JsonValue,
  P2Error,
  RunId,
  ValueMeta,
} from './types.ts'
import { ErrorCodes } from './types.ts'

export const PROTOCOL_VERSION = 1
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024

export const METHODS = [
  'hello',
  'heartbeat',
  'describe',
  'status',
  'observe',
  'check',
  'activate',
  'switch',
  'rescue',
  'confirm',
  'behavior.stop',
  'stop',
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
  /** Wall-clock time of the last observed bot death, when any. */
  lastDeathAt?: number | null
  /** Where the bot died, when the provider observed it. */
  lastDeathPosition?: { x: number; y: number; z: number } | null
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

export type StatusResult = {
  bodyEpoch: BodyEpoch
  /** Package/body version from body.manifest.json, e.g. 0.3.2-exp-ir.1. */
  version: string
  owner: OwnerContext | null
  health: 'ready' | 'faulted'
  connection: 'connected' | 'disconnected'
  activeRun: ActiveRunSummary | null
  lastRun?: LastRunSummary | null
  pendingConfirmation: PendingConfirmationSummary | null
  bindingId: BindingId | null
  capabilities: string[]
  provider: ProviderSummary | null
  providerState?: ProviderRuntimeStatus | null
  commandCount: number
  activeAct?: string | null
  activeNode?: string | null
  activeTarget?: { x: number; z: number } | null
  waiting?: string | null
  lastFailure?: P2Error | null
  /** Experiment-only rescue channel state; null when the body has no provider. */
  rescue?: { enabled: boolean; tpRadius: number } | null
  loggingUnavailable?: boolean
  droppedLogCount?: number
}

export type ActiveRunSummary = {
  runId: string
  status: string
  artifactId: string
  completion: string | null
}

export type LastRunSummary = {
  runId: string
  status: 'succeeded' | 'failed' | 'cancelled'
  error?: P2Error
}

export type PendingConfirmationSummary = {
  id: string
  runId: string
}

export type CheckParams = {
  sourcePath: string
  sourceRoot?: string
  timeoutMs?: number
  artifactKind?: 'behavior' | 'act' | 'policy'
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

export type CheckResult = {
  artifactId: string
  definitionId: string
  sourceDigest: string
  bindingId: string
  kind: 'behavior' | 'act' | 'policy'
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

export type SwitchParams = {
  artifactId: string
  params: Record<string, JsonValue>
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

export type SwitchResult = {
  accepted: boolean
  runId: string | null
  status: string
  error?: P2Error
}

export type ConfirmParams = {
  runId: string
  confirmationId: string
  decision: 'confirm' | 'deny'
}

export type BehaviorStopParams = {
  runId?: string
}

export type BehaviorStopResult = {
  accepted: boolean
  status: string
  error?: P2Error
}

export type ConfirmationResult = {
  outcome: 'confirmed' | 'denied' | 'alreadyDecided' | 'rejected'
  status: string
  error?: P2Error
}

export type HeartbeatParams = { seq: number }
export type HeartbeatResult = { seq: number; alive: true }

export type StopParams = { runId?: RunId }
export type StopResult = { accepted: true; runId: RunId | null }

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

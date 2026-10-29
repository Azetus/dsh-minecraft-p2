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
  'guard.set',
  'guard.clear',
  'trace',
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

export type CurrentStep = {
  kind: 'query' | 'act' | 'decide' | 'wait' | 'progress' | 'log'
  ref: string | null
  op: string | null
  summary: string
}

/** One query a guard/watch declares; sampled by the host, never by content. */
export type GuardQuery = {
  op: string
  args?: JsonValue
}

export type GuardCondition =
  | { kind: 'policy'; queries: GuardQuery[]; predicate: string }
  | { kind: 'health'; hpBelow: number }

export type GuardState = 'active' | 'firing' | 'fired' | 'deferred' | 'expired' | 'cleared' | 'error'

export type GuardEventPhase =
  | 'armed'
  | 'fired'
  | 'deferred'
  | 'precheck-failed'
  | 'stopping'
  | 'started'
  | 'failed'
  | 'suppressed'
  | 'cleared'
  | 'expired'
  | 'error'

export type GuardEvent = {
  seq: number
  guardId: string
  attemptId?: string
  phase: GuardEventPhase
  at: number
  condition?: GuardCondition
  evidence?: JsonValue
  targetArtifactId?: string
  fromRunId?: string | null
  toRunId?: string | null
  message?: string
  error?: P2Error
}

export type GuardTarget = {
  artifactId: string
  params: JsonValue
}

export type GuardStatus = {
  id: string
  priority: number
  state: GuardState
  condition: GuardCondition
  target: GuardTarget
  armedAt: number
  expiresAt: number
  attemptId?: string
  lastError?: P2Error
}

export type GuardSwitchSummary = {
  guardId: string
  attemptId: string
  reason: string
  targetArtifactId: string
  fromRunId: string | null
  toRunId: string | null
  at: number
  phase: 'precheck-failed' | 'stopping' | 'started' | 'failed' | 'suppressed'
}

export type CleanupState = 'none' | 'running' | 'released' | 'unconfirmed'
export type ControlHealth = 'ok' | 'unknown' | 'faulted'
export type SwitchState = 'none' | 'queued' | 'stopping' | 'released' | 'unconfirmed'

export type ActiveActHandleSummary = {
  actId: string
  definitionId: string
  artifactId: string
  startedAt: number
  state: 'running' | 'stopping'
}

export type RunObservation = {
  currentStep: CurrentStep | null
  stepCount: number
  progress: JsonValue | null
  lastError: P2Error | null
  cleanupState: CleanupState
  controlHealth: ControlHealth
  switchState: SwitchState
  logCount: number
  logDropped: number
  evidence?: JsonValue
  activeActHandle?: ActiveActHandleSummary
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
  activeActHandle?: ActiveActHandleSummary | null
  activeNode?: string | null
  activeTarget?: { x: number; z: number } | null
  waiting?: string | null
  lastFailure?: P2Error | null
  currentStep?: CurrentStep | null
  stepCount?: number
  progress?: JsonValue | null
  lastError?: P2Error | null
  cleanupState?: CleanupState
  controlHealth?: ControlHealth
  switchState?: SwitchState
  guards?: GuardStatus[]
  lastSwitch?: GuardSwitchSummary | null
  guardEvents?: GuardEvent[]
  guardEventSeq?: number
  /** Experiment-only rescue channel state; null when the body has no provider. */
  rescue?: { enabled: boolean; tpRadius: number } | null
  /** Developer-mode external operations; null when the hook is disabled. */
  devOps?: DevOpsStatus | null
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
  progress?: JsonValue | null
  evidence?: JsonValue
}

export type PendingConfirmationSummary = {
  id: string
  runId: string
}

export type CheckParams = {
  sourcePath: string
  sourceRoot?: string
  timeoutMs?: number
  artifactKind?: 'behavior' | 'act' | 'policy' | 'op'
  /** Experimental behavior format; ignored for act/policy/op. */
  format?: 'ir' | 'js'
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
  kind: 'behavior' | 'act' | 'policy' | 'op'
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

export type TraceKind = 'run' | 'behavior' | 'act' | 'op' | 'guard' | 'watch'
export type TracePhase = 'start' | 'end' | 'error' | 'event'

/** One bounded developer-trace record; durations are monotonic wall-clock ms. */
export type TraceEvent = {
  seq: number
  at: number
  kind: TraceKind
  phase: TracePhase
  name: string
  durationMs?: number
  runId?: string
  actId?: string
  opId?: string
  detail?: JsonValue
}

export type TraceParams = {
  kind?: TraceKind
  /** Match events attributed to one run. */
  runId?: string
  /** Match act events by definition id. */
  act?: string
  /** Match op events by operation name. */
  op?: string
  sinceSeq?: number
  /** Keep the most recent N matching events; stats still cover all matches. */
  limit?: number
}

/** Nearest-rank percentiles over completed spans. */
export type TraceStats = {
  count: number
  p50: number | null
  p95: number | null
  max: number | null
}

export type TraceResult = {
  events: TraceEvent[]
  stats: Partial<Record<TraceKind, TraceStats>>
  dropped: number
  capacity: number
  seq: number
  /** True when sinceSeq predates the retained window. */
  gap: boolean
}

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

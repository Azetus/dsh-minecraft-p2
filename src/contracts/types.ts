/** Shared wire and manifest types for the P2 body/bridge boundary. */

export type Brand<T, B extends string> = T & { readonly __brand: B }

export type DefinitionId = Brand<string, 'DefinitionId'>
export type Revision = Brand<string, 'Revision'>
export type ArtifactId = Brand<string, 'ArtifactId'>
export type RunId = Brand<string, 'RunId'>
export type NodeRunId = Brand<string, 'NodeRunId'>
export type ActEpoch = Brand<string, 'ActEpoch'>
export type RequestId = Brand<string, 'RequestId'>
export type CommandId = Brand<string, 'CommandId'>
export type ConfirmationId = Brand<string, 'ConfirmationId'>
export type BodyEpoch = Brand<string, 'BodyEpoch'>
export type ConnectionEpoch = Brand<string, 'ConnectionEpoch'>
export type BindingId = Brand<string, 'BindingId'>
export type EventSeq = Brand<number, 'EventSeq'>
export type EventId = Brand<string, 'EventId'>
export type OwnerSessionId = Brand<string, 'OwnerSessionId'>

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type P2ErrorCategory =
  | 'validation'
  | 'capability'
  | 'environment'
  | 'timeout'
  | 'transport'
  | 'runtime'
  | 'control'

export type P2Error = {
  code: string
  category: P2ErrorCategory
  message: string
  source: {
    module: string
    nodePath?: string
    opId?: string
  }
  retry: 'never' | 'explicit-policy' | 'cleanup-once'
  details?: JsonValue
}

export const ErrorCodes = {
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  UNKNOWN_METHOD: 'UNKNOWN_METHOD',
  UNSUPPORTED_PROTOCOL: 'UNSUPPORTED_PROTOCOL',
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  STALE_EPOCH: 'STALE_EPOCH',
  INVALID_OWNER: 'INVALID_OWNER',
  DUPLICATE_COMMAND: 'DUPLICATE_COMMAND',
  COMMAND_NOT_FOUND: 'COMMAND_NOT_FOUND',
  SHUTTING_DOWN: 'SHUTTING_DOWN',
  PROTOCOL_TOO_LARGE: 'PROTOCOL_TOO_LARGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type BodyManifest = {
  schemaVersion: 1
  bodyVersion: string
  protocolVersion: number
  entry: string
  files: Record<string, string>
}

export type ProviderManifest = {
  schemaVersion: 1
  providerId: string
  providerVersion: string
  opContractVersion: string
  protocolVersion: number
  capabilities: string[]
  gameCompatibility: string[]
  entry: string
  files: Record<string, string>
}

export type BindingManifest = {
  schemaVersion: 1
  body: {
    version: string
    protocolVersion: number
    manifestDigest: string
  }
  provider: {
    id: string
    version: string
    manifestDigest: string
  } | null
  irVersion: number
  opContractVersion: string
  capabilities: string[]
  driver: string | null
  config: JsonValue
}

export type ArtifactKind = 'behavior' | 'act'

export type ArtifactManifest = {
  schemaVersion: 1
  kind: ArtifactKind
  definitionId: string
  sourceDigest: string
  irVersion: number
  irDigest: string | null
  codeDigest: string | null
  buildToolVersion: string
  bindingId: string
  dependencies: Array<{
    kind: string
    id: string
    digest: string
  }>
}

/** Provenance carried by a local slot or a query/act output. */
export type ValueMeta = {
  source: 'initial' | 'assign' | 'query' | 'act' | 'subtree'
  scope: string
  sampledAt: number
  validUntil?: number
  evidence?: string[]
  /** Server world age observed with this value; absent when unavailable. */
  serverAge?: number
  /** True when the server tick/age is stalled (for example `/tick freeze`). */
  paused?: boolean
}

export type LocalSlot = {
  value: JsonValue
  meta: ValueMeta
}

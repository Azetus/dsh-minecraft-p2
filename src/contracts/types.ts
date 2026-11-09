/** Shared wire and manifest types for the P2 body/bridge boundary. */

export type Brand<T, B extends string> = T & { readonly __brand: B }

export type BodyEpoch = Brand<string, 'BodyEpoch'>
export type BindingId = Brand<string, 'BindingId'>

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
  SHUTTING_DOWN: 'SHUTTING_DOWN',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DEFINITION_ERROR: 'DEFINITION_ERROR',
} as const

export type BodyManifest = {
  schemaVersion: 1
  bodyVersion: string
  protocolVersion: number
  entry: string
  files: Record<string, string>
}

/** Content identity of one body/provider/environment combination. */
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
  driver: string | null
  config: JsonValue
}

/** Provenance carried by an observation value. */
export type ValueMeta = {
  source: 'query' | 'act'
  scope: string
  sampledAt: number
  validUntil?: number
  evidence?: string[]
  /** Server world age observed with this value; absent when unavailable. */
  serverAge?: number
  /** True when the server tick/age is stalled (for example `/tick freeze`). */
  paused?: boolean
}

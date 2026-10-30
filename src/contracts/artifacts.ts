/** Immutable content artifact contracts for the Controller-only runtime. */

import type { ArtifactManifest, JsonValue } from './types.ts'

/**
 * Reference to another content artifact. `artifactId` is optional at authoring
 * time and is filled by the check step from the registry default mapping; the
 * stored artifact always carries the exact id.
 */
export type ArtifactRef = {
  definitionId: string
  artifactId?: string
}

export type ActLimits = {
  totalMs?: number
  hookMs?: number
}

export type ActManifestInfo = {
  id: string
  description?: string
  queryOps: string[]
  controlOps: string[]
  limits?: ActLimits
}

/** Immutable act artifact: single-file code plus its declared operations. */
export type ActArtifact = {
  kind: 'act'
  definitionId: string
  code: string
  ops: { query: string[]; control: string[] }
  limits?: ActLimits
  manifest: ArtifactManifest
  artifactId: string
  artifactDigest: string
  bindingId: string
  sourceDigest: string
}

/**
 * Immutable strategy artifact: a single-file, synchronous `evaluate(ctx)`
 * function. It receives plain JSON facts and returns a verdict; it cannot
 * import, call operations or hold host handles.
 */
export type StrategyArtifact = {
  kind: 'strategy'
  definitionId: string
  version: string
  slot: 'S0' | 'S1' | 'S2' | 'S3'
  hazardClass?: 'lethal' | 'bleeding-fire' | 'trapped'
  /** Observation keys the strategy reads; the host supplies exactly these. */
  facts: string[]
  /** Declared act definition ids; resolved to exact artifact ids at check time. */
  acts: string[]
  resolvedActs: Record<string, string>
  code: string
  manifest: ArtifactManifest
  artifactId: string
  artifactDigest: string
  bindingId: string
  sourceDigest: string
}

/** Immutable policy artifact: single-file pure decision code. */
export type PolicyArtifact = {
  kind: 'policy'
  definitionId: string
  code: string
  manifest: ArtifactManifest
  artifactId: string
  artifactDigest: string
  bindingId: string
  sourceDigest: string
}

/**
 * Immutable authored operation artifact. It runs in the body process and holds
 * the provider capability directly; the broker only tracks the handle handed
 * back to it.
 */
export type OpArtifact = {
  kind: 'op'
  definitionId: string
  code: string
  opKind: 'query' | 'control'
  effects: 'none' | 'active'
  stop: 'none' | 'poll'
  capabilities: string[]
  parameters?: JsonValue
  resultSchema?: JsonValue
  limits?: { totalMs?: number }
  manifest: ArtifactManifest
  artifactId: string
  artifactDigest: string
  bindingId: string
  sourceDigest: string
}

export type ContentArtifact = ActArtifact | PolicyArtifact | OpArtifact | StrategyArtifact



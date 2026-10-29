import type { JsonValue } from './types.ts'
import type { ArtifactManifest, P2ErrorCategory } from './types.ts'

/** Serializable behavior IR shared by the builder, checker and executor. */
export type ValueExpr =
  | { kind: 'literal'; value: JsonValue }
  | { kind: 'param'; name: string }
  | { kind: 'local'; name: string }
  | { kind: 'member'; object: ValueExpr; key: ValueExpr }
  | { kind: 'record'; fields: Record<string, ValueExpr> }
  | { kind: 'array'; items: ValueExpr[] }
  | {
      kind: 'binary'
      op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'and' | 'or' | 'add' | 'sub' | 'mul' | 'div'
      left: ValueExpr
      right: ValueExpr
    }
  | { kind: 'not'; value: ValueExpr }
  | { kind: 'length'; value: ValueExpr }

export type QueryRef = {
  op: string
  args: Record<string, ValueExpr>
  freshnessMs?: number
  timeoutMs?: number
}

/**
 * Reference to another content artifact. `artifactId` is optional at authoring
 * time and is filled by the check step from the registry default mapping; the
 * stored artifact always carries the exact id.
 */
export type ArtifactRef = {
  definitionId: string
  artifactId?: string
}

export type Condition =
  | { kind: 'expr'; expr: ValueExpr }
  | { kind: 'query'; query: QueryRef; test: ValueExpr }

export type Node =
  | { kind: 'sequence'; id: string; children: Node[] }
  | { kind: 'if'; id: string; when: Condition; then: Node; else?: Node }
  | { kind: 'reactivePriority'; id: string; branches: Array<{ when: Condition; child: Node }> }
  | { kind: 'repeat'; id: string; child: Node; count?: number }
  | { kind: 'subtree'; id: string; tree: Node; inputs: Record<string, ValueExpr>; outputs: Record<string, string> }
  | { kind: 'assign'; id: string; target: string; value: ValueExpr }
  | { kind: 'query'; id: string; query: QueryRef; output: string }
  | { kind: 'act'; id: string; act: ArtifactRef; args: Record<string, ValueExpr>; output?: string }
  | { kind: 'decide'; id: string; policy: ArtifactRef; inputs: Record<string, ValueExpr>; output: string; timeoutMs?: number }
  | { kind: 'fail'; id: string; code: string; message: string; category?: P2ErrorCategory }
  | { kind: 'wait'; id: string; durationMs: number }
  | {
      kind: 'recover'
      id: string
      child: Node
      rules: Array<{
        codes: string[]
        retries: number
        intervalMs: number
        deadlineMs: number
        fallback?: Node
        blocked?: boolean
      }>
    }

export type ParameterSpec = {
  type: 'string' | 'number' | 'boolean' | 'json'
  required?: boolean
  default?: JsonValue
  description?: string
}

export type CompletionRule =
  | { kind: 'predicate'; condition: Condition; checkMs?: number }
  | { kind: 'externalConfirmation'; description: string }

export type BehaviorDefinition = {
  id: string
  description: string
  mode: 'finite' | 'continuous'
  parameters: Record<string, ParameterSpec>
  locals: Record<string, { type: ParameterSpec['type']; initial?: JsonValue }>
  root: Node
  completion?: CompletionRule
  progress?: Record<string, ValueExpr>
}

export type BehaviorArtifact = {
  kind: 'behavior'
  /** 'ir' (default) or an experimental generator script. */
  format?: 'ir' | 'js'
  /** Present for format === 'js'; evaluated in a sandboxed step runner. */
  code?: string
  /** Exact act/policy artifacts resolved at check time from declared dependencies. */
  resolvedDependencies?: { acts: Record<string, string>; policies: Record<string, string> }
  definition: BehaviorDefinition
  manifest: ArtifactManifest
  artifactId: string
  artifactDigest: string
  bindingId: string
  sourceDigest: string
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

export type ContentArtifact = BehaviorArtifact | ActArtifact | PolicyArtifact

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

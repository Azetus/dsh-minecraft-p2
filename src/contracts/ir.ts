import type { JsonValue } from './types.ts'
import type { ArtifactManifest } from './types.ts'

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

export type QueryRef = {
  op: string
  args: Record<string, ValueExpr>
  freshnessMs?: number
  timeoutMs?: number
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
  | { kind: 'act'; id: string; act: string; args: Record<string, ValueExpr>; output?: string }
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
  definition: BehaviorDefinition
  manifest: ArtifactManifest
  artifactId: string
  artifactDigest: string
  bindingId: string
  sourceDigest: string
}

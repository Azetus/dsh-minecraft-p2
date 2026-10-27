import type {
  BehaviorDefinition,
  CompletionRule,
  Condition,
  Node,
  ParameterSpec,
  QueryRef,
  ValueExpr,
} from '../contracts/ir.ts'
import type { JsonValue } from '../contracts/types.ts'

export const AUTHORING_VERSION = '0.1.0'

export function defineBehavior(definition: BehaviorDefinition): BehaviorDefinition {
  return definition
}

export function sequence(id: string, ...children: Node[]): Node {
  return { kind: 'sequence', id, children }
}

export function ifThen(id: string, when: Condition, then: Node, otherwise?: Node): Node {
  return otherwise === undefined
    ? { kind: 'if', id, when, then }
    : { kind: 'if', id, when, then, else: otherwise }
}

export function reactivePriority(id: string, branches: Array<{ when: Condition; child: Node }>): Node {
  return { kind: 'reactivePriority', id, branches }
}

export function repeat(id: string, child: Node, count?: number): Node {
  return count === undefined
    ? { kind: 'repeat', id, child }
    : { kind: 'repeat', id, child, count }
}

export function subtree(
  id: string,
  tree: Node,
  inputs: Record<string, ValueExpr> = {},
  outputs: Record<string, string> = {},
): Node {
  return { kind: 'subtree', id, tree, inputs, outputs }
}

export function assign(id: string, target: string, value: ValueExpr): Node {
  return { kind: 'assign', id, target, value }
}

export function query(
  id: string,
  op: string,
  args: Record<string, ValueExpr>,
  output: string,
  freshnessMs?: number,
  timeoutMs?: number,
): Node {
  return {
    kind: 'query',
    id,
    query: queryRef(op, args, freshnessMs, timeoutMs),
    output,
  }
}

export function act(
  id: string,
  name: string,
  args: Record<string, ValueExpr> = {},
  output?: string,
): Node {
  return output === undefined
    ? { kind: 'act', id, act: name, args }
    : { kind: 'act', id, act: name, args, output }
}

export function wait(id: string, durationMs: number): Node {
  return { kind: 'wait', id, durationMs }
}

export function recover(
  id: string,
  child: Node,
  rules: Array<{
    codes: string[]
    retries: number
    intervalMs: number
    deadlineMs: number
    fallback?: Node
    blocked?: boolean
  }>,
): Node {
  return { kind: 'recover', id, child, rules }
}

export function queryRef(
  op: string,
  args: Record<string, ValueExpr> = {},
  freshnessMs?: number,
  timeoutMs?: number,
): QueryRef {
  return {
    op,
    args,
    ...(freshnessMs === undefined ? {} : { freshnessMs }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

export function when(expr: ValueExpr): Condition {
  return { kind: 'expr', expr }
}

export function whenQuery(
  query: QueryRef,
  test: ValueExpr,
): Condition {
  return { kind: 'query', query, test }
}

export function externalCompletion(description: string): CompletionRule {
  return { kind: 'externalConfirmation', description }
}

export function lit(value: JsonValue): ValueExpr {
  return { kind: 'literal', value }
}

export function param(name: string): ValueExpr {
  return { kind: 'param', name }
}

export function local(name: string): ValueExpr {
  return { kind: 'local', name }
}

export function member(object: ValueExpr, key: ValueExpr | string): ValueExpr {
  return {
    kind: 'member',
    object,
    key: typeof key === 'string' ? lit(key) : key,
  }
}

export function record(fields: Record<string, ValueExpr>): ValueExpr {
  return { kind: 'record', fields }
}

export function array(items: ValueExpr[]): ValueExpr {
  return { kind: 'array', items }
}

export function binary(
  op: Extract<ValueExpr, { kind: 'binary' }>['op'],
  left: ValueExpr,
  right: ValueExpr,
): ValueExpr {
  return { kind: 'binary', op, left, right }
}

export function not(value: ValueExpr): ValueExpr {
  return { kind: 'not', value }
}

export const eq = (left: ValueExpr, right: ValueExpr): ValueExpr => binary('eq', left, right)
export const neq = (left: ValueExpr, right: ValueExpr): ValueExpr => binary('neq', left, right)
export const and = (left: ValueExpr, right: ValueExpr): ValueExpr => binary('and', left, right)
export const or = (left: ValueExpr, right: ValueExpr): ValueExpr => binary('or', left, right)
export const gt = (left: ValueExpr, right: ValueExpr): ValueExpr => binary('gt', left, right)
export const gte = (left: ValueExpr, right: ValueExpr): ValueExpr => binary('gte', left, right)
export const lt = (left: ValueExpr, right: ValueExpr): ValueExpr => binary('lt', left, right)
export const lte = (left: ValueExpr, right: ValueExpr): ValueExpr => binary('lte', left, right)
export const add = (left: ValueExpr, right: ValueExpr): ValueExpr => binary('add', left, right)
export const sub = (left: ValueExpr, right: ValueExpr): ValueExpr => binary('sub', left, right)

export const stringParam = (required = true): ParameterSpec => ({ type: 'string', required })
export const numberParam = (required = true): ParameterSpec => ({ type: 'number', required })
export const booleanParam = (required = true): ParameterSpec => ({ type: 'boolean', required })
export const jsonParam = (required = true): ParameterSpec => ({ type: 'json', required })

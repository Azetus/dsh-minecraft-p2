import { canonicalJson } from '../contracts/digest.ts'
import type { ValueExpr } from '../contracts/ir.ts'
import type { JsonValue } from '../contracts/types.ts'

export type EvalContext = {
  params: Record<string, JsonValue>
  locals: Map<string, JsonValue>
}

export class EvalError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'EvalError'
    this.code = code
  }
}

export function evaluate(expr: ValueExpr, context: EvalContext): JsonValue {
  switch (expr.kind) {
    case 'literal':
      return expr.value
    case 'param':
      if (!(expr.name in context.params)) {
        throw new EvalError('PARAM_MISSING', `parameter is missing: ${expr.name}`)
      }
      return context.params[expr.name] as JsonValue
    case 'local':
      if (!context.locals.has(expr.name)) {
        throw new EvalError('UNINITIALIZED_VALUE', `local is not initialized: ${expr.name}`)
      }
      return context.locals.get(expr.name) as JsonValue
    case 'member': {
      const object = evaluate(expr.object, context)
      const key = evaluate(expr.key, context)
      if (Array.isArray(object)) {
        if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key >= object.length) {
          throw new EvalError('EXPRESSION_ERROR', `array index is invalid: ${String(key)}`)
        }
        return object[key] as JsonValue
      }
      if (typeof object !== 'object' || object === null || typeof key !== 'string') {
        throw new EvalError('EXPRESSION_ERROR', 'member access requires an object and string key')
      }
      if (!(key in object)) {
        throw new EvalError('EXPRESSION_ERROR', `member is missing: ${key}`)
      }
      return object[key] as JsonValue
    }
    case 'length': {
      const value = evaluate(expr.value, context)
      if (Array.isArray(value)) return value.length
      if (typeof value === 'string') return value.length
      if (typeof value === 'object' && value !== null) return Object.keys(value).length
      throw new EvalError('EXPRESSION_ERROR', 'length requires an array, string or object')
    }
    case 'record': {
      const result: Record<string, JsonValue> = {}
      for (const [key, value] of Object.entries(expr.fields)) result[key] = evaluate(value, context)
      return result
    }
    case 'array':
      return expr.items.map(item => evaluate(item, context))
    case 'not': {
      const value = evaluate(expr.value, context)
      if (typeof value !== 'boolean') throw new EvalError('EXPRESSION_ERROR', 'not requires a boolean')
      return !value
    }
    case 'binary':
      return evaluateBinary(expr, context)
    default:
      throw new EvalError('EXPRESSION_ERROR', 'unknown expression kind')
  }
}

function evaluateBinary(
  expr: Extract<ValueExpr, { kind: 'binary' }>,
  context: EvalContext,
): JsonValue {
  if (expr.op === 'and') {
    const left = evaluate(expr.left, context)
    if (typeof left !== 'boolean') throw new EvalError('EXPRESSION_ERROR', 'and requires booleans')
    if (!left) return false
    const right = evaluate(expr.right, context)
    if (typeof right !== 'boolean') throw new EvalError('EXPRESSION_ERROR', 'and requires booleans')
    return right
  }
  if (expr.op === 'or') {
    const left = evaluate(expr.left, context)
    if (typeof left !== 'boolean') throw new EvalError('EXPRESSION_ERROR', 'or requires booleans')
    if (left) return true
    const right = evaluate(expr.right, context)
    if (typeof right !== 'boolean') throw new EvalError('EXPRESSION_ERROR', 'or requires booleans')
    return right
  }

  const left = evaluate(expr.left, context)
  const right = evaluate(expr.right, context)
  if (expr.op === 'eq') return canonicalJson(left) === canonicalJson(right)
  if (expr.op === 'neq') return canonicalJson(left) !== canonicalJson(right)

  if (expr.op === 'lt' || expr.op === 'lte' || expr.op === 'gt' || expr.op === 'gte') {
    if ((typeof left === 'number' && typeof right === 'number')
      || (typeof left === 'string' && typeof right === 'string')) {
      switch (expr.op) {
        case 'lt': return left < right
        case 'lte': return left <= right
        case 'gt': return left > right
        case 'gte': return left >= right
      }
    }
    throw new EvalError('EXPRESSION_ERROR', `${expr.op} requires two numbers or two strings`)
  }

  if (expr.op === 'add' && typeof left === 'string' && typeof right === 'string') return left + right
  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new EvalError('EXPRESSION_ERROR', `${expr.op} requires numbers`)
  }
  switch (expr.op) {
    case 'add': return left + right
    case 'sub': return left - right
    case 'mul': return left * right
    case 'div':
      if (right === 0) throw new EvalError('EXPRESSION_ERROR', 'division by zero')
      return left / right
    default:
      throw new EvalError('EXPRESSION_ERROR', `unknown operator: ${expr.op}`)
  }
}

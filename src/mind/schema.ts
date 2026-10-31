import { p2Error } from '../contracts/protocol.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import { ErrorCodes } from '../contracts/types.ts'

/**
 * The JSON Schema subset the mind understands. Anything outside this subset is
 * rejected at load time instead of being silently ignored: a definition that
 * cannot be checked must not run.
 */
export type SchemaNode =
  | {
      type: 'object'
      properties?: Record<string, SchemaNode>
      required?: string[]
      additionalProperties?: boolean
      enum?: JsonValue[]
    }
  | { type: 'array'; items?: SchemaNode; enum?: JsonValue[] }
  | { type: 'string'; enum?: JsonValue[] }
  | { type: 'number'; minimum?: number; maximum?: number; enum?: JsonValue[] }
  | { type: 'integer'; minimum?: number; maximum?: number; enum?: JsonValue[] }
  | { type: 'boolean'; enum?: JsonValue[] }
  | { type: 'null'; enum?: JsonValue[] }

export type ValidationIssue = { path: string; message: string }

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const COMMON_KEYS = new Set(['type', 'enum'])
const TYPE_KEYS: Record<SchemaNode['type'], Set<string>> = {
  object: new Set([...COMMON_KEYS, 'properties', 'required', 'additionalProperties']),
  array: new Set([...COMMON_KEYS, 'items']),
  string: new Set(COMMON_KEYS),
  number: new Set([...COMMON_KEYS, 'minimum', 'maximum']),
  integer: new Set([...COMMON_KEYS, 'minimum', 'maximum']),
  boolean: new Set(COMMON_KEYS),
  null: new Set(COMMON_KEYS),
}

export type CompileResult =
  | { ok: true; schema: SchemaNode }
  | { ok: false; error: P2Error }

export function compileSchema(value: unknown): CompileResult {
  const issue = compileNode(value, '$')
  if (issue !== undefined) return { ok: false, error: definitionError(issue) }
  return { ok: true, schema: value as SchemaNode }
}

function compileNode(value: unknown, path: string): ValidationIssue | undefined {
  if (!isRecord(value)) return { path, message: 'schema node must be an object' }
  const type = value.type
  if (typeof type !== 'string' || !TYPES.has(type)) {
    return { path: `${path}.type`, message: `unsupported schema type: ${String(type)}` }
  }
  const allowed = TYPE_KEYS[type as SchemaNode['type']]
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return { path: `${path}.${key}`, message: `unsupported schema keyword for ${type}` }
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) {
      return { path: `${path}.enum`, message: 'enum must be a non-empty array' }
    }
  }
  if (type === 'object') {
    if (value.properties !== undefined) {
      if (!isRecord(value.properties)) return { path: `${path}.properties`, message: 'properties must be an object' }
      for (const [key, child] of Object.entries(value.properties)) {
        const issue = compileNode(child, `${path}.properties.${key}`)
        if (issue !== undefined) return issue
      }
    }
    if (value.required !== undefined) {
      if (!Array.isArray(value.required) || value.required.some(entry => typeof entry !== 'string' || entry.length === 0)) {
        return { path: `${path}.required`, message: 'required must be an array of non-empty strings' }
      }
    }
    if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') {
      return { path: `${path}.additionalProperties`, message: 'additionalProperties must be a boolean' }
    }
  }
  if (type === 'array' && value.items !== undefined) {
    const issue = compileNode(value.items, `${path}.items`)
    if (issue !== undefined) return issue
  }
  if (type === 'number' || type === 'integer') {
    for (const key of ['minimum', 'maximum'] as const) {
      if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
        return { path: `${path}.${key}`, message: `${key} must be a finite number` }
      }
    }
    if (typeof value.minimum === 'number' && typeof value.maximum === 'number' && value.minimum > value.maximum) {
      return { path: `${path}.minimum`, message: 'minimum must not exceed maximum' }
    }
  }
  return undefined
}

/** Validate one params object against a compiled schema. */
export function validateParams(schema: SchemaNode, value: unknown): ValidationIssue | undefined {
  return validateNode(schema, value, '$')
}

function validateNode(schema: SchemaNode, value: unknown, path: string): ValidationIssue | undefined {
  if (schema.enum !== undefined && !schema.enum.some(entry => sameJson(entry, value))) {
    return { path, message: `value must be one of ${schema.enum.map(entry => JSON.stringify(entry)).join(', ')}` }
  }
  switch (schema.type) {
    case 'object': {
      if (!isRecord(value)) return { path, message: 'value must be an object' }
      for (const key of schema.required ?? []) {
        if (!(key in value)) return { path: `${path}.${key}`, message: 'required property is missing' }
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (!(key in value)) continue
        const issue = validateNode(child, value[key], `${path}.${key}`)
        if (issue !== undefined) return issue
      }
      if (schema.additionalProperties === false) {
        const known = new Set(Object.keys(schema.properties ?? {}))
        for (const key of Object.keys(value)) {
          if (!known.has(key)) return { path: `${path}.${key}`, message: 'unknown property' }
        }
      }
      return undefined
    }
    case 'array': {
      if (!Array.isArray(value)) return { path, message: 'value must be an array' }
      if (schema.items !== undefined) {
        for (let index = 0; index < value.length; index += 1) {
          const issue = validateNode(schema.items, value[index], `${path}[${index}]`)
          if (issue !== undefined) return issue
        }
      }
      return undefined
    }
    case 'string':
      return typeof value === 'string' ? undefined : { path, message: 'value must be a string' }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { path, message: 'value must be a finite number' }
      if (schema.minimum !== undefined && value < schema.minimum) return { path, message: `value must be >= ${schema.minimum}` }
      if (schema.maximum !== undefined && value > schema.maximum) return { path, message: `value must be <= ${schema.maximum}` }
      return undefined
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return { path, message: 'value must be an integer' }
      if (schema.minimum !== undefined && value < schema.minimum) return { path, message: `value must be >= ${schema.minimum}` }
      if (schema.maximum !== undefined && value > schema.maximum) return { path, message: `value must be <= ${schema.maximum}` }
      return undefined
    case 'boolean':
      return typeof value === 'boolean' ? undefined : { path, message: 'value must be a boolean' }
    case 'null':
      return value === null ? undefined : { path, message: 'value must be null' }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function definitionError(issue: ValidationIssue): P2Error {
  return p2Error(
    ErrorCodes.DEFINITION_ERROR,
    'validation',
    `invalid schema at ${issue.path}: ${issue.message}`,
    { module: 'mind.schema' },
    { path: issue.path },
  )
}

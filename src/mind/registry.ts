import { p2Error } from '../contracts/protocol.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import { ErrorCodes } from '../contracts/types.ts'
import type { SchemaNode, ValidationIssue } from './schema.ts'
import { compileSchema, validateParams } from './schema.ts'
import type { Driver, EvalCtx, WorkGiver, WorldView } from './types.ts'

export type PredicateResult = boolean | 'unknown'

export type PredicateFn = (ctx: EvalCtx, world: WorldView) => PredicateResult

export type PredicateDef = {
  id: string
  schema: SchemaNode
  fn: PredicateFn
}

export type GiverDef = {
  id: string
  factory: () => WorkGiver
}

export type DriverRegistration = {
  id: string
  driver: Driver
}

/**
 * Stable-id registry for the three content extension points. Unknown ids and
 * duplicate definitions are load-time errors, never a silent fallback.
 */
export class Registry {
  private readonly predicates = new Map<string, PredicateDef>()
  private readonly givers = new Map<string, WorkGiver>()
  private readonly drivers = new Map<string, Driver>()

  registerPredicate(definition: {
    id: string
    schema?: unknown
    fn: PredicateFn
  }): void {
    assertId(definition.id, 'predicate')
    if (this.predicates.has(definition.id)) throw duplicateError('predicate', definition.id)
    const schema = definition.schema === undefined ? { type: 'object', properties: {}, additionalProperties: false } : definition.schema
    const compiled = compileSchema(schema)
    if (!compiled.ok) throw compiled.error
    this.predicates.set(definition.id, { id: definition.id, schema: compiled.schema, fn: definition.fn })
  }

  registerGiver(definition: GiverDef): void {
    assertId(definition.id, 'giver')
    if (this.givers.has(definition.id)) throw duplicateError('giver', definition.id)
    let giver: WorkGiver
    try {
      giver = definition.factory()
    } catch (error) {
      throw definitionError(`giver factory ${definition.id} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (giver.id !== definition.id) {
      throw definitionError(`giver factory returned id "${giver.id}" for registration "${definition.id}"`)
    }
    this.givers.set(definition.id, giver)
  }

  registerDriver(definition: DriverRegistration): void {
    assertId(definition.id, 'driver')
    if (this.drivers.has(definition.id)) throw duplicateError('driver', definition.id)
    if (definition.driver.id !== definition.id) {
      throw definitionError(`driver id "${definition.driver.id}" does not match registration "${definition.id}"`)
    }
    const compiled = compileSchema(definition.driver.schema)
    if (!compiled.ok) throw compiled.error
    this.drivers.set(definition.id, definition.driver)
  }

  hasPredicate(id: string): boolean {
    return this.predicates.has(id)
  }

  hasGiver(id: string): boolean {
    return this.givers.has(id)
  }

  hasDriver(id: string): boolean {
    return this.drivers.has(id)
  }

  predicate(id: string): PredicateDef {
    const found = this.predicates.get(id)
    if (found === undefined) throw definitionError(`unknown predicate: ${id}`)
    return found
  }

  giver(id: string): WorkGiver {
    const found = this.givers.get(id)
    if (found === undefined) throw definitionError(`unknown work giver: ${id}`)
    return found
  }

  driver(id: string): Driver {
    const found = this.drivers.get(id)
    if (found === undefined) throw definitionError(`unknown driver: ${id}`)
    return found
  }

  /** Returns the first schema violation for driver params, if any. */
  validateDriverParams(id: string, params: Record<string, JsonValue>): ValidationIssue | undefined {
    return validateParams(this.driver(id).schema, params)
  }
}

function assertId(id: string, kind: string): void {
  if (id.length === 0) throw definitionError(`${kind} id must not be empty`)
}

function duplicateError(kind: string, id: string): P2Error {
  return definitionError(`duplicate ${kind} id: ${id}`, { kind, id })
}

function definitionError(message: string, details?: JsonValue): P2Error {
  return p2Error(
    ErrorCodes.DEFINITION_ERROR,
    'validation',
    message,
    { module: 'mind.registry' },
    details,
  )
}

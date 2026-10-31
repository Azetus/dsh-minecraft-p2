import { describe, expect, it } from 'vitest'

import { Registry } from '../src/mind/registry.ts'
import type { Driver, WorkGiver, WorldView } from '../src/mind/types.ts'

/**
 * Category: data integrity (definition loading, TODO M1-01).
 * Protects: no runtime starts from an unknown id or an unchecked schema.
 * Failure modes: a typo in a tree/giver id silently selects nothing, and bad
 * driver params reach execution because the schema was ignored.
 */

function fakeGiver(id: string): WorkGiver {
  return { id, find: () => null }
}

function fakeDriver(id: string, schema: Driver['schema'] = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
  additionalProperties: false,
}): Driver {
  return {
    id,
    schema,
    defaults: {
      budget: { maxTicks: 20, maxWallMs: 1_000 },
      interrupt: 'constant-only',
      suspendable: true,
    },
    validate: () => ({ ok: true }),
    start: () => { throw new Error('not used in registry tests') },
  }
}

const world = {} as WorldView

function errorCode(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('mind registry', () => {
  it('resolves registered predicates, givers and drivers by stable id', () => {
    const registry = new Registry()
    registry.registerPredicate({ id: 'isDay', fn: (_ctx, _world) => 'unknown' })
    registry.registerGiver({ id: 'wander', factory: () => fakeGiver('wander') })
    registry.registerDriver({ id: 'move', driver: fakeDriver('move') })

    expect(registry.predicate('isDay').fn({ now: 0 }, world)).toBe('unknown')
    expect(registry.giver('wander').id).toBe('wander')
    expect(registry.driver('move').id).toBe('move')
  })

  it('rejects unknown ids', () => {
    const registry = new Registry()
    expect(errorCode(() => registry.predicate('nope'))).toBe('DEFINITION_ERROR')
    expect(errorCode(() => registry.giver('nope'))).toBe('DEFINITION_ERROR')
    expect(errorCode(() => registry.driver('nope'))).toBe('DEFINITION_ERROR')
  })

  it('rejects duplicate definitions and giver/driver id mismatches', () => {
    const registry = new Registry()
    registry.registerGiver({ id: 'wander', factory: () => fakeGiver('wander') })
    expect(errorCode(() => registry.registerGiver({ id: 'wander', factory: () => fakeGiver('wander') })))
      .toBe('DEFINITION_ERROR')
    expect(errorCode(() => registry.registerGiver({ id: 'escape', factory: () => fakeGiver('other') })))
      .toBe('DEFINITION_ERROR')
    expect(errorCode(() => registry.registerDriver({ id: 'move', driver: fakeDriver('other') })))
      .toBe('DEFINITION_ERROR')
  })

  it('rejects schemas outside the supported subset at registration', () => {
    const registry = new Registry()
    expect(errorCode(() => registry.registerPredicate({
      id: 'bad',
      schema: { type: 'string', minLength: 2 },
      fn: () => true,
    }))).toBe('DEFINITION_ERROR')
    expect(errorCode(() => registry.registerDriver({
      id: 'move',
      driver: fakeDriver('move', { type: 'object', properties: { x: { type: 'fancy' } } } as unknown as Driver['schema']),
    }))).toBe('DEFINITION_ERROR')
  })

  it('validates driver params against the registered schema', () => {
    const registry = new Registry()
    registry.registerDriver({ id: 'move', driver: fakeDriver('move') })

    expect(registry.validateDriverParams('move', { x: 1, y: 64 })).toBeUndefined()
    expect(registry.validateDriverParams('move', { x: 1 })?.path).toBe('$.y')
    expect(registry.validateDriverParams('move', { x: '1', y: 64 })?.path).toBe('$.x')
    expect(registry.validateDriverParams('move', { x: 1, y: 64, z: 2 })?.path).toBe('$.z')
  })

  it('applies enum, integer and range constraints', () => {
    const registry = new Registry()
    registry.registerDriver({
      id: 'move',
      driver: fakeDriver('move', {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['walk', 'run'] },
          count: { type: 'integer', minimum: 1, maximum: 4 },
        },
        required: ['mode', 'count'],
        additionalProperties: false,
      }),
    })

    expect(registry.validateDriverParams('move', { mode: 'walk', count: 2 })).toBeUndefined()
    expect(registry.validateDriverParams('move', { mode: 'fly', count: 2 })?.path).toBe('$.mode')
    expect(registry.validateDriverParams('move', { mode: 'walk', count: 1.5 })?.path).toBe('$.count')
    expect(registry.validateDriverParams('move', { mode: 'walk', count: 5 })?.path).toBe('$.count')
  })
})

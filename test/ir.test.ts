import { describe, expect, it } from 'vitest'

import {
  act,
  assign,
  booleanParam,
  defineBehavior,
  eq,
  externalCompletion,
  gt,
  ifThen,
  lit,
  local,
  numberParam,
  param,
  query,
  reactivePriority,
  record,
  repeat,
  sequence,
  subtree,
  wait,
  when,
  whenQuery,
  queryRef,
} from '../src/authoring/index.ts'
import { EvalError, evaluate } from '../src/core/expression.ts'
import { BehaviorValidationError, validateBehavior } from '../src/core/validate.ts'
import type { BehaviorDefinition } from '../src/contracts/index.ts'

function definition(overrides: Partial<BehaviorDefinition> = {}): BehaviorDefinition {
  return defineBehavior({
    id: 'collect',
    description: 'collect resources',
    mode: 'finite',
    parameters: {
      resource: { type: 'string', required: true },
      count: { ...numberParam(), default: 2 },
    },
    locals: {
      collected: { type: 'number', initial: 0 },
      target: { type: 'string', initial: 'wood' },
    },
    root: sequence(
      'root',
      assign('set-target', 'target', param('resource')),
      wait('pause', 100),
      query('read', 'inventory.count', { item: local('target') }, 'have', 500),
      act('gather', 'harvest', { item: local('target') }, 'gathered'),
      ifThen(
        'done?',
        when(gt(local('have'), lit(1))),
        assign('increment', 'collected', local('have')),
      ),
    ),
    completion: { kind: 'predicate', condition: when(gt(local('collected'), lit(0))) },
    ...overrides,
  })
}

describe('behavior builder and validation', () => {
  it('accepts a well-formed finite behavior', () => {
    expect(() => validateBehavior(definition())).not.toThrow()
  })

  it('rejects finite behavior without completion and continuous predicate completion', () => {
    const withoutCompletion = definition()
    delete withoutCompletion.completion
    expect(() => validateBehavior(withoutCompletion))
      .toThrow(BehaviorValidationError)
    expect(() => validateBehavior(definition({
      mode: 'continuous',
      completion: { kind: 'predicate', condition: when(lit(true)) },
    }))).toThrow(/continuous/)
  })

  it('rejects duplicate ids, shared nodes, and invalid repeat counts', () => {
    const shared = wait('same', 1)
    const duplicate = definition({
      root: sequence('root', shared, shared),
    })
    expect(() => validateBehavior(duplicate)).toThrow(/shared or cyclic/)

    const duplicateId = definition({
      root: sequence('root', wait('x', 1), wait('x', 2)),
    })
    expect(() => validateBehavior(duplicateId)).toThrow(/duplicate node id/)

    const badRepeat = definition({ root: repeat('r', wait('w', 1), -1) })
    expect(() => validateBehavior(badRepeat)).toThrow(/repeat count/)
  })

  it('supports external completion and nested subtree frames', () => {
    const subtreeNode = subtree(
      'sub',
      sequence('sub-root', assign('sub-assign', 'inner', lit(1))),
      { x: lit(1) },
      { out: 'outer' },
    )
    const behavior = definition({
      root: sequence('root', subtreeNode),
      completion: externalCompletion('player sees the result'),
    })
    expect(() => validateBehavior(behavior)).not.toThrow()
  })
})

describe('expression evaluator', () => {
  const context = {
    params: { resource: 'wood', count: 2 },
    locals: new Map<string, import('../src/contracts/index.ts').JsonValue>([
      ['have', 3],
      ['target', 'wood'],
      ['nested', { item: { name: 'wood' } }],
    ]),
  }

  it('evaluates literals, params, locals, members, records and arrays', () => {
    expect(evaluate(param('resource'), context)).toBe('wood')
    expect(evaluate(record({ item: local('target'), n: lit(1) }), context))
      .toEqual({ item: 'wood', n: 1 })
    expect(evaluate({ kind: 'member', object: local('nested'), key: lit('item') }, context))
      .toEqual({ name: 'wood' })
  })

  it('evaluates comparisons and boolean operators', () => {
    expect(evaluate(gt(local('have'), param('count')), context)).toBe(true)
    expect(evaluate(eq(local('target'), param('resource')), context)).toBe(true)
    expect(evaluate({ kind: 'not', value: eq(local('target'), lit('stone')) }, context)).toBe(true)
  })

  it('returns structured errors for missing or invalid values', () => {
    expect(() => evaluate(local('missing'), context)).toThrow(EvalError)
    try {
      evaluate(param('missing'), context)
      throw new Error('expected PARAM_MISSING')
    } catch (error) {
      expect(error).toBeInstanceOf(EvalError)
      expect((error as EvalError).code).toBe('PARAM_MISSING')
    }
    expect(() => evaluate({ kind: 'binary', op: 'div', left: lit(1), right: lit(0) }, context))
      .toThrow(/division by zero/)
    expect(() => evaluate({ kind: 'member', object: lit(1), key: lit('x') }, context))
      .toThrow(/member access/)
  })

  it('builds query conditions without executing them', () => {
    const condition = whenQuery(queryRef('inventory.count', { item: local('target') }), gt(lit(1), lit(0)))
    expect(condition.kind).toBe('query')
    if (condition.kind !== 'query') throw new Error('expected query condition')
    expect(condition.query.op).toBe('inventory.count')
  })
})

import { describe, expect, it } from 'vitest'

import {
  act,
  assign,
  add,
  defineBehavior,
  eq,
  ifThen,
  lit,
  local,
  query,
  queryRef,
  reactivePriority,
  repeat,
  sequence,
  subtree,
  wait,
  when,
  whenQuery,
} from '../src/authoring/index.ts'
import { BehaviorExecutor } from '../src/core/executor.ts'
import { ActBroker } from '../src/core/broker.ts'
import type {
  ActHandle,
  ActPort,
  ActPoll,
  QueryPort,
} from '../src/core/node-runtime.ts'
import type { BehaviorDefinition } from '../src/contracts/index.ts'

const noQuery: QueryPort = () => ({ status: 'ok', value: null })
const noAct: ActPort = {
  start: () => ({ poll: () => ({ status: 'failed', error: { code: 'NO_ACT', category: 'runtime', message: 'no act', source: { module: 'test' }, retry: 'never' } }), stop: () => {} }),
}

function executor(
  definition: BehaviorDefinition,
  options: { query?: QueryPort; act?: ActPort; params?: Record<string, import('../src/contracts/index.ts').JsonValue> } = {},
): BehaviorExecutor {
  return new BehaviorExecutor({
    definition,
    params: options.params ?? {},
    query: options.query ?? noQuery,
    act: options.act ?? noAct,
  })
}

function finite(root: BehaviorDefinition['root'], condition = when(eq(lit(1), lit(1)))): BehaviorDefinition {
  return defineBehavior({
    id: 'test',
    description: 'test',
    mode: 'finite',
    parameters: {},
    locals: {},
    root,
    completion: { kind: 'predicate', condition },
  })
}

describe('behavior executor control structures', () => {
  it('makes same-tick assignments visible and completes a predicate', () => {
    const behavior = defineBehavior({
      ...finite(sequence(
        'root',
        assign('a', 'x', lit(1)),
        ifThen('check', when(eq(local('x'), lit(1))), assign('b', 'y', lit(2))),
      )),
      locals: { x: { type: 'number' }, y: { type: 'number' } },
      completion: { kind: 'predicate', condition: when(eq(local('y'), lit(2))) },
    })
    const run = executor(behavior)
    expect(run.tick(0)).toBe('succeeded')
    expect(run.frame.get('x')).toBe(1)
    expect(run.frame.get('y')).toBe(2)
  })

  it('keeps wait across ticks and cancels without publishing terminal success', () => {
    const run = executor(defineBehavior({
      ...finite(sequence('root', wait('w', 100), assign('done', 'x', lit(1)))),
      locals: { x: { type: 'number' } },
      completion: { kind: 'predicate', condition: when(eq(local('x'), lit(1))) },
    }))
    expect(run.tick(0)).toBe('running')
    expect(run.tick(50)).toBe('running')
    run.stop()
    expect(run.tick(60)).toBe('cancelled')
    expect(run.frame.get('x')).toBeUndefined()
  })

  it('runs finite repeat on later ticks and keeps parents alive', () => {
    const run = executor(defineBehavior({
      ...finite(repeat('r', assign('inc', 'n', add(local('n'), lit(1))), 2)),
      locals: { n: { type: 'number', initial: 0 } },
      completion: { kind: 'predicate', condition: when(eq(local('n'), lit(2))) },
    }))
    expect(run.tick(0)).toBe('running')
    expect(run.frame.get('n')).toBe(1)
    expect(run.tick(1)).toBe('succeeded')
    expect(run.frame.get('n')).toBe(2)
  })

  it('uses a subtree frame and publishes only declared outputs', () => {
    const run = executor(defineBehavior({
      ...finite(sequence(
        'root',
        subtree(
          'sub',
          sequence('sub-root', assign('inner', 'value', lit(7))),
          {},
          { out: 'value' },
        ),
        assign('copy', 'copied', local('out')),
      )),
      locals: { out: { type: 'number' }, copied: { type: 'number' } },
      completion: { kind: 'predicate', condition: when(eq(local('copied'), lit(7))) },
    }))
    expect(run.tick(0)).toBe('succeeded')
    expect(run.frame.get('copied')).toBe(7)
    expect(run.frame.getSlot('out')?.meta.source).toBe('assign')
    expect(run.frame.getSlot('out')?.meta.scope).toBe('inner')
  })

  it('keeps query output provenance when copying through a subtree', () => {
    const queryPort: QueryPort = () => ({
      status: 'ok',
      value: 3,
      meta: { source: 'query', scope: 'inventory', sampledAt: 10, validUntil: 100 },
    })
    const run = executor(defineBehavior({
      ...finite(sequence(
        'root',
        query('q', 'count', {}, 'have'),
        subtree('sub', sequence('sub-root'), { have: local('have') }, { copy: 'have' }),
      )),
      locals: { have: { type: 'number' }, copy: { type: 'number' } },
      completion: { kind: 'predicate', condition: when(eq(local('copy'), lit(3))) },
    }), { query: queryPort })
    expect(run.tick(0)).toBe('succeeded')
    expect(run.frame.getSlot('copy')?.meta).toMatchObject({
      source: 'query',
      scope: 'inventory',
      sampledAt: 10,
      validUntil: 100,
    })
  })

  it('fails with GOAL_NOT_MET when the tree ends without the predicate', () => {
    const run = executor(finite(sequence('root', assign('a', 'x', lit(1))), when(eq(local('x'), lit(2)))))
    expect(run.tick(0)).toBe('failed')
    expect(run.currentError?.code).toBe('GOAL_NOT_MET')
  })

  it('lets a satisfied goal win over an ordinary environment failure', () => {
    const queryPort: QueryPort = ref => ref.op === 'goal'
      ? { status: 'ok', value: true }
      : {
          status: 'failed',
          error: {
            code: 'MATERIAL_MISSING',
            category: 'environment',
            message: 'missing material',
            source: { module: 'test' },
            retry: 'never',
          },
        }
    const run = executor(defineBehavior({
      id: 'goal-over-environment',
      description: 'environment race',
      mode: 'finite',
      parameters: {},
      locals: { have: { type: 'number' } },
      root: query('q', 'inventory.count', {}, 'have'),
      completion: { kind: 'predicate', condition: whenQuery(queryRef('goal'), eq(local('result'), lit(true))) },
    }), { query: queryPort })
    expect(run.tick(0)).toBe('succeeded')
    expect(run.lastFailure?.code).toBe('MATERIAL_MISSING')
  })

  it('gives a pre-tick stop priority over a tree that would succeed', () => {
    const run = executor(finite(assign('a', 'x', lit(1))))
    run.stop()
    expect(run.tick(0)).toBe('cancelled')
    expect(run.frame.get('x')).toBeUndefined()
  })

  it('requires a fresh final completion query before succeeding', () => {
    let calls = 0
    const queryPort: QueryPort = () => {
      calls += 1
      return { status: 'ok', value: calls === 1 }
    }
    const run = executor(defineBehavior({
      id: 'fresh',
      description: 'fresh completion',
      mode: 'finite',
      parameters: {},
      locals: {},
      root: sequence('root'),
      completion: { kind: 'predicate', condition: whenQuery(queryRef('goal'), eq(local('result'), lit(true))) },
    }), { query: queryPort })
    expect(run.tick(0)).toBe('running')
    expect(calls).toBe(1)
    expect(run.tick(1)).toBe('failed')
    expect(run.currentError?.code).toBe('GOAL_NOT_MET')
    expect(calls).toBe(2)
  })

  it('rejects a continuous tree that ends', () => {
    const run = executor(defineBehavior({
      id: 'continuous',
      description: 'continuous',
      mode: 'continuous',
      parameters: {},
      locals: {},
      root: sequence('root'),
    }))
    expect(run.tick(0)).toBe('failed')
    expect(run.currentError?.code).toBe('CONTINUOUS_TREE_ENDED')
  })

  it('preserves the old local value when an assign expression fails', () => {
    const run = executor(defineBehavior({
      ...finite(assign('bad', 'x', local('missing'))),
      locals: { x: { type: 'number', initial: 5 } },
    }))
    expect(run.tick(0)).toBe('failed')
    expect(run.frame.get('x')).toBe(5)
  })
})

describe('behavior executor query and act ports', () => {
  it('queries once, writes output, and never retries a failed query', () => {
    let calls = 0
    const queryPort: QueryPort = () => {
      calls += 1
      return { status: 'ok', value: 3 }
    }
    const run = executor(defineBehavior({
      ...finite(sequence('root', query('q', 'count', {}, 'have'), assign('copy', 'seen', local('have')))),
      locals: { have: { type: 'number' }, seen: { type: 'number' } },
      completion: { kind: 'predicate', condition: when(eq(local('seen'), lit(3))) },
    }), { query: queryPort })
    expect(run.tick(0)).toBe('succeeded')
    expect(calls).toBe(1)
  })

  it('does not publish act output until the act succeeds', () => {
    let polls = 0
    let stopped = 0
    const handle: ActHandle = {
      poll: (): ActPoll => {
        polls += 1
        return polls < 2 ? { status: 'running' } : { status: 'succeeded', result: 9 }
      },
      stop: () => { stopped += 1 },
    }
    const actPort: ActPort = { start: () => handle }
    const run = executor(defineBehavior({
      ...finite(sequence('root', act('a', 'harvest', {}, 'gathered'), assign('copy', 'seen', local('gathered')))),
      locals: { gathered: { type: 'number' }, seen: { type: 'number' } },
      completion: { kind: 'predicate', condition: when(eq(local('seen'), lit(9))) },
    }), { act: actPort })
    expect(run.tick(0)).toBe('running')
    expect(run.frame.get('seen')).toBeUndefined()
    expect(run.tick(1)).toBe('succeeded')
    expect(run.frame.get('seen')).toBe(9)
    expect(stopped).toBe(0)
  })

  it('does not publish an act output when the act fails', () => {
    const handle: ActHandle = {
      poll: () => ({
        status: 'failed',
        error: {
          code: 'ACT_RUNTIME_ERROR',
          category: 'runtime',
          message: 'missing',
          source: { module: 'test' },
          retry: 'never',
        },
      }),
      stop: () => {},
    }
    const run = executor(defineBehavior({
      ...finite(sequence('root', act('a', 'craft', {}, 'result'))),
      locals: { result: { type: 'number' } },
    }), { act: { start: () => handle } })
    expect(run.tick(0)).toBe('failed')
    expect(run.frame.get('result')).toBeUndefined()
  })

  it('fails a query once without retrying', () => {
    let calls = 0
    const queryPort: QueryPort = () => {
      calls += 1
      return {
        status: 'failed',
        error: {
          code: 'QUERY_FAILED',
          category: 'runtime',
          message: 'query failed',
          source: { module: 'test' },
          retry: 'never',
        },
      }
    }
    const run = executor(defineBehavior({
      ...finite(sequence('root', query('q', 'count', {}, 'have'))),
      locals: { have: { type: 'number' } },
    }), { query: queryPort })
    expect(run.tick(0)).toBe('failed')
    expect(calls).toBe(1)
  })

  it('stops the active act when cancelled and never publishes its output', () => {
    let stopped = 0
    const handle: ActHandle = {
      poll: () => ({ status: 'running' }),
      stop: () => { stopped += 1 },
    }
    const run = executor(defineBehavior({
      ...finite(sequence('root', act('a', 'mine', {}, 'result'))),
      locals: { result: { type: 'number' } },
    }), { act: { start: () => handle } })
    expect(run.tick(0)).toBe('running')
    run.stop()
    expect(run.tick(1)).toBe('cancelled')
    expect(stopped).toBe(1)
    expect(run.frame.get('result')).toBeUndefined()
  })

  it('turns a failed act stop into a control fault, not cancelled', () => {
    const handle: ActHandle = {
      poll: () => ({ status: 'running' }),
      stop: () => { throw new Error('cleanup failed') },
    }
    const run = executor(defineBehavior({
      ...finite(sequence('root', act('a', 'mine', {}, 'result'))),
      locals: { result: { type: 'number' } },
    }), { act: { start: () => handle } })
    expect(run.tick(0)).toBe('running')
    run.stop()
    expect(run.tick(1)).toBe('failed')
    expect(run.currentError?.code).toBe('ACT_STOP_FAILED')
  })

  it('waits for act cleanup before reporting cancelled', () => {
    const broker = new ActBroker({ cleanupTimeoutMs: 500 })
    let cleanupCalls = 0
    broker.register('cleanup', (): ActHandle => ({
      poll: () => ({ status: 'running' }),
      stop: () => {},
      cleanup: () => {
        cleanupCalls += 1
        return cleanupCalls === 1 ? { status: 'running' } : { status: 'succeeded' }
      },
    }))
    const run = executor(defineBehavior({
      ...finite(sequence('root', act('a', 'cleanup', {}, 'result'))),
      locals: { result: { type: 'number' } },
    }), { act: broker })
    expect(run.tick(0)).toBe('running')
    run.stop()
    expect(run.tick(1)).toBe('running')
    expect(run.tick(2)).toBe('cancelled')
    expect(cleanupCalls).toBe(2)
  })

  it('faults when act cleanup exceeds its deadline', async () => {
    const broker = new ActBroker({ cleanupTimeoutMs: 10 })
    broker.register('slow-cleanup', (): ActHandle => ({
      poll: () => ({ status: 'running' }),
      stop: () => {},
      cleanup: () => ({ status: 'running' }),
    }))
    const run = executor(defineBehavior({
      ...finite(sequence('root', act('a', 'slow-cleanup', {}, 'result'))),
      locals: { result: { type: 'number' } },
    }), { act: broker })
    expect(run.tick(0)).toBe('running')
    run.stop()
    expect(run.tick(1)).toBe('running')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(run.tick(2)).toBe('failed')
    expect(run.currentError?.code).toBe('STOP_TIMEOUT')
  })

  it('switches reactive branches by cancelling the old child first', () => {
    let starts: string[] = []
    let stops: string[] = []
    const makeHandle = (name: string): ActHandle => {
      starts.push(name)
      return {
        poll: () => ({ status: 'running' }),
        stop: () => { stops.push(name) },
      }
    }
    const actPort: ActPort = { start: name => makeHandle(name) }
    const run = executor(defineBehavior({
      ...finite(reactivePriority('select', [
        { when: when(eq(local('mode'), lit('attack'))), child: act('attack', 'attack') },
        { when: when(eq(local('mode'), lit('idle'))), child: act('idle', 'idle') },
      ])),
      locals: { mode: { type: 'string', initial: 'attack' } },
      completion: { kind: 'predicate', condition: when(eq(local('mode'), lit('idle'))) },
    }), { act: actPort })
    expect(run.tick(0)).toBe('running')
    expect(starts).toEqual(['attack'])
    run.frame.set('mode', 'idle')
    expect(run.tick(1)).toBe('running')
    expect(stops).toEqual(['attack'])
    expect(starts).toEqual(['attack', 'idle'])
  })
})

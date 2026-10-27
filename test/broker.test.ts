import { describe, expect, it } from 'vitest'

import { assign, defineBehavior, eq, ifThen, lit, local, query, queryRef, sequence, when, whenQuery } from '../src/authoring/index.ts'
import { ActBroker, QueryBroker } from '../src/core/broker.ts'
import { BehaviorExecutor } from '../src/core/executor.ts'
import type { ActHandle, ActPoll, QueryOutcome } from '../src/core/node-runtime.ts'

describe('ActBroker', () => {
  it('allows only one active act and allows a new one after stop', () => {
    const broker = new ActBroker()
    let stops = 0
    broker.register('fake', (): ActHandle => ({
      poll: (): ActPoll => ({ status: 'running' }),
      stop: () => { stops += 1 },
    }))
    const first = broker.start('fake', {})
    expect(broker.activeName).toBe('fake')
    expect(() => broker.start('fake', {})).toThrow(/still active/)
    first.stop()
    expect(stops).toBe(1)
    expect(broker.activeName).toBeUndefined()
    const second = broker.start('fake', {})
    expect(second).toBeDefined()
    broker.stopActive()
    expect(stops).toBe(2)
  })

  it('releases control when the runner reaches a terminal state', () => {
    const broker = new ActBroker()
    let polls = 0
    broker.register('once', (): ActHandle => ({
      poll: () => {
        polls += 1
        return polls === 1 ? { status: 'running' } : { status: 'succeeded', result: 1 }
      },
      stop: () => {},
    }))
    const handle = broker.start('once', {})
    expect(handle.poll().status).toBe('running')
    expect(broker.activeName).toBe('once')
    expect(handle.poll().status).toBe('succeeded')
    expect(broker.activeName).toBeUndefined()
    expect(() => broker.start('once', {})).not.toThrow()
  })

  it('rejects unknown acts and surfaces stop failures', () => {
    const broker = new ActBroker()
    expect(() => broker.start('missing', {})).toThrow(/unknown act/)
    broker.register('bad-stop', (): ActHandle => ({
      poll: () => ({ status: 'running' }),
      stop: () => { throw new Error('cleanup failed') },
    }))
    const handle = broker.start('bad-stop', {})
    expect(() => handle.stop()).toThrow(/cleanup failed/)
  })
})

describe('QueryBroker', () => {
  it('returns registered values and never retries failures', () => {
    const broker = new QueryBroker()
    broker.register('ok', () => ({ status: 'ok', value: 4 }))
    broker.register('bad', () => ({ status: 'failed', error: { code: 'FAIL', category: 'environment', message: 'bad', source: { module: 'test' }, retry: 'never' } }))
    expect(broker.query({ op: 'ok', args: {} }, {})).toEqual({ status: 'ok', value: 4 })
    expect(broker.query({ op: 'bad', args: {} }, {}).status).toBe('failed')
    expect(broker.query({ op: 'missing', args: {} }, {}).status).toBe('failed')
    expect(broker.calls).toBe(3)
  })

  it('passes pending queries through and allows a single poll to complete', () => {
    const broker = new QueryBroker()
    let polls = 0
    broker.register('slow', (): QueryOutcome => ({
      status: 'pending',
      poll: () => {
        polls += 1
        return polls === 1
          ? { status: 'pending', poll: () => ({ status: 'ok', value: 1 }) }
          : { status: 'ok', value: 1 }
      },
    }))
    const first = broker.query({ op: 'slow', args: {} }, {})
    expect(first.status).toBe('pending')
    if (first.status !== 'pending') throw new Error('expected pending')
    const second = first.poll()
    expect(second.status).toBe('pending')
    if (second.status !== 'pending') throw new Error('expected pending')
    expect(second.poll()).toEqual({ status: 'ok', value: 1 })
  })

  it('drives a pending query to a single executor output', () => {
    const broker = new QueryBroker()
    broker.register('slow', (): QueryOutcome => ({
      status: 'pending',
      poll: () => ({ status: 'ok', value: 8 }),
    }))
    const definition = defineBehavior({
      id: 'pending',
      description: 'pending query',
      mode: 'finite',
      parameters: {},
      locals: { have: { type: 'number' }, seen: { type: 'number' } },
      root: sequence('root', query('q', 'slow', {}, 'have'), assign('copy', 'seen', local('have'))),
      completion: { kind: 'predicate', condition: when(eq(local('seen'), lit(8))) },
    })
    const run = new BehaviorExecutor({
      definition,
      params: {},
      query: broker.asPort(),
      act: new ActBroker(),
    })
    expect(run.tick(0)).toBe('running')
    expect(run.tick(1)).toBe('succeeded')
    expect(run.frame.get('seen')).toBe(8)
  })

  it('polls a pending query condition once and reuses its result', () => {
    const broker = new QueryBroker()
    broker.register('guard', (): QueryOutcome => ({
      status: 'pending',
      poll: () => ({ status: 'ok', value: 1 }),
    }))
    const definition = defineBehavior({
      id: 'guard',
      description: 'query guard',
      mode: 'finite',
      parameters: {},
      locals: { ok: { type: 'number' } },
      root: ifThen(
        'if',
        whenQuery(queryRef('guard'), eq(local('result'), lit(1))),
        assign('set', 'ok', lit(1)),
      ),
      completion: { kind: 'predicate', condition: when(eq(local('ok'), lit(1))) },
    })
    const run = new BehaviorExecutor({
      definition,
      params: {},
      query: broker.asPort(),
      act: new ActBroker(),
    })
    expect(run.tick(0)).toBe('running')
    expect(run.tick(1)).toBe('succeeded')
    expect(broker.calls).toBe(1)
  })
})

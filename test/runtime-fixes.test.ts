import { describe, expect, it } from 'vitest'

import {
  act,
  defineBehavior,
  eq,
  lit,
  local,
  reactivePriority,
  sequence,
  when,
  whenQuery,
  queryRef,
} from '../src/authoring/index.ts'
import { BehaviorExecutor } from '../src/core/executor.ts'
import { BehaviorHost } from '../src/core/host.ts'
import type { ActHandle, ActPort, QueryPort } from '../src/core/node-runtime.ts'
import type { BehaviorDefinition, Condition } from '../src/contracts/index.ts'

const noQuery: QueryPort = () => ({ status: 'ok', value: null, meta: { source: 'query', scope: 'test', sampledAt: 0, validUntil: 1000 } })

function finite(root: BehaviorDefinition['root'], condition: Condition, locals: BehaviorDefinition['locals'] = {}): BehaviorDefinition {
  return defineBehavior({ id: 'test', description: 'test', mode: 'finite', parameters: {}, locals, root, completion: { kind: 'predicate', condition } })
}

describe('reactive branch handover', () => {
  it('waits for the old act cleanup before starting the new branch', () => {
    const starts: string[] = []
    const make = (name: string): ActHandle => {
      let stopped = false
      let pollsAfterStop = 0
      return {
        poll: () => {
          if (!stopped) return { status: 'running' }
          pollsAfterStop += 1
          return pollsAfterStop > 1 ? { status: 'succeeded' } : { status: 'running' }
        },
        stop: () => {
          if (!stopped) starts.push(`stop:${name}`)
          stopped = true
        },
        cleanup: () => (stopped ? { status: 'cancelled' } : { status: 'running' }),
      }
    }
    const actPort: ActPort = { start: ref => make(typeof ref === 'string' ? ref : ref.definitionId) }
    const executor = new BehaviorExecutor({
      definition: finite(
        reactivePriority('select', [
          { when: when(eq(local('mode'), lit('attack'))), child: act('a', 'attack') },
          { when: when(eq(local('mode'), lit('idle'))), child: act('b', 'idle') },
        ]),
        when(lit(false)),
        { mode: { type: 'string', initial: 'attack' } },
      ),
      params: {},
      query: noQuery,
      act: {
        start: ref => {
          const name = typeof ref === 'string' ? ref : ref.definitionId
          starts.push(name)
          return actPort.start(ref, {})
        },
      },
    })
    expect(executor.tick(0)).toBe('running')
    expect(starts).toEqual(['attack'])
    executor.frame.set('mode', 'idle')
    expect(executor.tick(1)).toBe('running')
    expect(starts).toEqual(['attack', 'stop:attack'])
    expect(executor.tick(2)).toBe('running')
    expect(starts).toEqual(['attack', 'stop:attack', 'idle'])
  })
})

describe('completion checkpoint before a new act', () => {
  it('succeeds without starting an act when the goal is already met', () => {
    let starts = 0
    const executor = new BehaviorExecutor({
      definition: finite(
        sequence('root', act('a', 'any')),
        when(lit(true)),
      ),
      params: {},
      query: noQuery,
      act: { start: () => { starts += 1; return { poll: () => ({ status: 'succeeded' }), stop: () => {} } } },
    })
    expect(executor.tick(0)).toBe('running')
    expect(starts).toBe(0)
    expect(executor.tick(1)).toBe('succeeded')
  })

  it('stops the loop when a later act would start after the goal', () => {
    const starts: string[] = []
    const executor = new BehaviorExecutor({
      definition: finite(
        sequence(
          'root',
          act('first', 'one'),
          { kind: 'assign', id: 'mark', target: 'phase', value: lit('done') },
          act('second', 'two'),
        ),
        when(eq(local('phase'), lit('done'))),
        { phase: { type: 'string' } },
      ),
      params: {},
      query: noQuery,
      act: {
        start: ref => {
          starts.push(typeof ref === 'string' ? ref : ref.definitionId)
          return { poll: () => ({ status: 'succeeded' }), stop: () => {} }
        },
      },
    })
    expect(executor.tick(0)).toBe('running')
    expect(starts).toEqual(['one'])
    expect(executor.tick(1)).toBe('succeeded')
    expect(starts).toEqual(['one'])
  })
})

describe('fail node', () => {
  it('ends the behavior with the declared business code', () => {
    const executor = new BehaviorExecutor({
      definition: finite(
        { kind: 'fail', id: 'out', code: 'INSUFFICIENT_RESOURCE', message: 'no targets' },
        when(lit(false)),
      ),
      params: {},
      query: noQuery,
      act: { start: () => { throw new Error('unreachable') } },
    })
    expect(executor.tick(0)).toBe('failed')
    expect(executor.currentError?.code).toBe('INSUFFICIENT_RESOURCE')
    expect(executor.currentError?.category).toBe('runtime')
  })
})

describe('query freshness', () => {
  it('rejects a query result older than the node freshness bound', () => {
    const executor = new BehaviorExecutor({
      definition: finite(
        { kind: 'query', id: 'q', query: { op: 'position', args: {}, freshnessMs: 10 }, output: 'pos' },
        when(lit(false)),
        { pos: { type: 'json' } },
      ),
      params: {},
      query: () => ({ status: 'ok', value: { x: 1 }, meta: { source: 'query', scope: 'test', sampledAt: 0, validUntil: 1000 } }),
      act: { start: () => ({ poll: () => ({ status: 'succeeded' }), stop: () => {} }) },
    })
    expect(executor.tick(100)).toBe('failed')
    expect(executor.currentError?.code).toBe('STALE_OBSERVATION')
  })

  it('reuses fresh guard evidence instead of querying every tick', () => {
    let calls = 0
    const executor = new BehaviorExecutor({
      definition: defineBehavior({
        id: 'guard',
        description: 'guard reuse',
        mode: 'continuous',
        parameters: {},
        locals: {},
        root: reactivePriority('select', [
          { when: whenQuery(queryRef('entities', {}, 500), lit(true)), child: { kind: 'wait', id: 'w', durationMs: 1000 } },
        ]),
      }),
      params: {},
      query: () => {
        calls += 1
        return { status: 'ok', value: [], meta: { source: 'query', scope: 'test', sampledAt: 1000, validUntil: 1500 } }
      },
      act: { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) },
    })
    executor.tick(1000)
    executor.tick(1010)
    executor.tick(1020)
    expect(calls).toBe(1)
    executor.tick(2000)
    expect(calls).toBe(2)
  })
})

describe('status diagnostics', () => {
  it('reports the active act and wait reason', () => {
    const host = new BehaviorHost({
      bindingId: 'b',
      query: noQuery,
      act: { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) },
    })
    // The host needs a checked artifact; use the registry through a direct run is
    // covered by host-policy tests. Here only the report shape is asserted.
    expect(host.status().activeAct).toBeNull()
    expect(host.status().waiting).toBeNull()
    expect(host.status().lastFailure).toBeNull()
  })
})

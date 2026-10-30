import { describe, expect, it } from 'vitest'

import { DeclaredOpBroker } from '../src/core/op-broker.ts'
import type { OpSource } from '../src/core/op-broker.ts'
import type { ActHandle, ActPoll, QueryOutcome } from '../src/core/node-runtime.ts'
import {
  OPERATION_CONTRACTS,
  operationContract,
  operationIds,
  requireOperation,
} from '../src/operation/index.ts'

class FakeHandle implements ActHandle {
  private status: 'running' | 'succeeded' = 'running'
  stopped = false

  poll(): ActPoll {
    return this.status === 'running' ? { status: 'running' } : { status: 'succeeded', result: { ok: true } }
  }

  stop(): void {
    this.stopped = true
    this.status = 'succeeded'
  }
}

function fakeSource(): OpSource & { started: string[]; queries: string[] } {
  const started: string[] = []
  const queries: string[] = []
  const source = {
    started,
    queries,
    start(name: string): ActHandle {
      started.push(name)
      return new FakeHandle()
    },
    query(op: string): QueryOutcome {
      queries.push(op)
      return { status: 'ok', value: { op } }
    },
  }
  return source
}

describe('operation declarations', () => {
  it('declares the baseline query and control operations', () => {
    expect(operationIds('query')).toEqual([
      'position', 'inventory', 'health', 'entities', 'blocks', 'block', 'time',
      'equipment', 'entity', 'players', 'recipe', 'container', 'offers', 'weather',
    ])
    expect(operationIds('control')).toEqual([
      'look', 'lookAt', 'move', 'forward', 'back', 'left', 'right', 'jump', 'pillar', 'moveTo', 'goto', 'follow', 'stop',
      'dig', 'place', 'replace', 'attack', 'equip', 'unequip', 'use', 'consume',
      'craft', 'container-transfer', 'toss', 'respawn', 'sleep', 'interact', 'activate', 'mount', 'dismount',
      'drive', 'place-entity', 'fish', 'trade',
    ])
    expect(operationContract('dig')).toMatchObject({ kind: 'control', effects: 'active', stop: 'poll' })
    expect(operationContract('jump')).toMatchObject({ concurrent: true })
    expect(operationContract('pillar')).toMatchObject({ kind: 'control', effects: 'active', capabilities: ['move', 'place'] })
    expect(operationContract('craft')).toMatchObject({ kind: 'control', capabilities: ['craft'] })
    expect(operationContract('container')).toMatchObject({ kind: 'query', capabilities: ['container'] })
    expect(operationContract('goto')).toMatchObject({ kind: 'control', capabilities: ['pathfind'] })
    expect(OPERATION_CONTRACTS.length).toBe(48)
  })

  it('rejects unknown operations and kind mismatches', () => {
    expect(() => requireOperation('nope', 'query', 'test')).toThrow(/unknown operation/u)
    expect(() => requireOperation('moveTo', 'query', 'test')).toThrow(/is control, not query/u)
    expect(() => requireOperation('position', 'control', 'test')).toThrow(/is query, not control/u)
  })
})

describe('DeclaredOpBroker', () => {
  it('delegates declared operations and validates kinds', () => {
    const source = fakeSource()
    const broker = new DeclaredOpBroker(source)
    broker.query('position', {})
    expect(source.queries).toEqual(['position'])
    expect(() => broker.query('moveTo', {})).toThrow(/is control, not query/u)

    const handle = broker.start('moveTo', { x: 1, z: 2 })
    expect(handle.poll().status).toBe('running')
    expect(source.started).toEqual(['moveTo'])
    expect(() => broker.start('dig', { x: 1, y: 2, z: 3 })).toThrow(/still active/u)
  })

  it('clears the active operation when it terminates', () => {
    const source = fakeSource()
    const broker = new DeclaredOpBroker(source)
    const first = broker.start('stop', {})
    expect(broker.activeName).toBe('stop')
    first.stop()
    first.poll()
    expect(broker.activeName).toBeUndefined()
    expect(() => broker.start('stop', {})).not.toThrow()
  })

  it('counts budgeted operations per run', () => {
    const source = fakeSource()
    const broker = new DeclaredOpBroker(source, { budgets: { dig: 1 } })
    const first = broker.start('dig', { x: 1, y: 2, z: 3 })
    first.stop()
    first.poll()
    expect(() => broker.start('dig', { x: 1, y: 2, z: 3 })).toThrow(/budget exhausted/u)
  })

  it('fails closed when the provider does not declare an operation capability', () => {
    const source = { ...fakeSource(), capabilities: ['look', 'move'] }
    const broker = new DeclaredOpBroker(source)
    expect(() => broker.query('recipe', { item: 'oak_planks' })).toThrow(/does not declare/u)
    expect(() => broker.start('craft', { item: 'oak_planks' })).toThrow(/does not declare/u)
    expect(() => broker.start('moveTo', { x: 1, z: 2 })).not.toThrow()
    expect(source.started).toEqual(['moveTo'])
  })

  it('rejects unknown control operations before reaching the provider', () => {
    const source = fakeSource()
    const broker = new DeclaredOpBroker(source)
    expect(() => broker.start('teleport', {})).toThrow(/unknown operation/u)
    expect(source.started).toEqual([])
  })
})




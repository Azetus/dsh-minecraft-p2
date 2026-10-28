import { describe, expect, it } from 'vitest'
import { DeclaredOpBroker } from '../src/core/op-broker.ts'
import type { ActHandle } from '../src/core/node-runtime.ts'

type Entry = { name: string; done: boolean; stopped: number }

function fakeSource(): { source: { start: (name: string) => ActHandle; query: () => { status: 'ok'; value: null } }; entries: Entry[] } {
  const entries: Entry[] = []
  return {
    entries,
    source: {
      start(name: string): ActHandle {
        const entry: Entry = { name, done: false, stopped: 0 }
        entries.push(entry)
        return {
          poll: () => (entry.done ? { status: 'succeeded' } : { status: 'running' }),
          stop: () => {
            entry.stopped += 1
          },
        }
      },
      query: () => ({ status: 'ok' as const, value: null }),
    },
  }
}

describe('DeclaredOpBroker control exclusivity', () => {
  it('rejects a second exclusive control while one is running', () => {
    const { source } = fakeSource()
    const broker = new DeclaredOpBroker(source)
    broker.start('move', { durationMs: 100 })
    expect(() => broker.start('goto', { x: 0, y: 64, z: 0 })).toThrowError(/still active/u)
    expect(broker.activeName).toBe('move')
  })

  it('lets a concurrent control run alongside an exclusive one', () => {
    const { source } = fakeSource()
    const broker = new DeclaredOpBroker(source)
    broker.start('move', { durationMs: 100 })
    // jump is declared concurrent, so it may start while moving.
    expect(() => broker.start('jump', {})).not.toThrow()
    // place is exclusive: moving still blocks it, but jump alone would not.
    expect(() => broker.start('place', { x: 0, y: 64, z: 0 })).toThrowError(/still active/u)
  })

  it('allows place while only jump is running, which is the pillar sequence', () => {
    const { source } = fakeSource()
    const broker = new DeclaredOpBroker(source)
    broker.start('jump', {})
    expect(() => broker.start('place', { x: 0, y: 64, z: 0 })).not.toThrow()
  })

  it('stop releases every active control', () => {
    const { source, entries } = fakeSource()
    const broker = new DeclaredOpBroker(source)
    broker.start('move', { durationMs: 100 })
    broker.start('jump', {})
    const stopHandle = broker.start('stop', {})
    expect(entries.filter(entry => entry.name === 'move' || entry.name === 'jump').every(entry => entry.stopped === 1)).toBe(true)
    // A real stop finishes immediately; once it does, other controls may start.
    entries.find(entry => entry.name === 'stop')!.done = true
    expect(stopHandle.poll()).toMatchObject({ status: 'succeeded' })
    expect(() => broker.start('moveTo', { x: 0, z: 0 })).not.toThrow()
  })

  it('clears a finished control so the next exclusive one can start', () => {
    const { source, entries } = fakeSource()
    const broker = new DeclaredOpBroker(source)
    const handle = broker.start('move', { durationMs: 100 })
    entries[0]!.done = true
    expect(handle.poll()).toMatchObject({ status: 'succeeded' })
    expect(() => broker.start('moveTo', { x: 0, z: 0 })).not.toThrow()
  })
})

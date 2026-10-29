import { describe, expect, it } from 'vitest'
import { DeclaredOpBroker } from '../src/core/op-broker.ts'
import type { ControlIdentity, OpSource, ProviderControlState } from '../src/core/op-broker.ts'
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

type LedgerEntry = { name: string; running: boolean; stopped: number }

function ledgerSource(
  onStart?: () => void,
  controlState?: () => ProviderControlState,
): { source: OpSource; entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = []
  return {
    entries,
    source: {
      start(name: string): ActHandle {
        onStart?.()
        if (name === 'goto') throw new Error('start failed')
        const entry: LedgerEntry = { name, running: true, stopped: 0 }
        entries.push(entry)
        return {
          poll: () => (entry.running ? { status: 'running' } : { status: 'succeeded' }),
          stop: () => {
            entry.stopped += 1
            entry.running = false
          },
        }
      },
      query: () => ({ status: 'ok' as const, value: null }),
      ...(controlState === undefined ? {} : { controlState }),
    },
  }
}

const ID: ControlIdentity = { runId: 'run-1', actInstanceId: 'act-1', generation: 1 }

describe('DeclaredOpBroker control ledger and release', () => {
  it('registers the intent before the provider start and keeps it after stop', () => {
    let during: ProviderControlState | undefined
    let broker: DeclaredOpBroker
    const { source, entries } = ledgerSource(() => { during = broker.controlState() })
    broker = new DeclaredOpBroker(source, { settleMs: 300, stopTimeoutMs: 2000 })
    const handle = broker.start('move', {}, ID)
    expect(during).toBe('active')
    handle.stop()
    expect(entries[0]!.stopped).toBe(1)
    broker.stopRun(0, 'run-1')
    expect(broker.pollRelease(0)).toBe('stopping')
    expect(broker.pollRelease(299)).toBe('stopping')
    expect(broker.pollRelease(300)).toBe('released')
    expect(broker.releasePending).toBe(false)
  })

  it('requires provider idle plus the settle window, and accepts late confirmation', () => {
    let provider: ProviderControlState = 'unknown'
    const { source } = ledgerSource(undefined, () => provider)
    const broker = new DeclaredOpBroker(source, { settleMs: 300, stopTimeoutMs: 2000 })
    broker.start('move', {}, ID)
    broker.stopRun(0)
    expect(broker.pollRelease(0)).toBe('stopping')
    expect(broker.pollRelease(2000)).toBe('unconfirmed')
    expect(broker.pollRelease(2100)).toBe('unconfirmed')
    provider = 'idle'
    expect(broker.pollRelease(2200)).toBe('unconfirmed')
    expect(broker.pollRelease(2500)).toBe('released')
  })

  it('does not reset the deadline on repeated stopRun', () => {
    const { source } = ledgerSource(undefined, () => 'idle')
    const broker = new DeclaredOpBroker(source, { settleMs: 300, stopTimeoutMs: 2000 })
    broker.start('move', {}, ID)
    broker.stopRun(0)
    expect(broker.pollRelease(1999)).toBe('stopping')
    broker.stopRun(1500)
    expect(broker.pollRelease(2000)).toBe('unconfirmed')
    expect(broker.pollRelease(2300)).toBe('released')
  })

  it('keeps an unknown intent after a failed start and confirms it through release', () => {
    const { source } = ledgerSource(undefined, () => 'idle')
    const broker = new DeclaredOpBroker(source, { settleMs: 300, stopTimeoutMs: 2000 })
    expect(() => broker.start('goto', {}, ID)).toThrow(/start failed/u)
    expect(broker.controlState()).toBe('unknown')
    broker.stopRun(0)
    expect(broker.pollRelease(0)).toBe('stopping')
    expect(broker.pollRelease(300)).toBe('released')
  })

  it('never releases an unknown intent without a provider verdict', () => {
    const { source } = ledgerSource()
    const broker = new DeclaredOpBroker(source, { settleMs: 300, stopTimeoutMs: 2000 })
    expect(() => broker.start('goto', {}, ID)).toThrow(/start failed/u)
    broker.stopRun(0)
    expect(broker.pollRelease(0)).toBe('stopping')
    expect(broker.pollRelease(2000)).toBe('unconfirmed')
    expect(broker.pollRelease(5000)).toBe('unconfirmed')
  })

  it('reports provider active and unknown through controlState', () => {
    let provider: ProviderControlState = 'active'
    const { source } = ledgerSource(undefined, () => provider)
    const broker = new DeclaredOpBroker(source)
    expect(broker.controlState()).toBe('active')
    provider = 'unknown'
    expect(broker.controlState()).toBe('unknown')
  })
})

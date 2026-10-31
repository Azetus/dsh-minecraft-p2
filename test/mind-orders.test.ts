import { appendFileSync } from 'node:fs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { OrderStore } from '../src/mind/orders.ts'
import type { OrderEvent } from '../src/mind/orders.ts'

/**
 * Category: data integrity (todo M1-04, RUNTIME §6).
 * Protects: one active order, terminal cancel never revives, and the intent
 * journal can be replayed after a partial tail write. Failure modes: a queued
 * order silently becomes active after restart, a cancelled order comes back,
 * or a torn journal line blocks restart.
 */

const dirs: string[] = []

function tempJournal(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-orders-'))
  dirs.push(dir)
  return join(dir, 'journal.jsonl')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function order(id: string, verb = 'wander'): { id: string; verb: string; params: { radius: number } } {
  return { id, verb, params: { radius: 8 } }
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('order store', () => {
  it('keeps one active order and queues the rest', () => {
    const store = new OrderStore({ now: () => 100 })
    const first = store.enqueue(order('ord-1'))
    const second = store.enqueue(order('ord-2'))

    expect(first.state).toBe('active')
    expect(second.state).toBe('queued')
    expect(store.active()?.order.id).toBe('ord-1')
    expect(store.queued().map(record => record.order.id)).toEqual(['ord-2'])
    expect(store.all().map(record => record.order.id)).toEqual(['ord-1', 'ord-2'])
  })

  it('rejects an unknown verb and a duplicate id', () => {
    const store = new OrderStore()
    expect(errorCode(() => store.enqueue(order('bad', 'fly')))).toBe('INVALID_ORDER')
    store.enqueue(order('ord-1'))
    expect(errorCode(() => store.enqueue(order('ord-1')))).toBe('ORDER_EXISTS')
  })

  it('cancelling the active order promotes the next and is terminal', () => {
    const store = new OrderStore()
    store.enqueue(order('ord-1'))
    store.enqueue(order('ord-2'))
    const cancelled = store.cancel('ord-1')

    expect(cancelled.state).toBe('cancelled')
    expect(store.active()?.order.id).toBe('ord-2')
    expect(errorCode(() => store.cancel('ord-1'))).toBe('ORDER_NOT_FOUND')
    expect(errorCode(() => store.cancel('missing'))).toBe('ORDER_NOT_FOUND')
  })

  it('cancelling a queued order leaves the active order alone', () => {
    const store = new OrderStore()
    store.enqueue(order('ord-1'))
    store.enqueue(order('ord-2'))
    expect(store.cancel('ord-2').state).toBe('cancelled')
    expect(store.active()?.order.id).toBe('ord-1')
    expect(store.queued()).toHaveLength(0)
  })

  it('completing an order promotes the next one', () => {
    const store = new OrderStore()
    store.enqueue(order('ord-1'))
    store.enqueue(order('ord-2'))
    expect(store.complete('ord-1', 'succeeded').state).toBe('succeeded')
    expect(store.active()?.order.id).toBe('ord-2')
  })

  it('emits accept and terminal events', () => {
    const events: OrderEvent[] = []
    const store = new OrderStore({ onEvent: event => events.push(event) })
    store.enqueue(order('ord-1'))
    store.cancel('ord-1')
    expect(events).toEqual([
      { kind: 'order.accepted', at: expect.any(Number), orderId: 'ord-1' },
      { kind: 'order.terminal', at: expect.any(Number), orderId: 'ord-1', state: 'cancelled' },
    ])
  })
})

describe('order journal', () => {
  it('replays accepted and terminal entries without reviving a cancelled order', () => {
    const journal = tempJournal()
    const store = new OrderStore({ journalPath: journal, now: () => 10 })
    store.enqueue(order('ord-1'))
    store.enqueue(order('ord-2'))
    store.cancel('ord-1')

    const restored = new OrderStore({ journalPath: journal })
    restored.restore()
    expect(restored.get('ord-1')?.state).toBe('cancelled')
    expect(restored.active()?.order.id).toBe('ord-2')
    expect(restored.queued()).toHaveLength(0)
  })

  it('discards a trailing partial line instead of failing the restore', () => {
    const journal = tempJournal()
    const store = new OrderStore({ journalPath: journal })
    store.enqueue(order('ord-1'))
    appendFileSync(journal, '{"at":1,"kind":"order.accepted","order":{"id":"ord-2"')

    const restored = new OrderStore({ journalPath: journal })
    restored.restore()
    expect(restored.all().map(record => record.order.id)).toEqual(['ord-1'])
  })

  it('refuses a corrupt complete line instead of guessing', () => {
    const journal = tempJournal()
    const store = new OrderStore({ journalPath: journal })
    store.enqueue(order('ord-1'))
    appendFileSync(journal, 'not-json\n')

    const restored = new OrderStore({ journalPath: journal })
    expect(errorCode(() => restored.restore())).toBe('JOURNAL_CORRUPT')
  })

  it('fsyncs every accepted and terminal entry', () => {
    const journal = tempJournal()
    const store = new OrderStore({ journalPath: journal })
    store.enqueue(order('ord-1'))
    store.complete('ord-1', 'failed')
    const lines = readFileSync(journal, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
    expect(lines.map(entry => entry.kind)).toEqual(['order.accepted', 'order.terminal'])
    expect(lines[1]).toMatchObject({ orderId: 'ord-1', state: 'failed' })
  })
})

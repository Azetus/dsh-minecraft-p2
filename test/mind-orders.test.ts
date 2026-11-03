import { appendFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ORDER_VERBS, OrderStore } from '../src/mind/orders.ts'
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

function order(id: string, verb = 'hold'): { id: string; verb: string; params: { radius: number } } {
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

  it('validates the optional hold duration', () => {
    const store = new OrderStore()
    expect(store.enqueue({ id: 'hold-timed', verb: 'hold', params: { durationMs: 1_000 } }).state).toBe('active')
    expect(errorCode(() => store.enqueue({ id: 'hold-short', verb: 'hold', params: { durationMs: 500 } })))
      .toBe('INVALID_ORDER')
    expect(errorCode(() => store.enqueue({ id: 'hold-long', verb: 'hold', params: { durationMs: 3_600_001 } })))
      .toBe('INVALID_ORDER')
  })

  it('accepts only the finite execution surface', () => {
    expect(ORDER_VERBS).toEqual([
      'go', 'place', 'dig', 'equip', 'use', 'attack', 'check', 'container', 'craft', 'build', 'traverse', 'hold',
    ])
    const store = new OrderStore()
    for (const verb of ['fly', 'unknown']) {
      expect(errorCode(() => store.enqueue(order(`bad-${verb}`, verb)))).toBe('INVALID_ORDER')
    }
  })

  it('validates the generic primitive params before execution', () => {
    const store = new OrderStore()
    expect(store.enqueue({ id: 'p', verb: 'place', params: { x: 0, y: 64, z: 0, item: 'dirt' } }).state).toBe('active')
    expect(store.enqueue({ id: 'e', verb: 'equip', params: { item: 'stone_pickaxe' } }).state).toBe('queued')
    expect(errorCode(() => store.enqueue({ id: 'bad-place', verb: 'place', params: { x: 0, y: 64, z: 0 } })))
      .toBe('INVALID_ORDER')
    expect(errorCode(() => store.enqueue({ id: 'bad-use', verb: 'use', params: {} }))).toBe('INVALID_ORDER')
    expect(errorCode(() => store.enqueue({ id: 'bad-craft', verb: 'craft', params: { item: 'stick', count: 0 } })))
      .toBe('INVALID_ORDER')
    expect(errorCode(() => store.enqueue({ id: 'bad-container', verb: 'container',
      params: { x: 0, y: 64, z: 0, action: 'nope', item: 'coal' } }))).toBe('INVALID_ORDER')
    expect(store.enqueue({ id: 'dig-good', verb: 'dig', params: { x: 0, y: 64, z: 0, purpose: 'harvest' } }).state)
      .toBe('queued')
    expect(errorCode(() => store.enqueue({ id: 'dig-bad-purpose', verb: 'dig',
      params: { x: 0, y: 64, z: 0, purpose: 'mine' } }))).toBe('INVALID_ORDER')
    expect(errorCode(() => store.enqueue({ id: 'dig-bad-pos', verb: 'dig', params: { x: 0, y: 64 } })))
      .toBe('INVALID_ORDER')
    expect(store.enqueue({ id: 'dig-volume', verb: 'dig',
      params: { shape: 'box', from: { x: 0, y: 64, z: 0 }, to: { x: 2, y: 64, z: 2 } } }).state)
      .toBe('queued')
    expect(errorCode(() => store.enqueue({ id: 'dig-volume-no-to', verb: 'dig',
      params: { shape: 'box', from: { x: 0, y: 64, z: 0 } } }))).toBe('INVALID_ORDER')
    expect(errorCode(() => store.enqueue({ id: 'dig-line-diagonal', verb: 'dig',
      params: { shape: 'line', from: { x: 0, y: 64, z: 0 }, to: { x: 1, y: 64, z: 1 } } })))
      .toBe('INVALID_ORDER')
    expect(errorCode(() => store.enqueue({ id: 'dig-volume-big', verb: 'dig',
      params: { shape: 'box', from: { x: 0, y: 64, z: 0 }, to: { x: 1, y: 64, z: 1 }, maxBlocks: 65 } })))
      .toBe('INVALID_ORDER')
  })

  it('validates per-order hazard permissions and the traverse verb', () => {
    const store = new OrderStore()
    expect(store.enqueue({
      id: 'ord-hazard',
      verb: 'go',
      params: { x: 0, y: 64, z: 0 },
      policy: { hazards: { allow: ['lethal_fall'], reason: 'test' } },
    }).state).toBe('active')
    expect(errorCode(() => store.enqueue({
      id: 'ord-bad-hazard',
      verb: 'go',
      params: { x: 0, y: 64, z: 0 },
      policy: { hazards: { allow: ['lava', 'not-a-hazard'] } },
    }))).toBe('INVALID_ORDER')
    expect(store.enqueue({
      id: 'ord-traverse',
      verb: 'traverse',
      params: { mode: 'bridge', x: 2, y: 64, z: 0, item: 'dirt' },
    }).state).toBe('queued')
    expect(errorCode(() => store.enqueue({
      id: 'ord-no-material',
      verb: 'traverse',
      params: { mode: 'bridge', x: 2, y: 64, z: 0 },
    }))).toBe('INVALID_ORDER')
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
    expect(lines.every(entry => entry.v === 1)).toBe(true)
  })

  it('records pending actions and drops them when settled', () => {
    const journal = tempJournal()
    const store = new OrderStore({ journalPath: journal })
    store.enqueue(order('ord-1'))
    store.recordActionPending({
      runId: 'run-1',
      driverId: 'place',
      keys: 'plan:plan-1:b:0,0,0',
      orderId: 'ord-1',
      planId: 'plan-1',
      workItemId: 'b:0,0,0',
    })
    expect(store.pendingActions()).toHaveLength(1)

    const restored = new OrderStore({ journalPath: journal })
    restored.restore()
    expect(restored.pendingActions()).toEqual([expect.objectContaining({ runId: 'run-1' })])

    restored.recordActionSettled('run-1', 'succeeded')
    expect(restored.pendingActions()).toHaveLength(0)
    const again = new OrderStore({ journalPath: journal })
    again.restore()
    expect(again.pendingActions()).toHaveLength(0)
  })

  it('refuses a journal version it does not understand', () => {
    const journal = tempJournal()
    writeFileSync(journal, `${JSON.stringify({
      v: 2,
      at: 1,
      kind: 'order.accepted',
      order: { id: 'ord-1', verb: 'hold' },
    })}\n`)
    const restored = new OrderStore({ journalPath: journal })
    expect(errorCode(() => restored.restore())).toBe('JOURNAL_VERSION_MISMATCH')
  })

  it('writes an identity header and refuses a different world/character/def', () => {
    const journal = tempJournal()
    const identity = { worldId: 'world-a', characterId: 'char-a', defVersion: 'def-a', defScope: 'plans' as const }
    const store = new OrderStore({ journalPath: journal, identity })
    store.enqueue(order('ord-1'))

    const lines = readFileSync(journal, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
    expect(lines[0]).toMatchObject({ kind: 'journal.identity', identity })

    const same = new OrderStore({ journalPath: journal, identity })
    same.restore()
    expect(same.get('ord-1')?.state).toBe('active')

    for (const changed of [
      { ...identity, worldId: 'world-b' },
      { ...identity, characterId: 'char-b' },
      { ...identity, defVersion: 'def-b' },
    ]) {
      const mismatch = new OrderStore({ journalPath: journal, identity: changed })
      expect(errorCode(() => mismatch.restore())).toBe('RECOVERY_IDENTITY_MISMATCH')
    }
  })
})

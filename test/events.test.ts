import { describe, expect, it } from 'vitest'

import { EventQueue } from '../src/core/events.ts'

function event(seq: number, id = `e${seq}`) {
  return { eventId: id, seq, kind: 'test', data: seq }
}

describe('EventQueue', () => {
  it('deduplicates ids and drains in insertion order', () => {
    const queue = new EventQueue()
    expect(queue.push(event(1))).toBe('accepted')
    expect(queue.push(event(1))).toBe('duplicate')
    expect(queue.push(event(2))).toBe('accepted')
    const drained = queue.drain()
    expect(drained.events.map(item => item.seq)).toEqual([1, 2])
    expect(drained.gap).toBe(false)
  })

  it('drops the oldest event at capacity and reports a gap', () => {
    const queue = new EventQueue(1)
    queue.push(event(1))
    queue.push(event(2))
    const drained = queue.drain()
    expect(drained.events.map(item => item.seq)).toEqual([2])
    expect(drained.gap).toBe(true)
    expect(drained.dropped).toBe(1)
    expect(queue.droppedCount).toBe(1)
  })

  it('reports drops per drain and cumulatively', () => {
    const queue = new EventQueue(1)
    queue.push(event(1))
    queue.push(event(2))
    expect(queue.drain()).toMatchObject({ dropped: 1 })
    expect(queue.droppedCount).toBe(1)

    queue.push(event(3))
    expect(queue.drain()).toMatchObject({ dropped: 0, gap: false })
    expect(queue.droppedCount).toBe(1)
  })

  it('rejects an out-of-order sequence as a gap', () => {
    const queue = new EventQueue()
    queue.push(event(2))
    expect(queue.push(event(1))).toBe('gap')
    expect(queue.drain().gap).toBe(true)
  })
})

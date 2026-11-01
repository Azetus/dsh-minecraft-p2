import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatBatcher } from '../src/bridge/chat-batcher.ts'
import type { ChatMessage } from '../src/contracts/protocol.ts'

/**
 * Category: data (M4 chat-to-Agent).
 * Protects: nearby chat is merged into one wake; continuous chat cannot
 * starve the Agent past the max wait.
 */

const message = (seq: number, text: string): ChatMessage => ({
  seq,
  at: 0,
  username: 'Human_Player',
  message: text,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ChatBatcher', () => {
  it('merges messages inside the debounce window', () => {
    vi.useFakeTimers()
    const batches: ChatMessage[][] = []
    const batcher = new ChatBatcher(messages => batches.push(messages), 1000, 3000)
    batcher.add(message(1, 'a'))
    vi.advanceTimersByTime(500)
    batcher.add(message(2, 'b'))
    vi.advanceTimersByTime(999)
    expect(batches).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(batches).toHaveLength(1)
    expect(batches[0]?.map(entry => entry.message)).toEqual(['a', 'b'])
  })

  it('forces a batch after the max wait under continuous chat', () => {
    vi.useFakeTimers()
    const batches: ChatMessage[][] = []
    const batcher = new ChatBatcher(messages => batches.push(messages), 1000, 3000)
    for (let index = 0; index < 6; index += 1) {
      batcher.add(message(index + 1, String(index)))
      vi.advanceTimersByTime(500)
    }
    expect(batches).toHaveLength(1)
    expect(batches[0]?.length).toBeGreaterThan(1)
  })

  it('drops pending messages on stop', () => {
    vi.useFakeTimers()
    const batches: ChatMessage[][] = []
    const batcher = new ChatBatcher(messages => batches.push(messages))
    batcher.add(message(1, 'a'))
    batcher.stop()
    vi.advanceTimersByTime(5000)
    expect(batches).toHaveLength(0)
  })
})

import { describe, expect, it } from 'vitest'

import { annotateCompletion, orderTargetKey, RepeatTracker, repeatHint } from '../src/bridge/repeat.ts'
import type { CompletionItem } from '../src/bridge/completion-wake.ts'

/**
 * Category: state safety (Agent discipline hint).
 * Protects: a repeated failed target is counted per session, a success clears
 * it, and the wake hint never blocks or changes the order state.
 */

describe('repeat failure hints', () => {
  it('keys the same target consistently across equivalent coordinates', () => {
    expect(orderTargetKey('go', { x: 1.2, y: 64, z: 0.8 }))
      .toBe(orderTargetKey('go', { x: 1, y: 64, z: 0 }))
    expect(orderTargetKey('dig', { from: { x: 1, y: 64, z: 0 }, to: { x: 3, y: 64, z: 0 }, height: 2 }))
      .toContain('1,64,0')
    expect(orderTargetKey('attack', { entityId: '12' })).toBe('entity:12')
  })

  it('warns after two failed terminals and resets after a success', () => {
    const tracker = new RepeatTracker()
    tracker.noteAccepted('s1', 'o1', 'go', { x: 1, y: 64, z: 0 })
    expect(tracker.noteTerminal('s1', 'o1', 'failed')?.failures).toBe(1)
    expect(tracker.noteAccepted('s1', 'o2', 'go', { x: 1, y: 64, z: 0 })).toBe(1)
    expect(tracker.noteTerminal('s1', 'o2', 'blocked')?.failures).toBe(2)
    expect(tracker.noteAccepted('s1', 'o3', 'go', { x: 1, y: 64, z: 0 })).toBe(2)

    tracker.noteAccepted('s1', 'o4', 'go', { x: 1, y: 64, z: 0 })
    expect(tracker.noteTerminal('s1', 'o4', 'succeeded')?.failures).toBe(0)
    expect(tracker.noteAccepted('s1', 'o5', 'go', { x: 1, y: 64, z: 0 })).toBe(0)
  })

  it('annotates an order-terminal wake without changing its state', () => {
    const tracker = new RepeatTracker()
    tracker.noteAccepted('s1', 'o1', 'go', { x: 1, y: 64, z: 0 })
    tracker.noteTerminal('s1', 'o1', 'failed')
    tracker.noteAccepted('s1', 'o2', 'go', { x: 1, y: 64, z: 0 })
    const item: CompletionItem = {
      severity: 'critical',
      payload: { kind: 'order.terminal', orderId: 'o2', state: 'failed' },
    }

    annotateCompletion([item], tracker, 's1')
    expect(item.payload.repeatFailures).toBe(2)
    expect(item.payload.repeatHint).toBe(repeatHint('go', 2))
    expect(item.payload.state).toBe('failed')
  })

  it('does not annotate the first failure', () => {
    const tracker = new RepeatTracker()
    tracker.noteAccepted('s1', 'o1', 'go', { x: 1, y: 64, z: 0 })
    const item: CompletionItem = {
      severity: 'critical',
      payload: { kind: 'order.terminal', orderId: 'o1', state: 'failed' },
    }
    annotateCompletion([item], tracker, 's1')
    expect(item.payload.repeatFailures).toBeUndefined()
  })
})

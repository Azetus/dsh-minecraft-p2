import { describe, expect, it } from 'vitest'

import { baseAllowed, buildActivityView, resolveActivityLayer } from '../src/mind/activity.ts'
import type { BaseActivityView } from '../src/contracts/protocol.ts'

/**
 * Category: state safety.
 * Protects: layer priority is constant > order/plan > duty > base; a blocked or
 * failed duty keeps ownership so the default base cannot resume behind it.
 */

const idle: BaseActivityView = {
  kind: 'idle',
  state: 'inactive',
  params: {},
  waitingReason: null,
}

function view(overrides: Partial<BaseActivityView> = {}): BaseActivityView {
  return {
    kind: 'wandering',
    state: 'active',
    params: { radius: 8 },
    waitingReason: null,
    ...overrides,
  }
}

describe('activity layer', () => {
  it('resolves constant, order, duty and base in that order', () => {
    expect(resolveActivityLayer({ threat: true, orderVerb: 'go', planActive: false, dutyState: 'active', base: idle }))
      .toBe('constant')
    expect(resolveActivityLayer({ threat: false, orderVerb: 'go', planActive: false, dutyState: 'active', base: idle }))
      .toBe('order')
    expect(resolveActivityLayer({ threat: false, planActive: true, dutyState: 'active', base: idle }))
      .toBe('order')
    expect(resolveActivityLayer({ threat: false, planActive: false, dutyState: 'active', base: idle }))
      .toBe('duty')
    expect(resolveActivityLayer({ threat: false, planActive: false, base: idle }))
      .toBe('base')
  })

  it('keeps a blocked or failed duty in the duty layer', () => {
    expect(resolveActivityLayer({ threat: false, planActive: false, dutyState: 'blocked', base: idle }))
      .toBe('duty')
    expect(resolveActivityLayer({ threat: false, planActive: false, dutyState: 'failed', base: idle }))
      .toBe('duty')
    expect(baseAllowed('blocked')).toBe(false)
    expect(baseAllowed('failed')).toBe(false)
    expect(baseAllowed('completed')).toBe(true)
    expect(baseAllowed('cancelled')).toBe(true)
    expect(baseAllowed(undefined)).toBe(true)
  })

  it('reports the effective view with waiting states', () => {
    expect(buildActivityView({ threat: true, threatKind: 'fight', planActive: false, base: view() }))
      .toEqual({ layer: 'constant', kind: 'fight', state: 'active', pausedBy: null })
    expect(buildActivityView({ threat: false, orderVerb: 'hold', planActive: false, base: view() }))
      .toEqual({ layer: 'order', kind: 'hold', state: 'waiting', pausedBy: null })
    expect(buildActivityView({ threat: false, planActive: true, base: view() }))
      .toEqual({ layer: 'order', kind: 'plan', state: 'active', pausedBy: null })
    expect(buildActivityView({ threat: false, planActive: false, dutyState: 'blocked', dutyKind: 'gather', base: view() }))
      .toEqual({ layer: 'duty', kind: 'gather', state: 'waiting', pausedBy: null })
    expect(buildActivityView({
      threat: false,
      planActive: false,
      base: view({ kind: 'escort', params: { target: 'Alice', distance: 3 }, waitingReason: 'TARGET_LOST' }),
    })).toEqual({ layer: 'base', kind: 'escort', state: 'waiting', pausedBy: null })
  })
})

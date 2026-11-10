import { describe, expect, it } from 'vitest'

import { classifyFailure } from '../src/mind/diagnostics.ts'
import { MindMetrics } from '../src/mind/metrics.ts'

describe('failure diagnostics', () => {
  it('classifies tool, reachability, safety and budget failures', () => {
    expect(classifyFailure('TOOL_INSUFFICIENT')).toMatchObject({ category: 'tool' })
    expect(classifyFailure('GOTO_NO_PATH')).toMatchObject({ category: 'reachability' })
    expect(classifyFailure('ATTACK_TARGET_PROTECTED')).toMatchObject({ category: 'safety' })
    expect(classifyFailure('BUDGET_EXCEEDED')).toMatchObject({ category: 'budget' })
    expect(classifyFailure('PICKUP_UNREACHABLE')).toMatchObject({ category: 'world' })
    expect(classifyFailure('ERR_ASSERTION')).toMatchObject({ category: 'definition' })
    expect(classifyFailure('SOMETHING_NEW')).toMatchObject({ category: 'unknown' })
  })
})

describe('run metrics', () => {
  it('counts orders, jobs, retries and holds', () => {
    const metrics = new MindMetrics()
    metrics.record('order.accepted', { orderId: 'a' }, 1)
    metrics.record('job.started', { runId: 'r1' }, 2)
    metrics.record('job.terminal', { state: 'failed', code: 'GOTO_NO_PATH', retry: true }, 3)
    metrics.record('mind.hold', { reason: 'GO_NO_STAND', notify: true }, 4)
    metrics.record('order.terminal', { orderId: 'a', state: 'blocked' }, 5)
    metrics.record('order.accepted', { orderId: 'b' }, 6)
    metrics.record('job.started', { runId: 'r2' }, 7)
    metrics.record('job.terminal', { state: 'succeeded', code: 'ATTACK_TARGETS_RESOLVED' }, 8)
    metrics.record('order.terminal', { orderId: 'b', state: 'succeeded' }, 9)

    const view = metrics.view()
    expect(view.orders).toEqual({ accepted: 2, succeeded: 1, failed: 0, blocked: 1, cancelled: 0 })
    expect(view.jobs).toMatchObject({ started: 2, succeeded: 1, failed: 1, retried: 1 })
    expect(view.holds).toBe(1)
    expect(view.holdReasons).toEqual({ GO_NO_STAND: 1 })
    expect(view.failureCodes).toEqual({ GOTO_NO_PATH: 1 })
    expect(view.lastFailure).toMatchObject({ code: 'GOTO_NO_PATH', category: 'reachability' })
    expect(view.completionRate).toBe(0.5)
  })

  it('returns null completion rate before any terminal order', () => {
    const metrics = new MindMetrics()
    metrics.record('order.accepted', { orderId: 'a' }, 1)
    expect(metrics.view().completionRate).toBeNull()
  })
})

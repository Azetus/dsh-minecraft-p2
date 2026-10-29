import { describe, expect, it } from 'vitest'

import { StopControl } from '../src/core/stop-control.ts'

// 类别：状态安全
// 保护对象：RUNTIME §5.1（queued→accepted→stopping→released | stop-unconfirmed）、
//           §6（总期限与迟到确认）；BEHAVIOR §1.1 E2/E4；CONTRACTS §5.1（released 判定）。
// 失败模式：撤权与 accepted 不同步；重复 stop 重置期限；unconfirmed 被后续 stopping 覆盖；
//          旧代际消息取得控制。

describe('StopControl state machine', () => {
  it('accepts revocation synchronously and invalidates the old act instance', () => {
    const control = new StopControl({ stopTimeoutMs: 2000 })
    control.beginAct('act-1')
    expect(control.controlOpen).toBe(true)
    expect(control.classifyControl(0, 'act-1')).toBe('current')

    control.requestStop()
    expect(control.state).toBe('queued')
    expect(control.controlOpen).toBe(true)

    const tokens = control.accept(100)
    expect(tokens).toEqual({ generation: 1, acceptedAt: 100, deadline: 2100 })
    expect(control.state).toBe('accepted')
    expect(control.controlOpen).toBe(false)
    expect(control.classifyControl(0, 'act-1')).toBe('stale-control')
    expect(control.classifyResult(0, 'act-1')).toBe('stale-result')
    expect(control.classifyReleaseAck()).toBe('release-ack')
  })

  it('does not reset generation or deadline on repeated stop requests', () => {
    const control = new StopControl({ stopTimeoutMs: 2000 })
    control.requestStop()
    control.accept(100)
    const generation = control.generation
    control.requestStop()
    expect(control.accept(1500)).toBeUndefined()
    expect(control.generation).toBe(generation)
    expect(control.deadline).toBe(2100)
  })

  it('keeps stop-unconfirmed sticky and accepts a late release', () => {
    const control = new StopControl({ stopTimeoutMs: 2000 })
    control.requestStop()
    control.accept(0)
    expect(control.observe(500, 'stopping')).toBe('stopping')
    expect(control.observe(2000, 'stopping')).toBe('stop-unconfirmed')
    expect(control.observe(2500, 'stopping')).toBe('stop-unconfirmed')
    expect(control.allowsNewRun).toBe(false)
    expect(control.observe(3000, 'released')).toBe('released')
    expect(control.allowsNewRun).toBe(true)
  })

  it('requires a release observation before allowing takeover', () => {
    const control = new StopControl()
    control.requestStop()
    control.accept(0)
    expect(control.allowsNewRun).toBe(false)
    expect(control.observe(0, 'idle')).toBe('stopping')
    expect(control.allowsNewRun).toBe(false)
    expect(control.observe(1, 'released')).toBe('released')
    expect(control.allowsNewRun).toBe(true)
  })

  it('classifies stale generations and act instances as stale', () => {
    const control = new StopControl()
    control.beginAct('act-a')
    expect(control.classifyControl(0, 'act-a')).toBe('current')
    expect(control.classifyControl(1, 'act-a')).toBe('stale-control')
    expect(control.classifyControl(0, 'act-b')).toBe('stale-control')
    expect(control.classifyResult(0, 'act-b')).toBe('stale-result')
    control.beginAct('act-b')
    expect(control.classifyControl(0, 'act-b')).toBe('current')
  })
})

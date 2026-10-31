import { describe, expect, it } from 'vitest'

import {
  ACTION_CAPABILITIES,
  CAPABILITIES,
  PortErrorCodes,
  WriteGate,
  actFailed,
  actOk,
  actUnknown,
  actionCapability,
  checkCapability,
  staleWriteResult,
} from '../src/port/index.ts'
import type { Capability, WriteToken } from '../src/port/index.ts'

/**
 * Category: cross-module contract (CONTRACTS §2/§10, P2MIND §1.1).
 * Protects: single-writer and three-state result semantics at the port
 * boundary. Failure modes: an older run keeps writing after `seq++`, and a
 * missing capability degrades silently instead of failing.
 */

const token = (seq: number, overrides: Partial<WriteToken> = {}): WriteToken => ({
  runId: 'run-1',
  jobId: 'job-1',
  seq,
  ...overrides,
})

function errorCode(run: () => void): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('write token', () => {
  it('has no authority before begin and after end', () => {
    const gate = new WriteGate()
    expect(gate.currentEpoch()).toBeUndefined()
    expect(gate.isCurrent(0)).toBe(false)
    expect(gate.token()).toBeUndefined()

    const epoch = gate.begin(token(1))
    expect(gate.currentEpoch()).toBe(epoch)
    expect(gate.isCurrent(epoch)).toBe(true)

    gate.end(token(1))
    expect(gate.currentEpoch()).toBeUndefined()
    expect(gate.isCurrent(epoch)).toBe(false)
  })

  it('renews the same token without a new authority epoch', () => {
    const gate = new WriteGate()
    const first = gate.begin(token(1))
    const second = gate.begin(token(1))
    expect(second).toBe(first)
    expect(gate.isCurrent(first)).toBe(true)
  })

  it('revokes the old authority when a newer seq is granted', () => {
    const gate = new WriteGate()
    const oldEpoch = gate.begin(token(1, { jobId: 'job-old' }))
    const newEpoch = gate.begin(token(2, { jobId: 'job-new' }))
    expect(newEpoch).not.toBe(oldEpoch)
    expect(gate.isCurrent(oldEpoch)).toBe(false)
    expect(gate.isCurrent(newEpoch)).toBe(true)
    expect(gate.token()).toMatchObject({ jobId: 'job-new', seq: 2 })
  })

  it('rejects an older or equal-seq token as STALE_WRITE and counts it', () => {
    const gate = new WriteGate()
    gate.begin(token(2, { jobId: 'job-new' }))

    expect(errorCode(() => gate.begin(token(1, { jobId: 'job-old' })))).toBe(PortErrorCodes.STALE_WRITE)
    expect(errorCode(() => gate.begin(token(2, { jobId: 'job-old' })))).toBe(PortErrorCodes.STALE_WRITE)
    expect(gate.token()).toMatchObject({ jobId: 'job-new', seq: 2 })
    expect(gate.staleWrites()).toBe(2)
  })

  it('rejects a stale end and keeps the active authority', () => {
    const gate = new WriteGate()
    const epoch = gate.begin(token(2))
    expect(errorCode(() => gate.end(token(1)))).toBe(PortErrorCodes.STALE_WRITE)
    expect(gate.currentEpoch()).toBe(epoch)
    expect(gate.staleWrites()).toBe(1)
    gate.end(token(2))
    expect(gate.currentEpoch()).toBeUndefined()
  })

  it('reports a failed ActResult for a write attempted without a token', () => {
    expect(staleWriteResult(12)).toEqual({
      state: 'failed',
      code: PortErrorCodes.STALE_WRITE,
      elapsedMs: 12,
    })
  })
})

describe('capabilities', () => {
  it('uses behavioural capability names only', () => {
    expect([...CAPABILITIES]).toEqual(['navigate', 'interact', 'observe.screen', 'combat'])
  })

  it('maps actions to the capability they require', () => {
    expect(actionCapability('moveTo')).toBe('navigate')
    expect(actionCapability('dig')).toBe('interact')
    expect(actionCapability('attack')).toBe('combat')
    expect(actionCapability('screen')).toBe('observe.screen')
    expect(actionCapability('lookAt')).toBeNull()
    expect(Object.keys(ACTION_CAPABILITIES)).toHaveLength(10)
  })

  it('fails with CAPABILITY_MISSING instead of degrading', () => {
    const error = checkCapability([], 'moveTo')
    expect(error?.code).toBe(PortErrorCodes.CAPABILITY_MISSING)
    expect(error?.category).toBe('capability')
    expect(error?.details).toMatchObject({ action: 'moveTo', missing: 'navigate' })

    expect(checkCapability(['navigate'] as Capability[], 'moveTo')).toBeUndefined()
    expect(checkCapability([], 'lookAt')).toBeUndefined()
    expect(checkCapability(['interact'] as Capability[], 'attack')?.code).toBe(PortErrorCodes.CAPABILITY_MISSING)
  })
})

describe('three-state ActResult', () => {
  it('keeps ok, failed and unknown distinct', () => {
    expect(actOk(3, { block: 'stone' })).toEqual({ state: 'ok', observed: { block: 'stone' }, elapsedMs: 3 })
    expect(actFailed('CLIENT_TIMEOUT', 1000)).toEqual({ state: 'failed', code: 'CLIENT_TIMEOUT', elapsedMs: 1000 })
    expect(actUnknown('CLIENT_TIMEOUT', 1000)).toEqual({ state: 'unknown', code: 'CLIENT_TIMEOUT', elapsedMs: 1000 })
    expect(actUnknown('CLIENT_TIMEOUT', 1000).state).not.toBe('ok')
  })
})


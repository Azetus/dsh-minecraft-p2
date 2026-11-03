import { describe, expect, it } from 'vitest'

import type { JsonValue } from '../src/contracts/types.ts'
import {
  ensureFailureObserved,
  failureBody,
  failureFacts,
  providerFailureSuggestions,
  readFailure,
  withFailure,
} from '../src/mind/failure.ts'
import { actFailure } from '../src/mind/drivers/handle.ts'

/**
 * Category: cross-module contract (failed-job evidence).
 * Protects: one bounded failure projection, no invented game actions, and
 * provider-layer suggestions limited to reobserve/wait/restart-provider.
 */

describe('failure projection', () => {
  it('copies only whitelisted facts from the same snapshot', () => {
    const facts = failureFacts({
      blockedBy: [{ x: 1, y: 64, z: 2, name: 'dirt' }],
      secret: 'not-a-fact',
      path: Array.from({ length: 20 }, (_, index) => ({ x: index, y: 64, z: 0 })),
    } as unknown as JsonValue)
    expect(facts).toHaveProperty('blockedBy')
    expect(facts).not.toHaveProperty('secret')
    expect((facts.path as unknown[]).length).toBe(8)
  })

  it('caps suggestions at three and removes duplicates', () => {
    const body = failureBody({
      layer: 'motion',
      phase: 'execute',
      code: 'GOTO_STUCK',
      cause: { kind: 'world', code: 'GOTO_STUCK' },
      suggestions: [
        { action: 'dig', params: { x: 1, y: 2, z: 3 }, confidence: 'exact', why: 'a' },
        { action: 'dig', params: { x: 1, y: 2, z: 3 }, confidence: 'exact', why: 'b' },
        { action: 'go', params: { x: 4, y: 5, z: 6 }, confidence: 'candidate', why: 'c' },
        { action: 'go', params: { x: 7, y: 8, z: 9 }, confidence: 'candidate', why: 'd' },
      ],
    })
    expect(body.suggestions).toHaveLength(3)
    expect(body.suggestions?.[0]).toMatchObject({ action: 'dig', confidence: 'exact' })
    expect(body.suggestions?.[1]).toMatchObject({ action: 'go', params: { x: 4, y: 5, z: 6 } })
  })

  it('never suggests a game action for provider failures', () => {
    for (const code of ['ACT_TIMEOUT', 'ACT_UNCONFIRMED', 'STOP_UNCONFIRMED']) {
      const actions = providerFailureSuggestions(code).map(suggestion => suggestion.action)
      expect(actions.every(action => ['reobserve', 'wait', 'restart-provider'].includes(action))).toBe(true)
    }
  })

  it('attaches a port failure to an unconfirmed action result', () => {
    const result = actFailure({
      state: 'unknown',
      code: 'ACT_UNCONFIRMED',
      observed: { layer: 'port', effect: 'unknown', retrySafe: false } as unknown as JsonValue,
    }, 'DIG_FAILED')
    expect(result.state).toBe('failed')
    const failure = readFailure(result.observed)
    expect(failure).toMatchObject({
      layer: 'port',
      phase: 'execute',
      code: 'ACT_UNCONFIRMED',
      cause: { kind: 'provider', code: 'ACT_UNCONFIRMED' },
    })
    expect(failure?.suggestions?.map(suggestion => suggestion.action))
      .toEqual(['reobserve', 'wait'])
  })

  it('adds exactly one generic failure body when a driver did not provide one', () => {
    const observed = withFailure(undefined, failureBody({
      layer: 'driver',
      phase: 'unknown',
      code: 'DRIVER_FAILED',
      cause: { kind: 'unknown', code: 'DRIVER_FAILED' },
    }))
    expect(readFailure(observed)).toMatchObject({ code: 'DRIVER_FAILED' })
    const again = ensureFailureObserved(observed, 'DRIVER_FAILED', 'move')
    expect(readFailure(again)).toMatchObject({ code: 'DRIVER_FAILED' })
  })

  it('creates a generic body for a bare failed job observation', () => {
    const observed = ensureFailureObserved({ pathStatus: 'noPath' } as unknown as JsonValue, 'GOTO_NO_PATH', 'move')
    expect(readFailure(observed)).toMatchObject({
      layer: 'driver',
      code: 'GOTO_NO_PATH',
      facts: { pathStatus: 'noPath', driverId: 'move' },
    })
  })
})

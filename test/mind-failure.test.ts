import { describe, expect, it } from 'vitest'

import type { JsonValue } from '../src/contracts/types.ts'
import {
  ensureFailureObserved,
  failureBody,
  failureFacts,
  failureSnapshot,
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

  it('builds a bounded same-observation snapshot with body and target cells', () => {
    const blocks = new Map([
      ['0,65,0', { name: 'dirt', loaded: true }],
      ['0,63,0', { name: 'stone', loaded: true }],
      ['1,63,0', { name: 'stone', loaded: true }],
      ['1,65,0', { name: 'air', loaded: true }],
    ])
    const port = {
      self: () => ({ pos: { x: 0.5, y: 64, z: 0.5 } }),
      blockAt: (p: { x: number; y: number; z: number }) =>
        blocks.get(`${p.x},${p.y},${p.z}`) ?? { name: 'air', loaded: true },
    }
    const snapshot = failureSnapshot(port, { x: 1, y: 64, z: 0 }, {
      pathStatus: 'noPath',
      bestReachable: { x: 1, y: 64, z: 0 },
      bodyOverlap: { blocks: [{ x: 0, y: 64, z: 0, name: 'dirt' }] },
      path: Array.from({ length: 20 }, (_, index) => ({ x: index, y: 64, z: 0 })),
      candidates: [{ x: 9, y: 64, z: 9 }],
      visitedNodes: 40,
    } as unknown as JsonValue)

    expect(snapshot.cellCount).toBeLessThanOrEqual(16)
    expect(snapshot.self.head).toMatchObject({ cell: [0, 65, 0], name: 'dirt', loaded: true })
    expect(snapshot.self.support).toMatchObject({ cell: [0, 63, 0], name: 'stone', loaded: true })
    expect(snapshot.target.support).toMatchObject({ cell: [1, 63, 0], name: 'stone', loaded: true })
    expect(snapshot.targetNeighbors).toHaveLength(4)
    expect(snapshot.bodyOverlap[0]?.cell).toEqual([0, 64, 0])
    expect(snapshot.pathStatus).toBe('noPath')
    expect(snapshot.bestReachable).toEqual([1, 64, 0])

    const all = [
      snapshot.self.feet, snapshot.self.head, snapshot.self.support,
      snapshot.target.feet, snapshot.target.head, snapshot.target.support,
      ...snapshot.targetNeighbors, ...snapshot.bodyOverlap,
    ]
    expect(new Set(all.map(cell => cell.cell.join(','))).size).toBe(snapshot.cellCount)
    expect(snapshot).not.toHaveProperty('path')
    expect(snapshot).not.toHaveProperty('candidates')
    expect(snapshot).not.toHaveProperty('visitedNodes')
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

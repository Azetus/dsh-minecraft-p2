import { describe, expect, it } from 'vitest'

import type { JsonValue } from '../src/contracts/types.ts'
import {
  diagnoseFailure,
  ensureFailureObserved,
  failureBody,
  failureFacts,
  failureSnapshot,
  readFailure,
  withFailure,
} from '../src/mind/failure.ts'
import { actFailure } from '../src/mind/drivers/handle.ts'

/**
 * Category: cross-module contract (failed-job evidence).
 * Protects: one bounded failure projection, one closed diagnosis, and no
 * action parameters in the failure object.
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

  it('classifies one closed diagnosis and falls back to UNKNOWN', () => {
    const cell = (name: string, loaded = true) => ({ cell: [0, 0, 0], name, loaded })
    const body = (head = 'air', support = 'stone', feet = 'air') => ({
      feet: cell(feet), head: cell(head), support: cell(support),
    })
    const withSnapshot = (snapshot: unknown) => ({ snapshot } as unknown as Record<string, JsonValue>)

    expect(diagnoseFailure({ code: 'STOP_UNCONFIRMED' })).toBe('RELEASE_UNCONFIRMED')
    expect(diagnoseFailure({ code: 'ACT_UNCONFIRMED' })).toBe('EFFECT_UNCONFIRMED')
    expect(diagnoseFailure({ code: 'ACTION_DENIED' })).toBe('DENIED')
    expect(diagnoseFailure({ code: 'TOOL_INSUFFICIENT' })).toBe('TOOL_MISSING')
    expect(diagnoseFailure({ code: 'BODY_OVERLAP' })).toBe('START_EMBEDDED')
    expect(diagnoseFailure({
      code: 'GOTO_NO_PATH',
      facts: withSnapshot({
        self: { ...body(), support: cell('stone', false) },
        target: body(),
        bodyOverlap: [],
      }),
    })).toBe('TARGET_UNLOADED')
    expect(diagnoseFailure({
      code: 'PLACE_UNSUPPORTED',
      facts: withSnapshot({ self: body(), target: body('air', 'air'), bodyOverlap: [] }),
    })).toBe('SUPPORT_MISSING')
    expect(diagnoseFailure({
      code: 'GOTO_NO_PATH',
      facts: withSnapshot({ self: body('stone'), target: body(), bodyOverlap: [] }),
    })).toBe('HEAD_BLOCKED')
    expect(diagnoseFailure({ code: 'GOAL_NOT_STANDABLE' })).toBe('NO_STAND_CELL')
    expect(diagnoseFailure({ code: 'GOTO_NO_PATH' })).toBe('UNKNOWN')
  })

  it('applies the placement diagnosis order', () => {
    const supports = (value: boolean) => ({
      supports: { up: value, down: value, north: value, south: value, east: value, west: value },
    } as Record<string, JsonValue>)

    expect(diagnoseFailure({ code: 'PLACE_FAILED', facts: supports(false) })).toBe('SUPPORT_MISSING')
    expect(diagnoseFailure({
      code: 'PLACE_FAILED',
      facts: { ...supports(false), blockedBy: 'self' },
    })).toBe('START_EMBEDDED')
    expect(diagnoseFailure({
      code: 'PLACE_FAILED',
      facts: { ...supports(true), providerCode: 'ACTION_DENIED' },
    })).toBe('DENIED')
    expect(diagnoseFailure({ code: 'PLACE_FAILED', facts: supports(true) })).toBe('UNKNOWN')
    expect(diagnoseFailure({ code: 'PLACE_BLOCKED_BY_SELF' })).toBe('START_EMBEDDED')
    expect(diagnoseFailure({ code: 'PLACE_UNSUPPORTED' })).toBe('SUPPORT_MISSING')
    expect(diagnoseFailure({
      code: 'PLACE_FAILED',
      facts: {
        ...supports(true),
        snapshot: { bodyOverlap: [{ cell: [0, 64, 0], name: 'dirt', loaded: true }] },
      } as unknown as Record<string, JsonValue>,
    })).toBe('START_EMBEDDED')
  })

  it('adds diagnosis and recovery without action parameters', () => {
    const body = failureBody({
      layer: 'motion',
      phase: 'execute',
      code: 'GOTO_NO_PATH',
      facts: {
        snapshot: {
          self: {
            feet: { cell: [0, 64, 0], name: 'air', loaded: true },
            head: { cell: [0, 65, 0], name: 'stone', loaded: true },
            support: { cell: [0, 63, 0], name: 'stone', loaded: true },
          },
          target: {
            feet: { cell: [1, 64, 0], name: 'air', loaded: true },
            head: { cell: [1, 65, 0], name: 'air', loaded: true },
            support: { cell: [1, 63, 0], name: 'stone', loaded: true },
          },
          targetNeighbors: [],
          bodyOverlap: [],
          pathStatus: 'noPath',
          bestReachable: null,
        } as unknown as JsonValue,
      },
      cause: { kind: 'world', code: 'GOTO_NO_PATH' },
    })
    expect(body).toMatchObject({ diagnosis: 'HEAD_BLOCKED', recovery: 'replan' })
    expect(body).not.toHaveProperty('suggestions')
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('"suggestions"')
    expect(serialized).not.toContain('"action"')
    expect(serialized).not.toContain('"params"')
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
      diagnosis: 'EFFECT_UNCONFIRMED',
      recovery: 'reobserve',
      cause: { kind: 'provider', code: 'ACT_UNCONFIRMED' },
    })
    expect(failure).not.toHaveProperty('suggestions')
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

  it('keeps budget exhaustion evidence on the budget layer', () => {
    const observed = ensureFailureObserved({
      budget: { maxTicks: 100, maxWallMs: 1_000 },
      elapsedMs: 2_000,
      elapsedGameAge: 240,
    } as unknown as JsonValue, 'BUDGET_EXCEEDED', 'move')
    const failure = readFailure(observed)
    expect(failure).toMatchObject({
      layer: 'budget',
      phase: 'execute',
      code: 'BUDGET_EXCEEDED',
      diagnosis: 'UNKNOWN',
      cause: { kind: 'budget', code: 'BUDGET_EXCEEDED' },
      recovery: 'reobserve',
      facts: {
        budget: { maxTicks: 100, maxWallMs: 1_000 },
        elapsedMs: 2_000,
        elapsedGameAge: 240,
        driverId: 'move',
      },
    })
    const serialized = JSON.stringify(failure)
    expect(serialized).not.toContain('"action"')
    expect(serialized).not.toContain('"params"')
  })

  it('classifies an assertion as a definition error that must not be retried', () => {
    const observed = ensureFailureObserved(undefined, 'ERR_ASSERTION', 'place')
    expect(readFailure(observed)).toMatchObject({
      layer: 'driver',
      phase: 'unknown',
      code: 'ERR_ASSERTION',
      diagnosis: 'UNKNOWN',
      cause: { kind: 'definition', code: 'ERR_ASSERTION' },
      recovery: 'none',
      facts: { driverId: 'place' },
    })
  })
})

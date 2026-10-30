/**
 * M2 acceptance: replacing a strategy at runtime (boundary / interrupt).
 *
 * Category: state safety + contract. Protects §5 ("installed ≠ taken over"),
 * C2 (re-verify across versions) and generation/attempt isolation: the old
 * version must not keep issuing actions, and the commitment's goal/progress
 * must survive the replacement.
 */

import { describe, expect, it } from 'vitest'

import { createHarness } from './controller-harness.ts'
import type { Harness } from './controller-harness.ts'
import { createHarvestStrategy } from '../src/controller/strategies/harvest.ts'
import type { Strategy, StrategyContext, StrategyVerdict } from '../src/controller/strategy.ts'
import type { JsonValue } from '../src/contracts/types.ts'

type Counter = { calls: number }

function versionedHarvest(
  version: string,
  digAct: string,
  counter: Counter,
  extra: Partial<Strategy> & { migrate?: (state: JsonValue, fromVersion: string) => JsonValue | undefined } = {},
): Strategy {
  const base = createHarvestStrategy({ key: 'harvest', version, item: 'stone', target: 'stone', count: 2, digAct })
  return {
    ...base,
    ...extra,
    evaluate(context: StrategyContext): StrategyVerdict {
      counter.calls += 1
      return base.evaluate(context)
    },
  }
}

function setup(actionDelayTicks = 2): Harness {
  const harness = createHarness({
    actionDelayTicks,
    world: {
      inventory: [],
      blocks: [
        { name: 'stone', x: 10, y: 64, z: 0 },
        { name: 'stone', x: 11, y: 64, z: 0 },
        { name: 'stone', x: 12, y: 64, z: 0 },
      ],
    },
  })
  return harness
}

function startHarvesting(harness: Harness, strategy: Strategy): void {
  harness.controller.install(strategy)
  harness.tick()
  harness.controller.commit({
    id: 'mine-stone',
    kind: 'task',
    goal: 'mine 2 stone',
    strategyKey: 'harvest',
    post: { kind: 'count-at-least', factKey: 'inventory', item: 'stone', count: 2, fromBaseline: true },
    baselineKeys: ['inventory'],
  })
}

function strategyRow(harness: Harness): ReturnType<Harness['controller']['status']>['strategies'][number] | undefined {
  return harness.controller.status().strategies.find(row => row.key === 'harvest')
}

describe('P2Controller M2', () => {
  it('shows installed ≠ taken over and waits for the action boundary', () => {
    const harness = setup()
    const v1 = { calls: 0 }
    const v2 = { calls: 0 }
    startHarvesting(harness, versionedHarvest('1', 'dig', v1))
    harness.run(2) // goto is running under version 1
    expect(harness.controller.status().action?.intent).toMatch(/^goto:/u)
    const oldAttempt = strategyRow(harness)?.attemptId
    const actionsBefore = harness.actuator.actions.length

    expect(harness.controller.install(versionedHarvest('2', 'dig-v2', v2), 'boundary')).toMatchObject({
      status: 'pending-boundary',
    })
    const pending = strategyRow(harness)
    expect(pending).toMatchObject({ installedVersion: '2', activeVersion: '1', state: 'pending-takeover' })
    expect(v2.calls).toBe(0)

    // The old version keeps running its in-flight action at a boundary swap.
    harness.tick()
    expect(harness.controller.status().action?.act).toBe('goto')
    expect(v2.calls).toBe(0)

    // Once the action ends, the pending version takes over and re-verifies.
    for (let index = 0; index < 10 && strategyRow(harness)?.activeVersion !== '2'; index += 1) harness.tick()
    const takenOver = strategyRow(harness)
    expect(takenOver).toMatchObject({ installedVersion: '2', activeVersion: '2', state: 'active' })
    expect(takenOver?.attemptId).not.toBe(oldAttempt)
    expect(harness.controller.eventLog.some(event => event.kind === 'strategy-taken-over')).toBe(true)
    expect(harness.controller.status().verification?.reason).toBe('strategy-replaced')
    expect(harness.controller.status().action).toBeNull()
    expect(harness.actuator.actions.length).toBeGreaterThanOrEqual(actionsBefore)

    const v1CallsAtTakeover = v1.calls
    for (let index = 0; index < 6; index += 1) harness.tick()
    expect(v1.calls).toBe(v1CallsAtTakeover) // the old version no longer acts
    expect(v2.calls).toBeGreaterThan(1)
    expect(harness.actuator.actions.some(action => action.request.act === 'dig-v2')).toBe(true)
    // Goal and progress survived the replacement: the checkpoint still names a
    // concrete task target rather than restarting from an empty program state.
    expect((harness.controller.commitments.get('mine-stone')?.checkpoint as Record<string, JsonValue>).target).toBeDefined()
  })

  it('interrupts the running action, then hands over only after release', () => {
    const harness = setup(3)
    const v1 = { calls: 0 }
    const v2 = { calls: 0 }
    startHarvesting(harness, versionedHarvest('1', 'dig', v1))
    harness.run(2)
    expect(harness.controller.status().action?.intent).toMatch(/^goto:/u)
    const oldAttempt = strategyRow(harness)?.attemptId

    expect(harness.controller.install(versionedHarvest('2', 'dig-v2', v2), 'interrupt')).toMatchObject({
      status: 'pending-interrupt',
    })
    harness.tick() // revoke + stop; no new action yet
    expect(harness.actuator.stopRequests.length).toBeGreaterThan(0)
    expect(harness.actuator.last.outcome.status).toBe('cancelled')
    expect(harness.actuator.actions.some(action => action.request.act === 'dig-v2')).toBe(false)
    expect(harness.controller.status().action).toBeNull()

    for (let index = 0; index < 10 && strategyRow(harness)?.activeVersion !== '2'; index += 1) harness.tick()
    expect(strategyRow(harness)).toMatchObject({ activeVersion: '2', state: 'active' })
    expect(strategyRow(harness)?.attemptId).not.toBe(oldAttempt)
    expect(harness.controller.status().verification?.reason).toBe('strategy-replaced')
    expect(harness.controller.eventLog.some(event => event.kind === 'action-preempted')).toBe(true)
  })

  it('migrates state only when a version explicitly declares compatibility', () => {
    const harness = setup(2)
    const v1 = { calls: 0 }
    const v2 = { calls: 0 }
    startHarvesting(harness, versionedHarvest('1', 'dig', v1))
    harness.run(2)

    const eventsBefore = harness.controller.eventLog.length
    harness.controller.install(
      versionedHarvest('2', 'dig-v2', v2, {
        compatibleWith: ['1'],
        migrate: state => ({
          ...(state as Record<string, JsonValue>),
          migratedFrom: '1',
          target: { x: 12, y: 64, z: 0 },
          arrived: false,
        }),
      }),
      'boundary',
    )
    for (let index = 0; index < 10 && strategyRow(harness)?.activeVersion !== '2'; index += 1) harness.tick()
    harness.tick()

    const checkpoint = harness.controller.commitments.get('mine-stone')?.checkpoint as Record<string, JsonValue>
    expect(checkpoint.target).toMatchObject({ x: 12, y: 64, z: 0 })
    const newEvents = harness.controller.eventLog.slice(eventsBefore)
    expect(newEvents.some(event => event.kind === 'commitment-verifying')).toBe(false)
    expect(harness.controller.status().verification).toBeNull()
  })

  it('does not expose the previous attempt action outcome after takeover', () => {
    const harness = setup(2)
    const v1 = { calls: 0 }
    startHarvesting(harness, versionedHarvest('1', 'dig', v1))
    harness.run(8) // one dig completed; the two-item goal is not met yet
    const previous = harness.controller.eventLog.filter(event => event.kind === 'action-completed')
    expect(previous.length).toBeGreaterThan(0)

    const seen: Array<unknown> = []
    const watcher: Strategy = {
      key: 'harvest',
      version: '2',
      slot: 'S2',
      evaluate: context => {
        seen.push(context.lastOutcome)
        return { kind: 'idle' }
      },
    }
    harness.controller.install(watcher, 'boundary')
    for (let index = 0; index < 10 && strategyRow(harness)?.activeVersion !== '2'; index += 1) harness.tick()
    harness.tick()

    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toBeUndefined()
  })
})

/**
 * M1 acceptance: four slots, observation validity, commitment repository,
 * bounded memory, one harvest task strategy and one water-escape strategy.
 *
 * Category: state safety + contract. Protects §3.1 (slots/observations/
 * commitments), C2 (suspend + re-verify), C3 (unknown ≠ false) and C4
 * (candidate → cleanup → evidence → success).
 */

import { describe, expect, it } from 'vitest'

import { createHarness } from './controller-harness.ts'
import { createHarvestStrategy } from '../src/controller/strategies/harvest.ts'
import { createWaterEscapeStrategy } from '../src/controller/strategies/water-escape.ts'
import type { PostCondition } from '../src/controller/commitment.ts'
import type { Strategy } from '../src/controller/strategy.ts'

function stonePost(count: number): PostCondition {
  return { kind: 'count-at-least', factKey: 'inventory', item: 'stone', count, fromBaseline: true }
}

function harvestCommitment(harness: ReturnType<typeof createHarness>, count = 2): void {
  harness.controller.install(createHarvestStrategy({ item: 'stone', target: 'stone', count }))
  harness.tick()
  harness.controller.commit({
    id: 'mine-stone',
    kind: 'task',
    goal: `mine ${count} stone`,
    strategyKey: 'harvest',
    post: stonePost(count),
    baselineKeys: ['inventory'],
  })
}

describe('P2Controller M1', () => {
  it('harvests, and does not count items that were already owned', () => {
    const harness = createHarness({
      world: {
        inventory: [{ name: 'stone', count: 2 }],
        blocks: [
          { name: 'stone', x: 10, y: 64, z: 0 },
          { name: 'stone', x: 11, y: 64, z: 0 },
          { name: 'stone', x: 12, y: 64, z: 0 },
        ],
      },
    })
    harvestCommitment(harness)

    expect(harness.controller.status().commitment?.state).toBe('active')
    // First action must be a goto, because the target is out of reach.
    harness.run(1)
    expect(harness.actuator.actions[0]?.request.intent).toMatch(/^goto:/u)

    harness.run(12)
    const commitment = harness.controller.commitments.get('mine-stone')
    expect(commitment?.state).toBe('succeeded')
    expect(commitment?.evidence).toHaveLength(1)
    expect(commitment?.evidence[0]).toMatchObject({ factKey: 'inventory', baseline: 2, observed: 4, required: 4 })
    // Two blocks were mined and nothing else changed.
    expect(harness.world.blocks).toHaveLength(1)
    expect(harness.world.inventory).toEqual([{ name: 'stone', count: 4 }])
  })

  it('suspends a commitment when an S0 hazard preempts, then re-verifies before continuing', () => {
    const harness = createHarness({
      actionDelayTicks: 3,
      world: {
        inventory: [],
        blocks: [
          { name: 'stone', x: 10, y: 64, z: 0 },
          { name: 'stone', x: 11, y: 64, z: 0 },
        ],
      },
    })
    harvestCommitment(harness)
    harness.controller.install(createWaterEscapeStrategy({ act: 'escape-water' }))
    harness.run(2) // goto is still in flight
    expect(harness.controller.status().commitment?.state).toBe('active')
    expect(harness.controller.status().action).not.toBeNull()

    harness.world.position = { ...harness.world.position, inWater: true }
    harness.world.oxygen = 40
    harness.tick()
    const suspended = harness.controller.status()
    expect(suspended.commitment?.state).toBe('suspended')
    expect(harness.actuator.stopRequests.length).toBeGreaterThan(0)
    expect(harness.controller.memory.escapePhase).toBe('escaping')

    // Wait for the emergency action to own the lease, finish, and hand back.
    for (let index = 0; index < 10 && harness.controller.status().action?.intent !== 'escape-water'; index += 1) harness.tick()
    expect(harness.controller.status().action).toMatchObject({ intent: 'escape-water', slot: 'S0' })

    for (let index = 0; index < 10 && harness.controller.status().commitment?.state !== 'verifying'; index += 1) harness.tick()
    const verifying = harness.controller.status()
    expect(verifying.action).toBeNull()
    expect(verifying.commitment?.state).toBe('verifying')
    expect(verifying.verification?.reason).toBe('hazard-cleared')
    expect(verifying.verification?.since).toBe(harness.clock.now + 1)

    for (let index = 0; index < 10 && harness.controller.status().commitment?.state !== 'active'; index += 1) harness.tick()
    const resumed = harness.controller.status()
    expect(resumed.commitment?.state).toBe('active')
    expect(resumed.verification).toBeNull()
    expect(resumed.action).not.toBeNull()
    expect(harness.controller.memory.escapePhase).toBe('none')
    // The task did not restart from the beginning: its checkpoint survived.
    expect(harness.controller.commitments.get('mine-stone')?.checkpoint).not.toBeNull()
  })

  it('reports blocked with the missing observation and how long it waited', () => {
    const harness = createHarness({
      world: {
        failing: new Set(['blocks']),
        blocks: [{ name: 'stone', x: 2, y: 64, z: 0 }],
      },
    })
    harvestCommitment(harness)
    harness.run(10)

    const commitment = harness.controller.commitments.get('mine-stone')
    expect(commitment?.state).toBe('blocked')
    expect(commitment?.blocked).toMatchObject({ reason: 'MISSING_OBSERVATION' })
    expect(commitment?.blocked?.missing).toContain('nearbyBlocks')
    expect(commitment?.blocked?.diagnostics.length).toBeGreaterThan(0)
    expect(harness.actuator.actions).toHaveLength(0)
  })

  it('never completes from an unknown baseline (fail closed)', () => {
    const harness = createHarness({
      world: {
        failing: new Set(['inventory']),
        blocks: [{ name: 'stone', x: 2, y: 64, z: 0 }],
      },
    })
    harvestCommitment(harness, 1)
    expect(harness.controller.commitments.get('mine-stone')?.baseline.missing).toContain('inventory')

    harness.world.failing.delete('inventory')
    harness.run(14)

    const commitment = harness.controller.commitments.get('mine-stone')
    expect(commitment?.state).toBe('blocked')
    expect(commitment?.blocked?.reason).toBe('EVIDENCE_TIMEOUT')
    expect(commitment?.blocked?.missing).toContain('inventory@baseline')
    expect(commitment?.evidence).toHaveLength(0)
  })

  it('does not submit success while control release is unknown', () => {
    const harness = createHarness({
      world: {
        inventory: [],
        blocks: [{ name: 'stone', x: 2, y: 64, z: 0 }],
      },
    })
    harvestCommitment(harness, 1)
    harness.run(1)
    expect(harness.actuator.last.request.intent).toMatch(/^dig:/u)

    // Evidence becomes unavailable, then an injected start failure makes the
    // control state unknown. The commitment must not turn that into success.
    harness.world.failing.add('inventory')
    harness.actuator.releaseReport = { status: 'stopping' }
    harness.tick() // dig completes, evidence is still unknown
    harness.actuator.startThrows = new Error('injected start failure')
    harness.controller.machine.request({
      act: 'noop',
      args: {},
      intent: 'inject-fault',
      slot: 'S3',
      holder: 'S3:test',
    }, harness.clock.now)
    harness.tick()

    const faulted = harness.controller.status()
    expect(faulted.lease.fault?.code).toBe('CONTROL_OUTCOME_UNKNOWN')
    expect(faulted.commitment?.state).toBe('suspended')
    expect(harness.controller.commitments.get('mine-stone')?.evidence).toHaveLength(0)

    // A late release clears the fault but does not turn the commitment into a
    // success; it goes back through verification.
    harness.actuator.releaseReport = { status: 'released' }
    harness.actuator.startThrows = undefined
    harness.tick()
    expect(harness.controller.status().lease.fault).toBeUndefined()
    expect(harness.controller.commitments.get('mine-stone')?.state).not.toBe('succeeded')
  })

  it('rejects a candidate that the post-condition does not support', () => {
    const liar: Strategy = {
      key: 'liar',
      version: '1',
      slot: 'S2',
      evaluate: () => ({ kind: 'candidate-complete', evidence: [] }),
    }
    const harness = createHarness({ world: { inventory: [] } })
    harness.controller.install(liar)
    harness.tick()
    harness.controller.commit({
      kind: 'task',
      goal: 'impossible',
      strategyKey: 'liar',
      post: { kind: 'count-at-least', factKey: 'inventory', item: 'stone', count: 1 },
      baselineKeys: ['inventory'],
    })
    harness.run(8)

    const commitment = harness.controller.commitments.get('commitment-1') ?? harness.controller.commitments.all()[0]
    expect(commitment?.state).toBe('failed')
    expect(commitment?.error?.code).toBe('POSTCONDITION_FAILED')
    expect(harness.controller.eventLog.some(event => event.kind === 'candidate-rejected')).toBe(true)
  })

  it('does not carry a previous commitment action outcome into a new commitment', () => {
    const harness = createHarness({
      world: {
        inventory: [],
        blocks: [{ name: 'stone', x: 2, y: 64, z: 0 }],
      },
    })
    harvestCommitment(harness, 1)
    harness.run(8)
    expect(harness.controller.commitments.get('mine-stone')?.state).toBe('succeeded')

    const seen: Array<unknown> = []
    const watcher: Strategy = {
      key: 'watcher',
      version: '1',
      slot: 'S2',
      evaluate: context => {
        seen.push(context.lastOutcome)
        return { kind: 'idle' }
      },
    }
    harness.controller.install(watcher)
    harness.controller.commit({
      kind: 'standing',
      goal: 'watch',
      strategyKey: 'watcher',
      post: { kind: 'standing' },
      baselineKeys: [],
    })
    harness.tick()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toBeUndefined()
  })

  it('bounds an S0 that repeats the same action without clearing the hazard', () => {
    const harness = createHarness()
    const stubborn: Strategy = {
      key: 'stubborn',
      version: '1',
      slot: 'S0',
      hazardClass: 'lethal',
      evaluate: context => context.propose('escape', 'noop', {}),
    }
    harness.controller.install(stubborn)
    harness.controller.commit({
      id: 'retry-goal',
      kind: 'standing',
      goal: 'stubborn emergency',
      strategyKey: 'stubborn',
      post: { kind: 'standing' },
      baselineKeys: [],
    })
    harness.run(10)

    expect(harness.actuator.actions.filter(action => action.request.intent === 'escape')).toHaveLength(3)
    const commitment = harness.controller.commitments.get('retry-goal')
    expect(commitment?.state).toBe('blocked')
    expect(commitment?.blocked?.reason).toBe('EMERGENCY_BLOCKED')
    expect(commitment?.blocked?.diagnostics.some(item => item.code === 'S0_RETRY_EXHAUSTED')).toBe(true)
  })
})









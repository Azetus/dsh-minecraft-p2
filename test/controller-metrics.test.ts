import { describe, expect, it } from 'vitest'

import { createHarness } from './controller-harness.ts'
import type { Strategy } from '../src/controller/strategy.ts'

describe('controller metrics and hazard safety', () => {
  it('records per-tick decisions and metrics', () => {
    const harness = createHarness()
    harness.tick()
    const status = harness.controller.status()
    expect(status.metrics.ticks).toBeGreaterThan(0)
    expect(status.decisions.length).toBeGreaterThan(0)
    expect(status.decisions[0]?.reason).toBeTruthy()
    expect(status.metrics.actionsStarted).toBeGreaterThanOrEqual(0)
  })

  it('records death as a 60-minute hazard and vetoes task targets inside it', () => {
    const harness = createHarness({
      world: { blocks: [{ name: 'stone', x: 2, y: 64, z: 0 }] },
    })
    harness.controller.recordDeath({ x: 2, y: 64, z: 0 })
    const death = harness.controller.memory.hazards().find(hazard => hazard.kind === 'death')
    expect(death).toBeDefined()
    expect((death?.expiresAt ?? 0) - (death?.at ?? 0)).toBeGreaterThanOrEqual(60 * 60_000 - 1)

    const blind: Strategy = {
      key: 'blind',
      version: '1',
      slot: 'S2',
      evaluate: context => context.propose('dig:2,64,0', 'dig', { pos: { x: 2, y: 64, z: 0 } }),
    }
    harness.controller.install(blind)
    harness.controller.commit({
      id: 'hazard-target',
      kind: 'task',
      goal: 'dig into a death hazard',
      strategyKey: 'blind',
      post: { kind: 'count-at-least', factKey: 'inventory', item: 'stone', count: 1 },
      baselineKeys: ['inventory'],
    })
    harness.run(30)

    const commitment = harness.controller.commitments.get('hazard-target')
    expect(commitment?.state).toBe('blocked')
    expect(commitment?.blocked?.diagnostics.some(item => item.code === 'HAZARD_TARGET')).toBe(true)
    expect(harness.controller.status().metrics.deaths).toBe(1)
  })

  it('evaluates shadow strategies without dispatching them', () => {
    const harness = createHarness({
      world: { blocks: [{ name: 'stone', x: 2, y: 64, z: 0 }] },
    })
    const shadow: Strategy = {
      key: 'shadow-dig',
      version: '1',
      slot: 'S2',
      evaluate: context => context.propose('dig:2,64,0', 'dig', { pos: { x: 2, y: 64, z: 0 } }),
    }
    harness.controller.install(shadow, 'boundary', undefined, true)
    harness.controller.commit({
      id: 'shadow-commit',
      kind: 'task',
      goal: 'shadow must not act',
      strategyKey: 'shadow-dig',
      post: { kind: 'count-at-least', factKey: 'inventory', item: 'stone', count: 1 },
      baselineKeys: ['inventory'],
    })
    harness.run(10)
    expect(harness.controller.status().metrics.actionsStarted).toBe(0)
    const summary = harness.controller.status().strategies.find(row => row.key === 'shadow-dig')
    expect(summary?.shadow).toBe(true)
  })
})

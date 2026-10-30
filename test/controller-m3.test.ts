/**
 * M3 acceptance: a second task strategy and a second hazard strategy are
 * content-only additions, and the controller core stays unchanged.
 *
 * Category: reuse/contract. Protects §5 ("strategies are replaceable content")
 * and the M3 exit condition: new behaviour is a strategy, not a core edit.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { createHarness } from './controller-harness.ts'
import { createCreeperEscapeStrategy } from '../src/controller/strategies/creeper-escape.ts'
import { createFollowOwnerStrategy } from '../src/controller/strategies/follow-owner.ts'
import { createHarvestStrategy } from '../src/controller/strategies/harvest.ts'

function harvestHarness(): ReturnType<typeof createHarness> {
  return createHarness({
    actionDelayTicks: 3,
    world: {
      inventory: [],
      blocks: [
        { name: 'stone', x: 10, y: 64, z: 0 },
        { name: 'stone', x: 11, y: 64, z: 0 },
      ],
    },
  })
}

function commitStones(harness: ReturnType<typeof createHarness>, item = 'stone'): void {
  harness.controller.install(createHarvestStrategy({ item, target: item, count: 2 }))
  harness.tick()
  harness.controller.commit({
    id: `mine-${item}`,
    kind: 'task',
    goal: `mine 2 ${item}`,
    strategyKey: 'harvest',
    post: { kind: 'count-at-least', factKey: 'inventory', item, count: 2, fromBaseline: true },
    baselineKeys: ['inventory'],
  })
}

describe('P2Controller M3', () => {
  it('adds a second hazard as pure strategy content', () => {
    const harness = harvestHarness()
    commitStones(harness)
    harness.run(2)
    expect(harness.controller.status().action).not.toBeNull()

    harness.world.entities = [{ id: 7, name: 'creeper', kind: 'hostile', position: { x: 3, y: 64, z: 0 } }]
    harness.controller.install(createCreeperEscapeStrategy({ act: 'retreat-creeper' }))
    harness.tick()

    const suspended = harness.controller.status()
    expect(suspended.commitment?.state).toBe('suspended')
    expect(harness.controller.memory.hazards().some(hazard => hazard.kind === 'creeper')).toBe(true)
    expect(suspended.decision?.reason).toBe('emergency')

    for (let index = 0; index < 10 && harness.controller.status().action?.intent !== 'retreat-creeper'; index += 1) harness.tick()
    expect(harness.controller.status().action).toMatchObject({ intent: 'retreat-creeper', slot: 'S0' })

    for (let index = 0; index < 10 && harness.controller.status().commitment?.state !== 'verifying'; index += 1) harness.tick()
    expect(harness.controller.status().commitment?.state).toBe('verifying')

    for (let index = 0; index < 10 && harness.controller.status().commitment?.state !== 'active'; index += 1) harness.tick()
    expect(harness.controller.status().commitment?.state).toBe('active')
    expect(harness.controller.memory.escapePhase).toBe('none')
  })

  it('adds a second task strategy with a different commitment kind (standing)', () => {
    const harness = createHarness({
      actionDelayTicks: 1,
      world: {
        entities: [{ name: 'P2_Human', kind: 'player', position: { x: 20, y: 64, z: 0 } }],
      },
    })
    harness.controller.install(createFollowOwnerStrategy({ owner: 'P2_Human' }))
    harness.tick()
    harness.controller.commit({
      id: 'follow',
      kind: 'standing',
      goal: 'follow P2_Human',
      strategyKey: 'follow-owner',
      post: { kind: 'standing' },
      baselineKeys: ['position'],
    })

    harness.run(3)
    expect(harness.actuator.actions[0]?.request.intent).toBe('follow:P2_Human')
    harness.run(6)
    // Near the owner the standing strategy reports "hold": no action, no success.
    expect(harness.controller.status().action).toBeNull()
    expect(harness.actuator.actions).toHaveLength(1)
    expect(harness.controller.commitments.get('follow')?.state).toBe('active')
    harness.controller.cancelCommitment('follow', 'owner asked to stop')
    expect(harness.controller.commitments.get('follow')?.state).toBe('cancelled')
  })

  it('reuses the same core for a differently configured second task', () => {
    const harness = createHarness({
      world: {
        inventory: [],
        blocks: [
          { name: 'oak_log', x: 1, y: 64, z: 0 },
          { name: 'oak_log', x: 2, y: 64, z: 0 },
        ],
      },
    })
    commitStones(harness, 'oak_log')
    harness.run(8)
    expect(harness.controller.commitments.get('mine-oak_log')?.state).toBe('succeeded')
    expect(harness.world.inventory).toEqual([{ name: 'oak_log', count: 2 }])
  })

  it('keeps strategy content out of the controller core (static boundary)', () => {
    const strategyFiles = ['harvest', 'water-escape', 'creeper-escape', 'follow-owner', 'reading', 'index']
    for (const name of strategyFiles) {
      const source = readFileSync(new URL(`../src/controller/strategies/${name}.ts`, import.meta.url), 'utf8')
      expect(source, `${name} must not import the controller core`).not.toMatch(/from '\.\.\/controller\.ts'/u)
      expect(source, `${name} must not import the lease`).not.toMatch(/from '\.\.\/lease\.ts'/u)
    }
    const core = readFileSync(new URL('../src/controller/controller.ts', import.meta.url), 'utf8')
    expect(core).not.toMatch(/strategies\//u)
    expect(core).not.toMatch(/creeper|water-escape|follow-owner|harvest/u)
  })
})



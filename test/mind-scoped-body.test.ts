import { describe, expect, it } from 'vitest'

import type { BodyApi, WriteToken } from '../src/body/api.ts'
import { createScope, revokeScope } from '../src/mind/scope.ts'
import { scopeWrites } from '../src/mind/scoped-body.ts'

/**
 * Category: state safety (CONTRACTS §1 invariant 1, RUNTIME §4).
 * Protects: one writer. Failure modes: a preempted driver keeps writing, a
 * revoked driver borrows the next run's authority, reads break on revocation,
 * or an optional method is silently added/removed so a caller takes a fallback
 * path that does not exist.
 */

const TOKEN: WriteToken = { runId: 'run-1', jobId: 'job-1', seq: 1 }

type Calls = string[]

function fakeBody(options: { full?: boolean } = {}): { body: BodyApi; calls: Calls } {
  const calls: Calls = []
  const act = async (name: string) => {
    calls.push(name)
    return { state: 'ok' as const, elapsedMs: 1 }
  }
  const base: Record<string, unknown> = {
    self: () => {
      calls.push('self')
      return {
        pos: { x: 0, y: 64, z: 0 },
        yaw: 0,
        pitch: 0,
        health: 20,
        food: 20,
        onGround: true,
        inWater: false,
        inLava: false,
      }
    },
    identity: () => ({ worldId: 'w', characterId: 'c' }),
    blockAt: () => {
      calls.push('blockAt')
      return null
    },
    biomeAt: () => null,
    blocksIn: () => [],
    findBlocks: () => [],
    inventory: () => {
      calls.push('inventory')
      return []
    },
    entities: () => [],
    time: () => ({ timeOfDay: 0, worldAge: 0 }),
    beginWrite: () => { calls.push('beginWrite') },
    endWrite: () => { calls.push('endWrite') },
    moveTo: () => act('moveTo'),
    lookAt: () => act('lookAt'),
    dig: () => act('dig'),
    place: () => act('place'),
    useItem: () => act('useItem'),
    equip: () => act('equip'),
    craft: () => act('craft'),
    useOn: () => act('useOn'),
    attack: () => act('attack'),
    sleep: () => act('sleep'),
    fatalStep: () => act('fatalStep'),
    containerTransfer: () => act('containerTransfer'),
    containerAt: async () => {
      calls.push('containerAt')
      return { state: 'ok' as const, block: 'chest', items: [] }
    },
    say: () => { calls.push('say') },
    on: () => { calls.push('on') },
  }
  if (options.full !== false) {
    base.suspension = () => ({ suspended: false, at: 0, idleMs: 0, serverAge: null })
    base.offhand = () => undefined
    base.entityByName = () => undefined
    base.entityById = () => undefined
    base.playerOnline = () => false
    base.canSee = () => true
    base.attackSpeed = () => 4
    base.attackReach = () => 3
    base.combatInput = () => act('combatInput')
    base.lookYaw = () => act('lookYaw')
    base.offhandHold = () => act('offhandHold')
    base.unequip = () => act('unequip')
    base.pathTo = async () => {
      calls.push('pathTo')
      return { state: 'ok' as const }
    }
    base.off = () => { calls.push('off') }
  }
  return { body: base as unknown as BodyApi, calls }
}

const WRITES = [
  'moveTo', 'lookAt', 'dig', 'place', 'useItem', 'equip', 'craft', 'useOn',
  'attack', 'sleep', 'fatalStep', 'containerTransfer', 'containerAt',
  'combatInput', 'lookYaw', 'offhandHold', 'unequip',
] as const

type LooseView = Record<string, (...args: unknown[]) => Promise<unknown>>

const asLoose = (view: BodyApi): LooseView => view as unknown as LooseView

describe('scoped body', () => {
  it('forwards every write while the scope is active', async () => {
    const { body, calls } = fakeBody()
    const view = asLoose(scopeWrites(body, createScope(TOKEN)))
    for (const name of WRITES) {
      await view[name]?.({ x: 0, y: 0, z: 0 }, 'up', 'stone')
    }
    expect(new Set(calls)).toEqual(new Set(WRITES))
  })

  it('refuses every write after revocation without reaching the body', async () => {
    const { body, calls } = fakeBody()
    const scope = createScope(TOKEN)
    revokeScope(scope)
    const rejected: string[] = []
    const view = asLoose(scopeWrites(body, scope, method => rejected.push(method)))

    for (const name of WRITES) {
      const result = await view[name]?.({ x: 0, y: 0, z: 0 }, 'up', 'stone')
      expect(result).toMatchObject({ state: 'failed', code: 'STALE_WRITE' })
    }
    expect(calls).toEqual([])
    expect(scope.rejected).toBe(WRITES.length)
    expect(rejected).toEqual([...WRITES])
  })

  it('keeps reads available after revocation', () => {
    const { body, calls } = fakeBody()
    const scope = createScope(TOKEN)
    const view = scopeWrites(body, scope)
    revokeScope(scope)
    expect(view.blockAt({ x: 0, y: 0, z: 0 })).toBeNull()
    expect(view.inventory()).toEqual([])
    expect(view.self().health).toBe(20)
    expect(calls).toEqual(['blockAt', 'inventory', 'self'])
  })

  it('preserves optional method presence in both directions', () => {
    const full = scopeWrites(fakeBody().body, createScope(TOKEN))
    expect(typeof full.combatInput).toBe('function')
    expect(typeof full.pathTo).toBe('function')
    expect(typeof full.off).toBe('function')

    const bare = scopeWrites(fakeBody({ full: false }).body, createScope(TOKEN))
    expect(bare.combatInput).toBeUndefined()
    expect(bare.pathTo).toBeUndefined()
    expect(bare.off).toBeUndefined()
    expect(bare.unequip).toBeUndefined()
  })

  it('does not expose authority management to a driver', () => {
    const view = scopeWrites(fakeBody().body, createScope(TOKEN))
    expect(() => view.beginWrite(TOKEN)).toThrow(/JobTracker/u)
    expect(() => view.endWrite(TOKEN)).toThrow(/JobTracker/u)
  })

  it('forwards chat and planning, which are not body writes', async () => {
    const { body, calls } = fakeBody()
    const view = scopeWrites(body, createScope(TOKEN))
    view.say('hi')
    await view.pathTo?.({ x: 0, y: 0, z: 0 }, 1, 100)
    expect(calls).toEqual(['say', 'pathTo'])
  })

  it('a revoked scope cannot be re-armed', () => {
    const scope = createScope(TOKEN)
    revokeScope(scope)
    revokeScope(scope)
    expect(scope.revoked).toBe(true)
  })
})

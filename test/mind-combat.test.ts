import { describe, expect, it } from 'vitest'

import { createAttackDriver } from '../src/mind/drivers/attack.ts'
import type { DriverCtx, Job } from '../src/mind/types.ts'
import type { BodyApi, EntityInfo } from '../src/body/api.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function entity(id: string, x: number, overrides: Partial<EntityInfo> = {}): EntityInfo {
  return {
    id,
    name: 'zombie',
    position: { x, y: 64, z: 0.5 },
    type: 'hostile',
    kind: 'Hostile mobs',
    health: 20,
    width: 0.6,
    height: 1.8,
    yaw: Math.PI,
    ...overrides,
  }
}

type Listener = { event: string; cb: (payload: unknown) => void }

function fakeBody(options: {
  target?: () => EntityInfo | undefined
  hasInput?: boolean
  shield?: boolean
} = {}): {
  body: BodyApi
  inputs: Array<{ forward?: boolean; back?: boolean; left?: boolean; right?: boolean }>
  stances: boolean[]
  attacks: () => number
  listeners: Listener[]
  emit: (event: string, entityId: string) => void
} {
  let target = options.target === undefined ? entity('z1', 6) : options.target()
  let self = { x: 0.5, y: 64, z: 0.5 }
  const inputs: Array<{ forward?: boolean; back?: boolean; left?: boolean; right?: boolean }> = []
  const stances: boolean[] = []
  const listeners: Listener[] = []
  let attacks = 0
  const emit = (event: string, entityId: string): void => {
    for (const listener of listeners) {
      if (listener.event === event) listener.cb({ entityId })
    }
  }
  const body = {
    self: () => ({ pos: { ...self }, health: 20, height: 1.8, food: 20, yaw: 0, pitch: 0, onGround: true }),
    entities: () => (target === undefined ? [] : [target]),
    entityById: () => target,
    inventory: () => [{ slot: 0, name: 'iron_sword', count: 1 }],
    offhand: () => (options.shield === false ? undefined : { slot: 45, name: 'shield', count: 1 }),
    equip: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    attack: async () => {
      attacks += 1
      target = undefined
      emit('entityDead', 'z1')
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    ...(options.hasInput === false
      ? {}
      : {
          combatInput: async (opts: { forward?: boolean; back?: boolean; left?: boolean; right?: boolean }) => {
            inputs.push(opts)
            if (opts.forward === true) self = { ...self, x: self.x + 0.3 }
            return { state: 'ok' as const, elapsedMs: 1 }
          },
        }),
    lookAt: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    offhandHold: async (active: boolean) => {
      stances.push(active)
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    canSee: () => true,
    attackSpeed: () => 4,
    attackReach: () => 3,
    on: (event: string, cb: (payload: unknown) => void) => { listeners.push({ event, cb }) },
    off: (event: string, cb: (payload: unknown) => void) => {
      const index = listeners.findIndex(listener => listener.event === event && listener.cb === cb)
      if (index >= 0) listeners.splice(index, 1)
    },
  } as unknown as BodyApi
  return {
    body,
    inputs,
    stances,
    attacks: () => attacks,
    listeners,
    emit,
  }
}

function job(params: Record<string, unknown>): Job {
  return { driverId: 'attack', params } as unknown as Job
}

function ctx(body: BodyApi): DriverCtx {
  return { body } as unknown as DriverCtx
}

async function run(handle: ReturnType<ReturnType<typeof createAttackDriver>['start']>): Promise<void> {
  for (let index = 0; index < 300 && handle.result().state === 'running'; index += 1) {
    handle.tick()
    await sleep(10)
  }
}

describe('attack tick driver', () => {
  it('approaches, attacks and succeeds through CombatSession', async () => {
    const fake = fakeBody()
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), ctx(fake.body))
    await run(handle)
    expect(handle.result().state).toBe('succeeded')
    expect(handle.result().observed).toMatchObject({ kind: 'attack', entityId: 'z1', killed: true })
    expect(fake.attacks()).toBe(1)
    expect(fake.inputs.some(input => input.forward === true)).toBe(true)
    expect(fake.stances[0]).toBe(true)
  })

  it('reports a disappearance as targetLost, never killed', async () => {
    const fake = fakeBody({ target: () => undefined })
    const handle = createAttackDriver().start(job({ entityId: 'z1' }), ctx(fake.body))
    await run(handle)
    expect(handle.result()).toMatchObject({ state: 'failed', code: 'ATTACK_TARGET_LOST' })
    expect(handle.result().observed).toMatchObject({ killed: false, targetLost: true })
  })

  it('protects a player target unless allowAny is set', async () => {
    const fake = fakeBody({ target: () => entity('p1', 2.5, { name: 'Player', type: 'player', kind: 'player' }) })
    const blocked = createAttackDriver().start(job({ entityId: 'p1' }), ctx(fake.body))
    await run(blocked)
    expect(blocked.result().code).toBe('ATTACK_TARGET_PROTECTED')
  })

  it('releases the shield and stops input when requested', async () => {
    const fake = fakeBody({ target: () => entity('z1', 20) })
    const handle = createAttackDriver().start(job({ entityId: 'z1' }), ctx(fake.body))
    for (let index = 0; index < 5; index += 1) {
      handle.tick()
      await sleep(10)
    }
    handle.requestStop()
    expect(handle.result().state).toBe('interrupted')
    expect(fake.stances.at(-1)).toBe(false)
    expect(fake.inputs.at(-1)?.forward).not.toBe(true)
  })

  it('fails explicitly without combatInput rather than falling back', async () => {
    const fake = fakeBody({ target: () => entity('z1', 8), hasInput: false })
    const handle = createAttackDriver().start(job({ entityId: 'z1' }), ctx(fake.body))
    await run(handle)
    expect(handle.result()).toMatchObject({ state: 'failed', code: 'ATTACK_NO_APPROACH' })
  })
})

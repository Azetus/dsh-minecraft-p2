import { describe, expect, it } from 'vitest'
import {
  CombatSession,
  decideCombatMove,
  engageBand,
  nextStrafeSide,
  tooCloseFor,
  type CombatEntity,
  type CombatInput,
  type CombatPort,
} from '../src/motion/combat/index.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function zombie(x = 6, extra: Partial<CombatEntity> = {}): CombatEntity {
  return {
    id: 'z1',
    name: 'zombie',
    position: { x, y: 64, z: 0.5 },
    health: 20,
    width: 0.6,
    height: 1.8,
    yaw: Math.PI,
    ...extra,
  }
}

type Fake = {
  port: CombatPort
  inputs: CombatInput[]
  stances: boolean[]
  attacks: () => number
  setTarget: (target: CombatEntity | undefined) => void
  setSelfHealth: (health: number) => void
  hurt: (id: string) => void
  dead: (id: string) => void
}

function fakePort(options: {
  target?: CombatEntity | undefined
  selfHealth?: number
  hasInput?: boolean
  killOnAttack?: boolean
} = {}): Fake {
  let target: CombatEntity | undefined = options.target === undefined ? zombie() : options.target
  let self = { pos: { x: 0.5, y: 64, z: 0.5 }, health: options.selfHealth ?? 20, height: 1.8 }
  const inputs: CombatInput[] = []
  const stances: boolean[] = []
  let attacks = 0
  const hurtListeners = new Set<(id: string) => void>()
  const deadListeners = new Set<(id: string) => void>()
  const emitHurt = (id: string): void => { for (const cb of hurtListeners) cb(id) }
  const emitDead = (id: string): void => { for (const cb of deadListeners) cb(id) }
  const port: CombatPort = {
    now: () => Date.now(),
    self: () => ({ ...self }),
    entity: () => target,
    canSee: () => true,
    attackSpeed: () => 4,
    reach: () => 3,
    attack: async () => {
      attacks += 1
      if (options.killOnAttack !== false) {
        target = undefined
        emitDead('z1')
      }
      return { state: 'ok' }
    },
    ...(options.hasInput === false
      ? {}
      : {
          combatInput: async (opts: CombatInput) => {
            inputs.push(opts)
            if (opts.forward === true) self = { ...self, pos: { ...self.pos, x: self.pos.x + 0.3 } }
            return { state: 'ok' }
          },
        }),
    lookAt: async () => ({ state: 'ok' }),
    hasShield: () => true,
    offhandHold: async (active: boolean) => {
      stances.push(active)
      return { state: 'ok' }
    },
    onEntityHurt: cb => {
      hurtListeners.add(cb)
      return () => hurtListeners.delete(cb)
    },
    onEntityDead: cb => {
      deadListeners.add(cb)
      return () => deadListeners.delete(cb)
    },
  }
  return {
    port,
    inputs,
    stances,
    attacks: () => attacks,
    setTarget: value => { target = value },
    setSelfHealth: value => { self = { ...self, health: value } },
    hurt: id => emitHurt(id),
    dead: id => emitDead(id),
  }
}

async function run(session: CombatSession): Promise<void> {
  for (let index = 0; index < 60 && session.state === 'running'; index += 1) {
    session.tick()
    await sleep(0)
  }
}

describe('combat spacing helpers', () => {
  it('derives the band and too-close distance from reach', () => {
    expect(engageBand(3)).toEqual({ min: 2.2, desired: 2.5, max: 2.8 })
    expect(tooCloseFor(3)).toBeCloseTo(1.6)
  })

  it('holds, approaches, strafes and backs off by distance', () => {
    expect(decideCombatMove({
      distance: 4, band: engageBand(3), tooClose: 1.6, visible: true,
      recentlyHurt: false, stalled: false, strafeEnabled: true, side: 'left',
    })).toBe('approach')
    expect(decideCombatMove({
      distance: 2.5, band: engageBand(3), tooClose: 1.6, visible: true,
      recentlyHurt: false, stalled: false, strafeEnabled: true, side: 'left', targetFacing: true,
    })).toBe('strafe-left')
    expect(decideCombatMove({
      distance: 1.2, band: engageBand(3), tooClose: 1.6, visible: true,
      recentlyHurt: false, stalled: false, strafeEnabled: true, side: 'left',
    })).toBe('backoff')
    expect(decideCombatMove({
      distance: 2.5, band: engageBand(3), tooClose: 1.6, visible: true,
      recentlyHurt: true, stalled: false, strafeEnabled: true, side: 'left',
    })).toBe('hold')
  })

  it('flips the strafe side after four steps', () => {
    expect(nextStrafeSide('left', 0)).toEqual({ side: 'left', steps: 1 })
    expect(nextStrafeSide('left', 3)).toEqual({ side: 'right', steps: 0 })
  })
})

describe('CombatSession tick', () => {
  it('advances with combatInput, attacks in reach, and keeps the shield', async () => {
    const fake = fakePort({ target: zombie(6) })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000 })
    await run(session)
    expect(session.state).toBe('succeeded')
    expect(session.result()?.observed.inputTicks).toBeGreaterThan(0)
    expect(fake.attacks()).toBe(1)
    expect(fake.inputs.some(input => input.forward === true)).toBe(true)
    expect(fake.stances[0]).toBe(true)
    const firstFalse = fake.stances.indexOf(false)
    expect(firstFalse === -1 || firstFalse > 0).toBe(true)
  })

  it('attacks while the shield and movement controls are active', async () => {
    const fake = fakePort({ target: zombie(2.5) })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000 })
    session.tick()
    await sleep(0)
    expect(session.state).toBe('succeeded')
    expect(fake.stances[0]).toBe(true)
    expect(fake.inputs.length).toBeGreaterThan(0)
    expect(fake.attacks()).toBe(1)
  })

  it('holds movement during the hurt guard but still attacks', async () => {
    const fake = fakePort({ target: zombie(2.5) })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000, guardMs: 1_000 })
    fake.setSelfHealth(14)
    session.tick()
    await sleep(0)
    expect(session.result()?.state).toBe('succeeded')
    expect(session.result()?.observed.guardWindows).toBeGreaterThan(0)
    expect(fake.attacks()).toBe(1)
    expect(fake.inputs[0]?.forward).not.toBe(true)
  })

  it('strafes when the target is in the band and facing us', async () => {
    const fake = fakePort({ target: zombie(3.2, { yaw: Math.PI / 2 }), killOnAttack: false })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000, maxAttacks: 1 })
    session.tick()
    await sleep(0)
    expect(fake.inputs[0]?.left === true || fake.inputs[0]?.right === true).toBe(true)
  })

  it('reports a target that is already gone as lost', async () => {
    const fake = fakePort()
    fake.setTarget(undefined)
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000 })
    session.tick()
    await sleep(0)
    expect(session.state).toBe('failed')
    expect(session.result()?.code).toBe('ATTACK_TARGET_LOST')
  })

  it('protects a player unless allowAny is set', async () => {
    const fake = fakePort({ target: zombie(2.5, { type: 'player' }) })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000 })
    session.tick()
    await sleep(0)
    expect(session.result()?.code).toBe('ATTACK_TARGET_PROTECTED')
  })

  it('stops input and releases the shield on requestStop', async () => {
    const fake = fakePort({ target: zombie(8), killOnAttack: false })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000 })
    session.tick()
    await sleep(0)
    session.requestStop()
    expect(session.state).toBe('interrupted')
    expect(session.result()?.code).toBe('ATTACK_INTERRUPTED')
    expect(fake.stances.at(-1)).toBe(false)
  })

  it('fails explicitly when the adapter has no combatInput', async () => {
    const fake = fakePort({ target: zombie(8), hasInput: false })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000 })
    session.tick()
    await sleep(0)
    expect(session.result()?.code).toBe('ATTACK_NO_APPROACH')
  })
})

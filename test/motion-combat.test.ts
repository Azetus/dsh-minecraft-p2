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
  explode: (pos: { x: number; y: number; z: number }, radius?: number) => void
}

function fakePort(options: {
  target?: CombatEntity | undefined
  selfHealth?: number
  hasInput?: boolean
  killOnAttack?: boolean
  canSee?: () => boolean
  combatInput?: (opts: CombatInput) => Promise<{ state: 'ok' | 'failed' | 'unknown'; code?: string }>
  pathTo?: (pos: { x: number; y: number; z: number }, range: number, timeoutMs: number) => Promise<{
    state: 'ok' | 'failed'
    path?: Array<{ x: number; y: number; z: number }>
  }>
} = {}): Fake {
  let target: CombatEntity | undefined = options.target === undefined ? zombie() : options.target
  let self = { pos: { x: 0.5, y: 64, z: 0.5 }, health: options.selfHealth ?? 20, height: 1.8 }
  const inputs: CombatInput[] = []
  const stances: boolean[] = []
  let attacks = 0
  const hurtListeners = new Set<(id: string) => void>()
  const deadListeners = new Set<(id: string) => void>()
  const explosionListeners = new Set<(pos: { x: number; y: number; z: number }, radius?: number) => void>()
  const emitHurt = (id: string): void => { for (const cb of hurtListeners) cb(id) }
  const emitDead = (id: string): void => { for (const cb of deadListeners) cb(id) }
  const port: CombatPort = {
    now: () => Date.now(),
    self: () => ({ ...self }),
    entity: () => target,
    canSee: options.canSee ?? (() => true),
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
    ...(options.pathTo === undefined ? {} : { pathTo: options.pathTo }),
    ...(options.hasInput === false
      ? {}
      : {
          combatInput: async (opts: CombatInput) => {
            inputs.push(opts)
            if (options.combatInput !== undefined) return options.combatInput(opts)
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
    onExplosion: cb => {
      explosionListeners.add(cb)
      return () => explosionListeners.delete(cb)
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
    explode: (pos, radius) => {
      for (const cb of explosionListeners) cb(pos, radius)
    },
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

  it('switches to the next allowed target when the first dies', async () => {
    const targets = new Map<string, CombatEntity>([
      ['z1', zombie(6)],
      ['z2', zombie(4)],
    ])
    let self = { pos: { x: 0.5, y: 64, z: 0.5 }, health: 20, height: 1.8 }
    const deadListeners = new Set<(id: string) => void>()
    const port: CombatPort = {
      now: () => Date.now(),
      self: () => self,
      entity: id => targets.get(id),
      canSee: () => true,
      attackSpeed: () => 4,
      reach: () => 3,
      attack: async id => {
        targets.delete(id)
        for (const cb of deadListeners) cb(id)
        return { state: 'ok' }
      },
      combatInput: async opts => {
        if (opts.forward === true) self = { ...self, pos: { ...self.pos, x: self.pos.x + 0.3 } }
        return { state: 'ok' }
      },
      hasShield: () => false,
      onEntityHurt: () => () => {},
      onEntityDead: cb => {
        deadListeners.add(cb)
        return () => deadListeners.delete(cb)
      },
    }
    const session = new CombatSession(port, ['z1', 'z2'], { totalMs: 5_000, shield: false })
    await run(session)
    expect(session.state).toBe('succeeded')
    expect(session.result()?.observed.kills).toBe(2)
    expect(session.result()?.observed.targetSwitches).toBeGreaterThanOrEqual(1)
  })

  it('recovers line of sight by approaching before the LOS budget expires', async () => {
    let visible = false
    let ticks = 0
    const fake = fakePort({
      target: zombie(6),
      canSee: () => {
        ticks += 1
        if (ticks > 3) visible = true
        return visible
      },
    })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000, losRecoveryTicks: 10 })
    await run(session)
    expect(session.state).toBe('succeeded')
    expect(fake.inputs.some(input => input.forward === true)).toBe(true)
  })

  it('fails LOS only after the recovery budget', async () => {
    const fake = fakePort({ target: zombie(6), canSee: () => false })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000, losRecoveryTicks: 2 })
    await run(session)
    expect(session.result()?.code).toBe('ATTACK_NO_LINE_OF_SIGHT')
  })

  it('backpedals while facing a creeper in attack range', async () => {
    const fake = fakePort({ target: zombie(2.5, { name: 'creeper' }) })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000, creeperBackpedal: true })
    session.tick()
    await sleep(0)
    expect(session.result()?.observed.backoffMoves).toBeGreaterThan(0)
    expect(session.result()?.observed.explosionThreat).toBe(true)
    expect(fake.inputs[0]?.back).toBe(true)
  })

  it('reports ranged threat without auto-escaping', async () => {
    const fake = fakePort({ target: zombie(3.2, { name: 'skeleton', yaw: Math.PI / 2 }) })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000 })
    session.tick()
    await sleep(0)
    expect(session.result()?.observed.rangedThreat).toBe(true)
    expect(session.result()?.observed.kills).toBe(1)
  })

  it('tries a one-block jump before a lateral detour', async () => {
    const fake = fakePort({
      target: zombie(6),
      combatInput: async opts => opts.forward === true && opts.jump === true
        ? { state: 'ok' }
        : opts.forward === true
          ? { state: 'failed', code: 'COMBAT_INPUT_BLOCKED' }
          : { state: 'ok' },
    })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000 })
    session.tick()
    await sleep(0)
    session.tick()
    await sleep(0)
    expect(fake.inputs.some(input => input.jump === true)).toBe(true)
  })

  it('detours sideways when a jump does not clear the obstacle', async () => {
    const fake = fakePort({
      target: zombie(6),
      combatInput: async opts => opts.forward === true
        ? { state: 'failed', code: 'COMBAT_INPUT_BLOCKED' }
        : { state: 'ok' },
    })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000 })
    for (let index = 0; index < 4; index += 1) {
      session.tick()
      await sleep(0)
    }
    expect(fake.inputs.some(input => input.left === true || input.right === true)).toBe(true)
  })

  it('marks an explicit creeper explosion as neutralized, not killed', async () => {
    const fake = fakePort({ target: zombie(2.5, { name: 'creeper' }), killOnAttack: false })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000 })
    session.tick()
    await sleep(0)
    fake.explode({ x: 2.5, y: 64, z: 0.5 }, 3)
    await sleep(0)
    expect(session.result()).toMatchObject({
      state: 'failed',
      code: 'ATTACK_TARGET_NEUTRALIZED',
      observed: { killed: false, resolution: 'neutralized', resolved: true, retryable: false, neutralized: 1 },
    })
  })

  it('resolves an engagement when all allowed targets are gone', async () => {
    const fake = fakePort()
    fake.setTarget(undefined)
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000, engagement: true })
    session.tick()
    await sleep(0)
    expect(session.result()).toMatchObject({
      state: 'succeeded',
      code: 'ATTACK_TARGETS_RESOLVED',
      observed: { killed: false, resolution: 'lost', resolved: true, retryable: false },
    })
  })

  it('honors an optional chase leash', async () => {
    const fake = fakePort({ target: zombie(20), killOnAttack: false })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000, chaseLeash: 5 })
    await run(session)
    expect(session.result()).toMatchObject({
      state: 'failed',
      code: 'ATTACK_CHASE_LIMIT',
      observed: { resolved: false, retryable: true },
    })
  })

  it('plans a path and follows waypoints when line of sight is missing', async () => {
    let calls = 0
    const fake = fakePort({
      target: zombie(10),
      canSee: () => false,
      pathTo: async () => {
        calls += 1
        return {
          state: 'ok',
          path: [
            { x: 6.5, y: 64, z: 0.5 },
            { x: 8.5, y: 64, z: 0.5 },
            { x: 9.5, y: 64, z: 0.5 },
          ],
        }
      },
    })
    const session = new CombatSession(fake.port, 'z1', { totalMs: 5_000, losRecoveryTicks: 30 })
    for (let index = 0; index < 14; index += 1) {
      session.tick()
      await sleep(0)
    }
    expect(calls).toBeGreaterThan(0)
    expect(fake.inputs.some(input => input.forward === true)).toBe(true)
  })
})

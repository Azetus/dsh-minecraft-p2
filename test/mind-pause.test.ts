import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createMind } from '../src/body/mind.ts'
import type { SuspensionState } from '../src/contracts/protocol.ts'
import type { BlockInfo, ClientPort, SelfInfo, Vec3 } from '../src/port/index.ts'

/**
 * Category: state safety (F pause semantics).
 * Protects: a paused server suspends work instead of failing it. The running
 * job ends `interrupted/SUSPENDED` (no retry consumed), no new job is dispatched
 * while suspended, and work resumes from a fresh observation afterwards.
 */

const root = process.cwd()
const dir = mkdtempSync(join(root, 'node_modules', '.p2-pause-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`

function suspension(suspended: boolean, at = 0): SuspensionState {
  return {
    suspended,
    at: suspended ? at : 0,
    idleMs: suspended ? 1_600 : 0,
    serverAge: 100,
    diagnostics: {
      ...(suspended ? { suspendedSince: at } : {}),
      ageChanges: 1,
      timePackets: 4,
      eventLoopLagMs: 3,
      ageIdleMs: 1_600,
      verdict: suspended ? 'server-paused' : 'running',
      lastAgeAt: 0,
      lastAge: 100,
    },
  }
}

function fakePort(state: { suspension: SuspensionState; pos: Vec3 }): ClientPort {
  const blocks = new Map<string, BlockInfo>()
  for (let x = -1; x <= 2; x += 1) {
    for (let z = -1; z <= 1; z += 1) {
      blocks.set(key({ x, y: 63, z }), { name: 'stone', loaded: true, pos: { x, y: 63, z } })
      blocks.set(key({ x, y: 64, z }), { name: 'air', loaded: true, pos: { x, y: 64, z } })
      blocks.set(key({ x, y: 65, z }), { name: 'air', loaded: true, pos: { x, y: 65, z } })
    }
  }
  const self = (): SelfInfo => ({
    pos: state.pos,
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    onGround: true,
    inWater: false,
    inLava: false,
  })
  return {
    on: () => {},
    self,
    suspension: () => state.suspension,
    time: () => ({ timeOfDay: 1000, worldAge: 100 }),
    blockAt: (p: Vec3) => blocks.get(key(p)) ?? null,
    blocksIn: (box: { min: Vec3; max: Vec3 }) => [...blocks.values()].filter(block => block.pos !== undefined
      && block.pos.x >= box.min.x && block.pos.x <= box.max.x
      && block.pos.y >= box.min.y && block.pos.y <= box.max.y
      && block.pos.z >= box.min.z && block.pos.z <= box.max.z),
    entities: () => [],
    inventory: () => [{ slot: 36, name: 'dirt', count: 8 }],
    beginWrite: () => {},
    endWrite: () => {},
    moveTo: async (target: Vec3) => {
      state.pos = { x: target.x + 0.5, y: target.y, z: target.z + 0.5 }
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    place: async (p: Vec3, _face: string, item: string) => {
      blocks.set(key(p), { name: item, loaded: true, pos: { ...p } })
      return { state: 'ok' as const, elapsedMs: 1 }
    },
  } as unknown as ClientPort
}

const flush = async (): Promise<void> => {
  await new Promise(resolve => setImmediate(resolve))
}

describe('pause semantics', () => {
  it('suspends the running job without consuming a retry, then resumes', async () => {
    const state = { suspension: suspension(false), pos: { x: 0.5, y: 64, z: 0.5 } }
    const mind = createMind({
      port: fakePort(state),
      home: { x: 0, y: 64, z: 0 },
      plansDir: join(root, 'content', 'plans'),
      journalPath: join(dir, 'journal.jsonl'),
    })
    mind.enqueueOrder({ id: 'go-1', verb: 'go', params: { x: 1.5, y: 64, z: 0.5 } })
    mind.tick()
    await flush()
    mind.tick()
    const started = [...mind.events.since(0, 500)].filter(event => event.kind === 'job.started')
    expect(started.length).toBeGreaterThanOrEqual(1)

    state.suspension = suspension(true, 1_000)
    mind.tick()
    const suspended = [...mind.events.since(0, 500)].find(event => event.kind === 'mind.suspended')
    expect(suspended).toBeDefined()
    expect(mind.status().suspended).toBe(true)
    expect(mind.status().tracker).not.toBe('fault')

    // The interruption is not a failure: no blocked order, no failed job.
    for (let index = 0; index < 5; index += 1) {
      mind.tick()
      await flush()
    }
    const terminals = [...mind.events.since(0, 500)].filter(event => event.kind === 'job.terminal')
    expect(terminals.every(event => (event.data as { state: string }).state !== 'failed')).toBe(true)
    const jobsWhileSuspended = [...mind.events.since(0, 500)].filter(event => event.kind === 'job.started').length
    mind.tick()
    expect([...mind.events.since(0, 500)].filter(event => event.kind === 'job.started').length)
      .toBe(jobsWhileSuspended)

    state.suspension = suspension(false)
    state.pos = { x: 0.5, y: 64, z: 0.5 }
    mind.tick()
    expect([...mind.events.since(0, 500)].some(event => event.kind === 'mind.resumed')).toBe(true)
    await flush()
    mind.tick()
    expect(mind.orders.get('go-1')?.state).not.toBe('failed')
    expect(mind.orders.get('go-1')?.state).not.toBe('blocked')
  })

  it('freezes the plan watchdog while suspended and keeps the plan active', async () => {
    const state = { suspension: suspension(false), pos: { x: 0.5, y: 64, z: 0.5 } }
    let clock = 1_000
    const mind = createMind({
      port: fakePort(state),
      now: () => clock,
      home: { x: 0, y: 64, z: 0 },
      plansDir: join(root, 'content', 'plans'),
      journalPath: join(dir, 'journal2.jsonl'),
    })
    mind.enqueueOrder({
      id: 'b1-tiny',
      verb: 'build',
      blueprint: { blocks: [{ x: 0, y: 64, z: 0, name: 'dirt' }] },
    })
    mind.tick()
    expect(mind.status().plan).not.toBeNull()

    state.suspension = suspension(true, clock)
    mind.tick()
    // 120 s of wall time pass while the server is frozen.
    clock += 120_000
    for (let index = 0; index < 5; index += 1) mind.tick()
    expect([...mind.events.since(0, 500)].some(event => event.kind === 'plan.blocked')).toBe(false)
    expect([...mind.events.since(0, 500)].some(event => event.kind === 'plan.stalled')).toBe(false)
    expect(mind.orders.get('b1-tiny')?.state).toBe('active')

    state.suspension = suspension(false)
    mind.tick()
    await flush()
    for (let index = 0; index < 20; index += 1) {
      mind.tick()
      await flush()
      if (mind.orders.get('b1-tiny')?.state === 'succeeded') break
    }
    expect(mind.orders.get('b1-tiny')?.state).toBe('succeeded')
  })
})

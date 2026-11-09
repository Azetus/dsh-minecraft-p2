import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createMind } from '../src/body/mind.ts'
import { OrderStore } from '../src/mind/orders.ts'
import type { BlockInfo, BodyApi, SelfInfo, Vec3 } from '../src/body/api.ts'

/**
 * Category: recovery (M3-04).
 * Protects: a pending action is reconciled from the world, never replayed;
 * an unresolved pending action blocks the order instead of repeating it.
 */

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-recovery-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`

function fakePort(targetName: string): { port: BodyApi; places: number } {
  const blocks = new Map<string, BlockInfo>()
  blocks.set('0,63,0', { name: 'stone', loaded: true, pos: { x: 0, y: 63, z: 0 } })
  blocks.set('0,64,0', { name: targetName, loaded: true, pos: { x: 0, y: 64, z: 0 } })
  blocks.set('0,65,0', { name: 'air', loaded: true, pos: { x: 0, y: 65, z: 0 } })
  const self: SelfInfo = {
    pos: { x: 1.5, y: 64, z: 0.5 },
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    onGround: true,
    inWater: false,
    inLava: false,
  }
  let places = 0
  const port = {
    on: () => {},
    self: () => self,
    time: () => ({ timeOfDay: 1000, worldAge: 1 }),
    biomeAt: () => ({ id: 39, name: 'plains' }),
    blockAt: (p: Vec3) => blocks.get(key(p)) ?? null,
    blocksIn: (box: { min: Vec3; max: Vec3 }) => [...blocks.values()].filter(block => block.pos !== undefined
      && block.pos.x >= box.min.x && block.pos.x <= box.max.x
      && block.pos.y >= box.min.y && block.pos.y <= box.max.y
      && block.pos.z >= box.min.z && block.pos.z <= box.max.z),
    entities: () => [],
    inventory: () => [{ slot: 36, name: 'dirt', count: 1 }],
    beginWrite: () => {},
    endWrite: () => {},
    place: async (p: Vec3) => {
      places += 1
      blocks.set(key(p), { name: 'dirt', loaded: true, pos: { ...p } })
      return { state: 'ok' as const, elapsedMs: 1 }
    },
  } as unknown as BodyApi
  return { port, get places() { return places } }
}

function seed(journal: string): void {
  const store = new OrderStore({ journalPath: journal, now: () => 1 })
  store.enqueue({
    id: 'ord-pending',
    verb: 'build',
    blueprint: { blocks: [{ x: 0, y: 64, z: 0, name: 'dirt' }] },
  })
  store.recordActionPending({
    runId: 'run-pending',
    driverId: 'place',
    keys: 'plan:plan-ord-pending-blueprint:b:0,64,0',
    orderId: 'ord-pending',
    planId: 'plan-ord-pending-blueprint',
    workItemId: 'b:0,64,0',
  })
}

function mindWith(port: BodyApi, journal: string) {
  return createMind({
    body: port,
    home: { x: 1, y: 64, z: 0 },
    baseActivity: { kind: 'idle' },
    plansDir: join(process.cwd(), 'content', 'plans'),
    journalPath: journal,
  })
}

describe('recovery of pending actions', () => {
  it('settles a pending place from the world without replaying it', () => {
    const journal = join(tempDir(), 'journal.jsonl')
    seed(journal)
    const fake = fakePort('dirt')
    const mind = mindWith(fake.port, journal)
    mind.tick()

    expect(mind.orders.get('ord-pending')?.state).toBe('succeeded')
    expect(fake.places).toBe(0)
    const events = [...mind.events.since(0)]
    expect(events.some(event => event.kind === 'action.reconciled')).toBe(true)
    const reconciled = events.find(event => event.kind === 'action.reconciled')
    expect(reconciled?.data).toMatchObject({ basis: { self: expect.any(Object) } })
  })

  it('blocks the order when a pending place is not visible in the world', () => {
    const journal = join(tempDir(), 'journal.jsonl')
    seed(journal)
    const fake = fakePort('air')
    const mind = mindWith(fake.port, journal)
    mind.tick()

    expect(mind.orders.get('ord-pending')?.state).toBe('blocked')
    expect(fake.places).toBe(0)
    const unreconciled = [...mind.events.since(0)].find(event => event.kind === 'action.unreconciled')
    expect(unreconciled?.data).toMatchObject({ actions: [{ runId: 'run-pending' }] })
  })
})

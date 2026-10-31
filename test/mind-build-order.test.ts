import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createMind } from '../src/body/mind.ts'
import type { BlockInfo, ClientPort, SelfInfo, Vec3 } from '../src/port/index.ts'

/**
 * Category: cross-module contract (M3-02 order ingestion).
 * Protects: a build order with an inline blueprint needs no content template,
 * and the real place driver finishes it against observed state.
 */

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-build-order-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`

function fakePort(dirtCount = 2): { port: ClientPort; blocks: Map<string, BlockInfo>; places: number } {
  const blocks = new Map<string, BlockInfo>()
  blocks.set('0,63,0', { name: 'stone', loaded: true, pos: { x: 0, y: 63, z: 0 } })
  blocks.set('0,64,0', { name: 'air', loaded: true, pos: { x: 0, y: 64, z: 0 } })
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
    inventory: () => (dirtCount === 0 ? [] : [{ slot: 36, name: 'dirt', count: dirtCount }]),
    beginWrite: () => {},
    endWrite: () => {},
    place: async (p: Vec3) => {
      places += 1
      blocks.set(key(p), { name: 'dirt', loaded: true, pos: { ...p } })
      return { state: 'ok' as const, elapsedMs: 1 }
    },
  } as unknown as ClientPort
  return { port, blocks, get places() { return places } }
}

describe('build order', () => {
  it('builds an inline blueprint without a template file', async () => {
    const fake = fakePort()
    const mind = createMind({
      port: fake.port,
      home: { x: 1, y: 64, z: 0 },
      contentDir: join(process.cwd(), 'content', 'trees'),
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
    })

    const order = mind.enqueueOrder({
      id: 'ord-build',
      verb: 'build',
      blueprint: { blocks: [{ x: 0, y: 64, z: 0, name: 'dirt' }] },
    })
    expect(order.state).toBe('active')

    for (let index = 0; index < 200; index += 1) {
      mind.tick()
      if (mind.orders.get('ord-build')?.state === 'succeeded') break
      await wait(20)
    }

    expect(mind.orders.get('ord-build')?.state).toBe('succeeded')
    expect(fake.blocks.get('0,64,0')?.name).toBe('dirt')
    expect(fake.places).toBe(1)
    expect(mind.status().plan).toBeNull()
  })

  it('blocks a require-all order before placing when materials are missing', () => {
    const fake = fakePort(0)
    const mind = createMind({
      port: fake.port,
      home: { x: 1, y: 64, z: 0 },
      contentDir: join(process.cwd(), 'content', 'trees'),
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
    })
    mind.enqueueOrder({
      id: 'ord-short',
      verb: 'build',
      blueprint: { blocks: [{ x: 0, y: 64, z: 0, name: 'dirt' }] },
    })
    mind.tick()

    expect(mind.orders.get('ord-short')?.state).toBe('blocked')
    expect(fake.places).toBe(0)
    const event = [...mind.events.since(0)].find(candidate => candidate.kind === 'plan.material-short')
    expect(event?.data).toMatchObject({ basis: { self: expect.any(Object) } })
  })

  it('blocks auto-gather when a missing item has no source', () => {
    const fake = fakePort(0)
    const mind = createMind({
      port: fake.port,
      home: { x: 1, y: 64, z: 0 },
      contentDir: join(process.cwd(), 'content', 'trees'),
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
    })
    mind.enqueueOrder({
      id: 'ord-door',
      verb: 'build',
      blueprint: { blocks: [{ x: 0, y: 64, z: 0, name: 'oak_door' }] },
      policy: { materials: { mode: 'auto-gather' } },
    })
    mind.tick()

    expect(mind.orders.get('ord-door')?.state).toBe('blocked')
    expect(fake.places).toBe(0)
    expect([...mind.events.since(0)].some(event => event.kind === 'plan.material-short')).toBe(true)
  })
})

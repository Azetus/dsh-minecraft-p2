import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createMind } from '../src/body/mind.ts'
import type { BlockInfo, ClientPort, SelfInfo, Vec3 } from '../src/port/index.ts'

/**
 * Category: cross-module contract (todo M2-01/02/03 runtime wiring).
 * Protects: a build order instantiates a fixed-point plan, the real
 * clear/enter drivers finish it, and the order terminates from observed state.
 */

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-plan-runtime-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`

function block(name: string, p: Vec3): BlockInfo {
  return { name, loaded: true, pos: p }
}

function fakePort(): { port: ClientPort; blocks: Map<string, BlockInfo>; selfPos: Vec3 } {
  const blocks = new Map<string, BlockInfo>()
  blocks.set('0,64,0', block('stone', { x: 0, y: 64, z: 0 }))
  blocks.set('0,63,0', block('stone', { x: 0, y: 63, z: 0 }))
  blocks.set('0,65,0', block('air', { x: 0, y: 65, z: 0 }))
  const state = { selfPos: { x: 1.5, y: 64, z: 0.5 } }
  const self = (): SelfInfo => ({
    pos: state.selfPos,
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    onGround: true,
    inWater: false,
    inLava: false,
  })
  const port = {
    on: () => {},
    self,
    time: () => ({ timeOfDay: 1000, worldAge: 100 }),
    blockAt: (p: Vec3) => blocks.get(key(p)) ?? null,
    blocksIn: (box: { min: Vec3; max: Vec3 }) => [...blocks.values()].filter(item => item.pos !== undefined
      && item.pos.x >= box.min.x && item.pos.x <= box.max.x
      && item.pos.y >= box.min.y && item.pos.y <= box.max.y
      && item.pos.z >= box.min.z && item.pos.z <= box.max.z),
    entities: () => [],
    inventory: () => [],
    beginWrite: () => {},
    endWrite: () => {},
    dig: async (p: Vec3) => {
      blocks.set(key(p), block('air', p))
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    moveTo: async (target: Vec3) => {
      state.selfPos = { x: target.x + 0.5, y: target.y, z: target.z + 0.5 }
      return { state: 'ok' as const, elapsedMs: 1 }
    },
  } as unknown as ClientPort
  return { port, blocks, selfPos: state.selfPos }
}

describe('plan runtime', () => {
  it('runs a build order from observed geometry', async () => {
    const plansDir = tempDir()
    writeFileSync(join(plansDir, 'tiny.json'), JSON.stringify({
      id: 'tiny',
      version: 1,
      size: [1, 1, 1],
      materialPolicy: {},
      workItems: [
        { id: 'clear', kind: 'clear', at: [0, 0, 0] },
        { id: 'enter', kind: 'enter', at: [0, 0, 0], after: ['clear'] },
      ],
    }))

    const { port } = fakePort()
    const mind = createMind({
      port,
      home: { x: 1, y: 64, z: 0 },
      contentDir: join(process.cwd(), 'content', 'trees'),
      plansDir,
      journalPath: join(tempDir(), 'journal.jsonl'),
    })

    const order = mind.enqueueOrder({
      id: 'ord-tiny',
      verb: 'build',
      blueprint: {
        version: 1,
        blocks: [{ x: 0, y: 64, z: 0, name: 'stone' }],
      },
    })
    expect(order.state).toBe('active')

    for (let index = 0; index < 200; index += 1) {
      mind.tick()
      if (mind.orders.get('ord-tiny')?.state === 'succeeded') break
      await wait(20)
    }

    expect(mind.orders.get('ord-tiny')?.state).toBe('succeeded')
    expect(mind.status().plan).toBeNull()
    expect(mind.status().activeOrder).toBeNull()
    expect([...mind.events.since(0)].some(event => event.kind === 'plan.terminal')).toBe(true)
  })
})

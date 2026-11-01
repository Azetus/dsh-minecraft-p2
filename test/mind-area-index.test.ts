import { describe, expect, it } from 'vitest'

import { AreaResourceIndex } from '../src/mind/area.ts'
import type { BlockInfo, Box, ClientPort, Vec3 } from '../src/port/index.ts'

function inside(point: Vec3, box: Box): boolean {
  return point.x >= box.min.x && point.x <= box.max.x
    && point.y >= box.min.y && point.y <= box.max.y
    && point.z >= box.min.z && point.z <= box.max.z
}

function fakePort(blocks: BlockInfo[]): { port: ClientPort; calls: () => number } {
  let calls = 0
  const port = {
    blocksIn: (box: Box) => {
      calls += 1
      return blocks.filter(block => block.pos !== undefined && inside(block.pos, box))
    },
  } as unknown as ClientPort
  return { port, calls: () => calls }
}

describe('area resource index', () => {
  it('scans a bounded chunk at a time and caches the result', () => {
    const log = { name: 'oak_log', loaded: true, pos: { x: 5, y: 64, z: 5 } }
    const stone = { name: 'stone', loaded: true, pos: { x: 10, y: 64, z: 10 } }
    const fake = fakePort([log, stone])
    const area = new AreaResourceIndex(fake.port, { radius: 16, vertical: 8, chunkBudget: 1 })

    area.update({ x: 0, y: 64, z: 0 }, 0)
    const afterOne = fake.calls()
    expect(afterOne).toBe(1)
    expect(area.stale).toBe(true)

    for (let index = 0; index < 20 && area.pendingChunks > 0; index += 1) {
      area.update({ x: 0, y: 64, z: 0 }, index + 1)
    }
    expect(fake.calls()).toBeGreaterThan(afterOne)
    expect(area.stale).toBe(false)

    const before = fake.calls()
    area.update({ x: 0, y: 64, z: 0 }, 30)
    expect(fake.calls()).toBe(before)
    expect(area.nearest('oak_log', { x: 0, y: 64, z: 0 })).toMatchObject({ pos: log.pos })
  })

  it('applies block updates without a rescan', () => {
    const log = { name: 'oak_log', loaded: true, pos: { x: 5, y: 64, z: 5 } }
    const fake = fakePort([log])
    const area = new AreaResourceIndex(fake.port, { radius: 8, vertical: 4, chunkBudget: 4 })
    area.update({ x: 0, y: 64, z: 0 }, 0)
    for (let index = 0; index < 20 && area.pendingChunks > 0; index += 1) {
      area.update({ x: 0, y: 64, z: 0 }, index + 1)
    }
    const calls = fake.calls()

    expect(area.nearest('oak_log', { x: 0, y: 64, z: 0 })).toBeDefined()
    area.onBlockUpdate({ x: 5, y: 64, z: 5, name: 'air' })
    expect(area.nearest('oak_log', { x: 0, y: 64, z: 0 })).toBeUndefined()
    area.onBlockUpdate({ x: 5, y: 64, z: 5, name: 'oak_log' })
    expect(area.nearest('oak_log', { x: 0, y: 64, z: 0 })).toBeDefined()
    expect(fake.calls()).toBe(calls)
  })

  it('rebuilds when the body moves beyond the cache window', () => {
    const fake = fakePort([])
    const area = new AreaResourceIndex(fake.port, { radius: 16, vertical: 8, chunkBudget: 1 })
    area.update({ x: 0, y: 64, z: 0 }, 0)
    expect(area.stale).toBe(true)
    area.update({ x: 40, y: 64, z: 0 }, 1)
    expect(area.stale).toBe(true)
    expect(area.pendingChunks).toBeGreaterThan(0)
  })
})

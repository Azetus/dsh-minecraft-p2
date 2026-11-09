import { describe, expect, it } from 'vitest'

import { Sensors } from '../src/mind/sensors.ts'
import type { BlockInfo, BodyApi, EntityInfo, SelfInfo, Vec3 } from '../src/body/api.ts'

/**
 * Category: cross-module contract (B1 observation).
 * Protects: a plan observation box survives re-sampling, so walls/roof/stances
 * do not turn back into `unknown` when the default box follows the body.
 */

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`

function fakePort(): {
  port: BodyApi
  state: { pos: Vec3; entities: EntityInfo[] }
  blocks: Map<string, BlockInfo>
} {
  const blocks = new Map<string, BlockInfo>()
  for (const [x, y, z, name] of [
    [0, 64, 0, 'air'],
    [0, 63, 0, 'stone'],
    [40, 66, 40, 'dirt'],
  ] as const) {
    blocks.set(key({ x, y, z }), { name, loaded: true, pos: { x, y, z } })
  }
  const state: { pos: Vec3; entities: EntityInfo[] } = {
    pos: { x: 0.5, y: 64, z: 0.5 },
    entities: [],
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
  const port = {
    self,
    time: () => ({ timeOfDay: 1000, worldAge: 1 }),
    blockAt: (p: Vec3) => blocks.get(key(p)) ?? null,
    blocksIn: (box: { min: Vec3; max: Vec3 }) => [...blocks.values()].filter(block => block.pos !== undefined
      && block.pos.x >= box.min.x && block.pos.x <= box.max.x
      && block.pos.y >= box.min.y && block.pos.y <= box.max.y
      && block.pos.z >= box.min.z && block.pos.z <= box.max.z),
    entities: (box: { min: Vec3; max: Vec3 }) => state.entities.filter(entity =>
      entity.position.x >= box.min.x && entity.position.x <= box.max.x
      && entity.position.y >= box.min.y && entity.position.y <= box.max.y
      && entity.position.z >= box.min.z && entity.position.z <= box.max.z),
    inventory: () => [],
  } as unknown as BodyApi
  return { port, state, blocks }
}

describe('sensors observation groups', () => {
  it('re-reads a plan box on every sample instead of losing it', () => {
    const { port, state } = fakePort()
    let now = 0
    const sensors = new Sensors({ body: port, now: () => now, refreshMs: 100 })

    sensors.setObservation('plan', [{ min: { x: 38, y: 64, z: 38 }, max: { x: 42, y: 68, z: 42 } }])
    expect(sensors.read()?.blockAt({ x: 40, y: 66, z: 40 })?.name).toBe('dirt')

    // A new default-box sample after the refresh interval must still include
    // the plan box.
    state.pos = { x: 12.5, y: 64, z: 12.5 }
    now += 1_000
    const after = sensors.read()
    expect(after.blockAt({ x: 40, y: 66, z: 40 })?.name).toBe('dirt')

    sensors.clearObservation('plan')
    now += 1_000
    const cleared = sensors.read()
    expect(cleared.blockAt({ x: 40, y: 66, z: 40 })).toBeNull()
  })

  it('refreshes self and time when a targeted observation is requested', () => {
    const { port, state } = fakePort()
    let now = 0
    const sensors = new Sensors({ body: port, now: () => now, refreshMs: 1_000 })
    sensors.read()
    state.pos = { x: 5.5, y: 64, z: 5.5 }
    const fresh = sensors.observeBox({ min: { x: -1, y: 63, z: -1 }, max: { x: 1, y: 65, z: 1 } })
    expect(fresh.self.pos).toEqual({ x: 5.5, y: 64, z: 5.5 })
  })

  it('samples tracked entities inside the 15-block base box, including the vertical range', () => {
    const { port, state } = fakePort()
    const sensors = new Sensors({ body: port, now: () => 0, refreshMs: 1_000 })
    state.entities = [
      { id: 'p-edge', name: 'Alice', username: 'Alice', type: 'player', position: { x: 14.5, y: 64, z: 0.5 } },
      { id: 'p-out', name: 'Bob', username: 'Bob', type: 'player', position: { x: 16.5, y: 64, z: 0.5 } },
      { id: 'p-up', name: 'Carol', username: 'Carol', type: 'player', position: { x: 0.5, y: 78, z: 0.5 } },
      { id: 'p-high', name: 'Dave', username: 'Dave', type: 'player', position: { x: 0.5, y: 80, z: 0.5 } },
    ]
    const entities = sensors.read().entitiesIn({
      min: { x: -20, y: 50, z: -20 },
      max: { x: 20, y: 90, z: 20 },
    })
    expect(entities.map(entity => entity.id).sort()).toEqual(['p-edge', 'p-up'])
  })

  it('honours an explicit entity vertical half-extent', () => {
    const { port, state } = fakePort()
    const sensors = new Sensors({ body: port, now: () => 0, refreshMs: 1_000, entityVertical: 4 })
    state.entities = [
      { id: 'p-near', name: 'Alice', username: 'Alice', type: 'player', position: { x: 0.5, y: 68, z: 0.5 } },
      { id: 'p-far', name: 'Bob', username: 'Bob', type: 'player', position: { x: 0.5, y: 70, z: 0.5 } },
    ]
    const entities = sensors.read().entitiesIn({
      min: { x: -20, y: 50, z: -20 },
      max: { x: 20, y: 90, z: 20 },
    })
    expect(entities.map(entity => entity.id)).toEqual(['p-near'])
  })
})

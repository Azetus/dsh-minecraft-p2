import type { ClientPort, Face, Item, Vec3 } from '../../port/index.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle } from './handle.ts'

export const TRAVERSE_DRIVER_ID = 'traverse'

const TRAVERSE_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['bridge', 'scaffold'] },
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    item: { type: 'string' },
    maxBlocks: { type: 'integer', minimum: 1, maximum: 64 },
  },
  required: ['mode', 'x', 'y', 'z', 'item'],
  additionalProperties: false,
}

type TraverseParams = {
  mode: 'bridge' | 'scaffold'
  x: number
  y: number
  z: number
  item: string
  maxBlocks?: number
}

/**
 * Agent-authorized temporary traversal aid: a one-wide straight bridge or a
 * one-block-per-step staircase. It places one block at a time, reads it back,
 * then walks onto it. It never removes blocks and never runs by itself.
 */
export function createTraverseDriver(): Driver {
  return {
    id: TRAVERSE_DRIVER_ID,
    schema: TRAVERSE_SCHEMA,
    defaults: {
      budget: { maxTicks: 600, maxWallMs: 45_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as TraverseParams
      if (params.mode !== 'bridge' && params.mode !== 'scaffold') return { ok: false, code: 'BAD_ARGS' }
      if (![params.x, params.y, params.z].every(Number.isFinite)) return { ok: false, code: 'BAD_ARGS' }
      if (typeof params.item !== 'string' || params.item.length === 0) return { ok: false, code: 'BAD_ARGS' }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as TraverseParams
      return new AsyncDriverHandle(
        `traverse:${params.mode}:${params.x},${params.y},${params.z}`,
        traverse(ctx.port, params),
      )
    },
  }
}

async function traverse(port: ClientPort, params: TraverseParams): Promise<DriverResult> {
  const start = floor(port.self().pos)
  const target = { x: Math.floor(params.x), y: Math.floor(params.y), z: Math.floor(params.z) }
  const dx = target.x - start.x
  const dz = target.z - start.z
  const dy = target.y - start.y
  const maxBlocks = Math.min(64, Math.max(1, params.maxBlocks ?? 32))

  if (params.mode === 'bridge') {
    if (dy !== 0) return { state: 'failed', code: 'TRAVERSE_LEVEL_MISMATCH' }
    if (dx !== 0 && dz !== 0) return { state: 'failed', code: 'TRAVERSE_CARDINAL_ONLY' }
    const steps = Math.abs(dx) + Math.abs(dz)
    if (steps === 0) return { state: 'succeeded', observed: { kind: 'traverse', mode: params.mode, blocks: 0 } }
    if (steps > maxBlocks) return { state: 'failed', code: 'TRAVERSE_BLOCK_BUDGET' }
    const dir = { x: Math.sign(dx), z: Math.sign(dz) }
    for (let i = 1; i <= steps; i++) {
      const support = { x: start.x + dir.x * i, y: start.y - 1, z: start.z + dir.z * i }
      const stand = { x: support.x, y: start.y, z: support.z }
      const previous = { x: support.x - dir.x, y: support.y, z: support.z - dir.z }
      const placed = await placeBlock(port, support, previous, params.item)
      if (placed !== undefined) return placed
      const moved = await moveStand(port, stand)
      if (moved !== undefined) return moved
    }
    return {
      state: 'succeeded',
      observed: { kind: 'traverse', mode: params.mode, from: start, to: target, blocks: steps, temporary: true },
    }
  }

  if (dy === 0) return { state: 'succeeded', observed: { kind: 'traverse', mode: params.mode, blocks: 0, pillar: true } }
  if (dy < 0) return { state: 'failed', code: 'TRAVERSE_DOWN_UNSUPPORTED' }
  if (start.x !== target.x || start.z !== target.z) return { state: 'failed', code: 'TRAVERSE_PILLAR_VERTICAL' }
  if (dy > 8) return { state: 'failed', code: 'TRAVERSE_BLOCK_BUDGET' }
  if (count(port.inventory(), params.item) < dy) return { state: 'failed', code: 'NO_MATERIAL' }
  // Scaffold is a pillar: jump, place one held block in the feet cell, land on
  // it, repeat. The provider owns the jump/place timing; the driver only
  // validates the column and material count.
  const result = await port.pillarUp(params.item, dy)
  if (result.state !== 'ok') return { state: 'failed', code: result.code ?? 'TRAVERSE_PILLAR_FAILED' }
  return {
    state: 'succeeded',
    observed: {
      kind: 'traverse', mode: params.mode, from: start, to: target,
      blocks: dy, pillar: true, temporary: true,
      ...(result.observed === undefined ? {} : { result: result.observed }),
    },
  }
}

async function placeBlock(
  port: ClientPort,
  cell: Vec3,
  reference: Vec3,
  item: string,
): Promise<DriverResult | undefined> {
  const existing = port.blockAt(cell)
  if (existing === null || !existing.loaded) return { state: 'failed', code: 'OBSERVATION_UNAVAILABLE' }
  // Terrain can already provide the base/top block; only air needs a placement.
  // Water/lava and non-solid plants are not safe traversal material.
  if (isSolid(existing)) return undefined
  if (!isAir(existing.name)) return { state: 'failed', code: 'TRAVERSE_CELL_OCCUPIED' }
  const face = faceToward(reference, cell)
  if (face === undefined) return { state: 'failed', code: 'TRAVERSE_NO_SUPPORT' }
  if (count(port.inventory(), item) < 1) return { state: 'failed', code: 'NO_MATERIAL' }
  const placed = await port.place(cell, face, item)
  if (placed.state === 'unknown') return { state: 'failed', code: placed.code ?? 'CLIENT_TIMEOUT' }
  if (placed.state === 'failed') return { state: 'failed', code: placed.code ?? 'TRAVERSE_PLACE_FAILED' }
  const readback = port.blockAt(cell)
  if (readback === null || !readback.loaded || readback.name !== item) {
    return { state: 'failed', code: 'TRAVERSE_READBACK_MISMATCH' }
  }
  return undefined
}

function isSolid(block: { name: string; solid?: boolean }): boolean {
  if (block.solid === true) return true
  return block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air'
    && block.name !== 'water' && block.name !== 'lava'
}

async function moveStand(port: ClientPort, stand: Vec3): Promise<DriverResult | undefined> {
  const foot = port.blockAt(stand)
  if (foot === null || !foot.loaded) return { state: 'failed', code: 'OBSERVATION_UNAVAILABLE' }
  if (!isAir(foot.name)) return { state: 'failed', code: 'TRAVERSE_STAND_OCCUPIED' }
  const moved = await port.moveTo(stand, { range: 0, exact: true, timeoutMs: 10_000 })
  if (moved.state !== 'ok') return { state: 'failed', code: moved.code ?? 'TRAVERSE_MOVE_FAILED' }
  return undefined
}

function faceToward(reference: Vec3, target: Vec3): Face | undefined {
  if (reference.x < target.x) return 'east'
  if (reference.x > target.x) return 'west'
  if (reference.z < target.z) return 'south'
  if (reference.z > target.z) return 'north'
  if (reference.y < target.y) return 'up'
  if (reference.y > target.y) return 'down'
  return undefined
}

function count(items: Item[], name: string): number {
  return items.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0)
}

function floor(p: Vec3): Vec3 {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

function isAir(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

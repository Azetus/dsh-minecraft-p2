import type { ClientPort, Item, Vec3 } from '../../port/index.ts'
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
  const material = count(port.inventory(), params.item)

  if (params.mode === 'bridge') {
    if (dy !== 0) return { state: 'failed', code: 'TRAVERSE_LEVEL_MISMATCH' }
    if (dx !== 0 && dz !== 0) return { state: 'failed', code: 'TRAVERSE_CARDINAL_ONLY' }
    const steps = Math.abs(dx) + Math.abs(dz)
    if (steps === 0) return { state: 'succeeded', observed: { kind: 'traverse', mode: params.mode, blocks: 0 } }
    if (steps > maxBlocks) return { state: 'failed', code: 'TRAVERSE_BLOCK_BUDGET' }
    if (material < 1) return { state: 'failed', code: 'NO_MATERIAL' }
    return moveWithPlacement(port, params, start, target, steps, false)
  }

  if (dy === 0) return { state: 'succeeded', observed: { kind: 'traverse', mode: params.mode, blocks: 0, pillar: true } }
  if (dy < 0) return { state: 'failed', code: 'TRAVERSE_DOWN_UNSUPPORTED' }
  if (start.x !== target.x || start.z !== target.z) return { state: 'failed', code: 'TRAVERSE_PILLAR_VERTICAL' }
  if (dy > 8) return { state: 'failed', code: 'TRAVERSE_BLOCK_BUDGET' }
  if (material < dy) return { state: 'failed', code: 'NO_MATERIAL' }
  return moveWithPlacement(port, params, start, target, dy, true)
}

async function moveWithPlacement(
  port: ClientPort,
  params: TraverseParams,
  start: Vec3,
  target: Vec3,
  blocks: number,
  pillar: boolean,
): Promise<DriverResult> {
  const moved = await port.moveTo(target, {
    range: 0,
    exact: true,
    timeoutMs: 60_000,
    motion: true,
    allowPlace: true,
    material: params.item,
  })
  if (moved.state !== 'ok') {
    return {
      state: 'failed',
      code: moved.code ?? 'TRAVERSE_MOVE_FAILED',
      ...(moved.observed === undefined ? {} : { observed: moved.observed }),
    }
  }
  return {
    state: 'succeeded',
    observed: {
      kind: 'traverse',
      mode: params.mode,
      from: start,
      to: target,
      blocks,
      temporary: true,
      ...(pillar ? { pillar: true } : {}),
      ...(moved.observed === undefined ? {} : { result: moved.observed }),
    },
  }
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

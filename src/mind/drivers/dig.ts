import type { BlockInfo } from '../../port/index.ts'
import type { JsonValue } from '../../contracts/types.ts'
import { PLAYER_HEIGHT } from '../../motion/model/index.ts'
import { approachBlock } from '../approach.ts'
import { pickupNearby } from '../pickup.ts'
import type { SchemaNode } from '../schema.ts'
import { chooseTool } from '../tools.ts'
import type { DigPurpose } from '../tools.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle, actFailure, sleep } from './handle.ts'

export const DIG_DRIVER_ID = 'dig'

const DIG_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    purpose: { type: 'string', enum: ['clear', 'harvest'] },
    shape: { type: 'string', enum: ['box', 'line'] },
    from: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
      required: ['x', 'y', 'z'],
      additionalProperties: false,
    },
    to: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
      required: ['x', 'y', 'z'],
      additionalProperties: false,
    },
    only: { type: 'array', items: { type: 'string' } },
    height: { type: 'integer', minimum: 1, maximum: 8 },
    preserveFloor: { type: 'boolean' },
    maxBlocks: { type: 'integer', minimum: 1, maximum: 64 },
  },
  additionalProperties: false,
}

type DigCell = { x: number; y: number; z: number }

type DigParams = {
  x?: number
  y?: number
  z?: number
  purpose?: DigPurpose
  shape?: 'box' | 'line'
  from?: DigCell
  to?: DigCell
  only?: string[]
  height?: number
  preserveFloor?: boolean
  maxBlocks?: number
}

const DEFAULT_MAX_BLOCKS = 24
const HARD_MAX_BLOCKS = 64

/**
 * One Agent-selected block, or a bounded volume (`shape: "box" | "line"`).
 * Target selection stays outside the driver; a volume is still one order and
 * one write token, with per-cell failures reported as `observed.partial`.
 */
export function createDigDriver(): Driver {
  return {
    id: DIG_DRIVER_ID,
    schema: DIG_SCHEMA,
    defaults: {
      // A volume is many single digs; the per-cell action caps still bound it.
      budget: { maxTicks: 2_400, maxWallMs: 120_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as DigParams
      if (params.purpose !== undefined && params.purpose !== 'clear' && params.purpose !== 'harvest') {
        return { ok: false, code: 'BAD_ARGS' }
      }
      if (params.shape !== undefined) {
        if (params.shape !== 'box' && params.shape !== 'line') return { ok: false, code: 'BAD_ARGS' }
        if (!isCell(params.from) || !isCell(params.to)) return { ok: false, code: 'BAD_ARGS' }
        if (params.shape === 'line') {
          const differing = (['x', 'y', 'z'] as const).filter(axis => params.from![axis] !== params.to![axis])
          if (differing.length !== 1) return { ok: false, code: 'BAD_ARGS' }
        }
        if (params.maxBlocks !== undefined
          && (!Number.isInteger(params.maxBlocks) || params.maxBlocks < 1 || params.maxBlocks > HARD_MAX_BLOCKS)) {
          return { ok: false, code: 'BAD_ARGS' }
        }
        return { ok: true }
      }
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as DigParams
      const key = params.shape === undefined
        ? `dig:${params.x},${params.y},${params.z}:${params.purpose ?? 'harvest'}`
        : `dig.volume:${params.shape}:${params.from?.x},${params.from?.y},${params.from?.z}:${params.to?.x},${params.to?.y},${params.to?.z}:${params.purpose ?? 'harvest'}`
      return new AsyncDriverHandle(key, params.shape === undefined
        ? digOne(ctx, { x: params.x as number, y: params.y as number, z: params.z as number }, params.purpose ?? 'harvest')
        : digVolume(ctx, params))
    },
  }
}

async function digOne(ctx: DriverCtx, target: DigCell, purpose: DigPurpose): Promise<DriverResult> {
  const before = ctx.port.blockAt(target)
  if (before === null || !before.loaded) return { state: 'failed', code: 'OBSERVATION_UNAVAILABLE' }
  if (isAirName(before.name)) {
    return purpose === 'clear'
      ? { state: 'succeeded', observed: { kind: 'dig', purpose, ...target, alreadyAir: true } }
      : { state: 'failed', code: 'DIG_NO_BLOCK' }
  }

  const inventoryBefore = ctx.port.inventory()
  const beforeCount = totalCount(inventoryBefore)
  const choice = chooseTool(before, inventoryBefore, purpose)
  if (choice.error !== undefined) return { state: 'failed', code: choice.error }
  const approach = await approachBlock(ctx.port, target, {
    range: 2,
    timeoutMs: 12_000,
    code: 'DIG_APPROACH_FAILED',
  })
  if (!approach.ok) {
    return {
      state: 'failed',
      code: approach.code,
      ...(approach.observed === undefined ? {} : { observed: approach.observed }),
    }
  }
  if (choice.item !== undefined) {
    const equipped = await ctx.port.equip(choice.item)
    if (equipped.state !== 'ok') return actFailure(equipped, 'EQUIP_FAILED')
  }

  const result = await ctx.port.dig(target)
  if (result.state !== 'ok') return actFailure(result, 'DIG_FAILED')

  const first = ctx.port.blockAt(target)
  await sleep(200)
  const second = ctx.port.blockAt(target)
  if (!isAirBlock(first) || !isAirBlock(second)) {
    return { state: 'failed', code: 'DIG_READBACK_UNSTABLE' }
  }

  const pickup = purpose === 'harvest'
    ? await pickupNearby(ctx.port, target, { delayTicks: 12 })
    : undefined
  await sleep(300)
  const inventoryAfter = ctx.port.inventory()
  const afterCount = totalCount(inventoryAfter)
  const observed = {
    kind: 'dig',
    purpose,
    ...target,
    block: before.name,
    tool: choice.item ?? null,
    inventoryBefore: beforeCount,
    inventoryAfter: afterCount,
    dropDelta: afterCount - beforeCount,
    ...(pickup === undefined ? {} : { pickup: pickup.observed }),
  }
  if (pickup !== undefined && pickup.drops > 0 && pickup.picked === 0 && afterCount <= beforeCount) {
    const code = pickup.merged > 0
      ? 'PICKUP_MERGED'
      : pickup.gone > 0
        ? 'PICKUP_ENTITY_GONE'
        : pickup.full > 0
          ? 'PICKUP_INVENTORY_FULL'
          : pickup.unreachable > 0 ? 'PICKUP_UNREACHABLE' : 'PICKUP_NOT_COLLECTED'
    return { state: 'failed', code, observed }
  }
  return { state: 'succeeded', observed }
}

/**
 * Bounded volume dig. Each cell is approached and verified on its own; cells
 * that fail are reported in `skipped` instead of aborting the whole order.
 * `preserveFloor` (default true) never removes the support under the body or
 * the body's own feet/head cells.
 */
async function digVolume(ctx: DriverCtx, params: DigParams): Promise<DriverResult> {
  const purpose = params.purpose ?? 'harvest'
  const expansion = volumeCells(params)
  if ('error' in expansion) return { state: 'failed', code: 'BAD_ARGS', observed: { detail: expansion.error } }
  const cells = expansion.cells
  const maxBlocks = Math.min(HARD_MAX_BLOCKS, params.maxBlocks ?? DEFAULT_MAX_BLOCKS)
  if (cells.length > maxBlocks) {
    return {
      state: 'failed',
      code: 'DIG_VOLUME_TOO_LARGE',
      observed: { planned: cells.length, maxBlocks },
    }
  }

  const inventoryBefore = totalCount(ctx.port.inventory())
  const only = params.only
  const preserveFloor = params.preserveFloor !== false
  const skipped: Array<DigCell & { reason: string; code?: string }> = []
  let dug = 0
  let alreadyAir = 0

  for (const cell of cells) {
    const before = ctx.port.blockAt(cell)
    if (before === null || !before.loaded) {
      skipped.push({ ...cell, reason: 'unloaded' })
      continue
    }
    if (isAirName(before.name)) {
      alreadyAir += 1
      continue
    }
    if (only !== undefined && !only.includes(before.name)) {
      skipped.push({ ...cell, reason: 'filtered', code: before.name })
      continue
    }
    if (preserveFloor && selfCovers(ctx.port.self().pos, cell)) {
      skipped.push({ ...cell, reason: 'preserve-floor' })
      continue
    }
    const choice = chooseTool(before, ctx.port.inventory(), purpose)
    if (choice.error !== undefined) {
      skipped.push({ ...cell, reason: 'tool', code: choice.error })
      continue
    }
    const approach = await approachBlock(ctx.port, cell, {
      range: 2,
      timeoutMs: 12_000,
      code: 'DIG_APPROACH_FAILED',
    })
    if (!approach.ok) {
      skipped.push({ ...cell, reason: 'unreachable', code: approach.code })
      continue
    }
    if (choice.item !== undefined) {
      const equipped = await ctx.port.equip(choice.item)
      if (equipped.state !== 'ok') {
        skipped.push({ ...cell, reason: 'equip', code: equipped.code ?? 'EQUIP_FAILED' })
        continue
      }
    }
    const result = await ctx.port.dig(cell)
    if (result.state !== 'ok') {
      skipped.push({ ...cell, reason: 'dig', code: result.code ?? 'DIG_FAILED' })
      continue
    }
    const first = ctx.port.blockAt(cell)
    await sleep(120)
    const second = ctx.port.blockAt(cell)
    if (!isAirBlock(first) || !isAirBlock(second)) {
      skipped.push({ ...cell, reason: 'readback', code: 'DIG_READBACK_UNSTABLE' })
      continue
    }
    dug += 1
  }

  const bounds = cellBounds(cells)
  const center = {
    x: Math.floor((bounds.min.x + bounds.max.x) / 2),
    y: Math.floor((bounds.min.y + bounds.max.y) / 2),
    z: Math.floor((bounds.min.z + bounds.max.z) / 2),
  }
  const pickup = purpose === 'harvest' && dug > 0
    ? await pickupNearby(ctx.port, center, { delayTicks: 8 })
    : undefined
  const inventoryAfter = totalCount(ctx.port.inventory())
  const stoppedAt = cells.at(-1) ?? null
  const observed: Record<string, JsonValue> = {
    kind: 'dig.volume',
    shape: params.shape ?? null,
    from: params.from ?? null,
    to: params.to ?? null,
    height: params.height ?? 1,
    purpose,
    planned: cells.length,
    dug,
    alreadyAir,
    skipped,
    stoppedAt,
    inventoryBefore,
    inventoryAfter,
    dropDelta: inventoryAfter - inventoryBefore,
    ...(pickup === undefined ? {} : { pickup: pickup.observed }),
  }
  if (skipped.length > 0) {
    return {
      state: 'failed',
      code: 'DIG_PARTIAL',
      observed: {
        ...observed,
        partial: { dug, skipped: skipped.length, stoppedAt },
      },
    }
  }
  return { state: 'succeeded', observed }
}

function volumeCells(params: DigParams): { cells: DigCell[] } | { error: string } {
  const from = params.from
  const to = params.to
  if (from === undefined || to === undefined) return { error: 'from/to required' }
  const height = params.height ?? 1
  const cells: DigCell[] = []
  if (params.shape === 'line') {
    const axes = (['x', 'y', 'z'] as const).filter(axis => from[axis] !== to[axis])
    if (axes.length !== 1) return { error: 'line requires exactly one differing axis' }
    const axis = axes[0]!
    const step = Math.sign(to[axis] - from[axis])
    for (let value = from[axis]; value !== to[axis] + step; value += step) {
      cells.push({ ...from, [axis]: value })
    }
    return { cells }
  }
  const minX = Math.min(from.x, to.x)
  const maxX = Math.max(from.x, to.x)
  const minZ = Math.min(from.z, to.z)
  const maxZ = Math.max(from.z, to.z)
  const minY = Math.min(from.y, to.y)
  const maxY = Math.max(from.y, to.y) + Math.max(0, height - 1)
  for (let x = minX; x <= maxX; x += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let y = minY; y <= maxY; y += 1) cells.push({ x, y, z })
    }
  }
  return { cells }
}

function cellBounds(cells: readonly DigCell[]): { min: DigCell; max: DigCell } {
  const min = { x: cells[0]!.x, y: cells[0]!.y, z: cells[0]!.z }
  const max = { ...min }
  for (const cell of cells) {
    min.x = Math.min(min.x, cell.x)
    min.y = Math.min(min.y, cell.y)
    min.z = Math.min(min.z, cell.z)
    max.x = Math.max(max.x, cell.x)
    max.y = Math.max(max.y, cell.y)
    max.z = Math.max(max.z, cell.z)
  }
  return { min, max }
}

/** Body cells plus the support cell directly under the feet. */
function selfCovers(pos: { x: number; y: number; z: number }, cell: DigCell): boolean {
  if (Math.floor(pos.x) !== cell.x || Math.floor(pos.z) !== cell.z) return false
  const feet = Math.floor(pos.y + 0.001)
  const head = Math.floor(pos.y + PLAYER_HEIGHT - 0.001)
  return cell.y === feet - 1 || (cell.y >= feet && cell.y <= head)
}

function isCell(value: unknown): value is DigCell {
  if (typeof value !== 'object' || value === null) return false
  const cell = value as { x?: unknown; y?: unknown; z?: unknown }
  return Number.isInteger(cell.x) && Number.isInteger(cell.y) && Number.isInteger(cell.z)
}

function totalCount(items: Array<{ count: number }>): number {
  return items.reduce((sum, item) => sum + item.count, 0)
}

function isAirName(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

function isAirBlock(block: BlockInfo | null): boolean {
  return block !== null && block.loaded && isAirName(block.name)
}

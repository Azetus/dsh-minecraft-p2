import type { BlockInfo } from '../../port/index.ts'
import type { JsonValue } from '../../contracts/types.ts'
import { PLAYER_HEIGHT } from '../../motion/model/index.ts'
import { approachBlock } from '../approach.ts'
import { pickupNearby } from '../pickup.ts'
import type { SchemaNode } from '../schema.ts'
import { chooseTool } from '../tools.ts'
import type { DigPurpose } from '../tools.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { failureBody, readFailure, withFailure } from '../failure.ts'
import { AsyncDriverHandle, actFailure, sleep } from './handle.ts'

export const DIG_DRIVER_ID = 'dig'

const DIG_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    purpose: { type: 'string', enum: ['clear', 'harvest'] },
    shape: { type: 'string', enum: ['box', 'line', 'tunnel'] },
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
  shape?: 'box' | 'line' | 'tunnel'
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
      if (params.shape === 'tunnel') {
        if (!isCell(params.to)) return { ok: false, code: 'BAD_ARGS' }
        if (params.height !== undefined
          && (!Number.isInteger(params.height) || params.height < 1 || params.height > 3)) {
          return { ok: false, code: 'BAD_ARGS' }
        }
        if (params.maxBlocks !== undefined
          && (!Number.isInteger(params.maxBlocks) || params.maxBlocks < 1 || params.maxBlocks > HARD_MAX_BLOCKS)) {
          return { ok: false, code: 'BAD_ARGS' }
        }
        return { ok: true }
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
        : params.shape === 'tunnel'
          ? `dig.tunnel:${params.to?.x},${params.to?.y},${params.to?.z}:${params.purpose ?? 'harvest'}`
          : `dig.volume:${params.shape}:${params.from?.x},${params.from?.y},${params.from?.z}:${params.to?.x},${params.to?.y},${params.to?.z}:${params.purpose ?? 'harvest'}`
      return new AsyncDriverHandle(key, (params.shape === undefined
        ? digOne(ctx, { x: params.x as number, y: params.y as number, z: params.z as number }, params.purpose ?? 'harvest')
        : params.shape === 'tunnel'
          ? digTunnel(ctx, params)
          : digVolume(ctx, params)).then(result => attachDigFailure(result, params)))
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

type TunnelPlan = {
  start: DigCell
  end: DigCell
  axis: 'x' | 'z'
  direction: DigCell
  height: number
  preserveFloor: boolean
  path: DigCell[]
  cells: DigCell[]
  maxBlocks: number
}

/**
 * A tunnel is one horizontal cardinal corridor with at most one y-step at the
 * far end. The start is the current standing cell; `to` is the final feet cell.
 * Cells are ordered from the current body outward, so the return path is the
 * same list in reverse.
 */
async function digTunnel(ctx: DriverCtx, params: DigParams): Promise<DriverResult> {
  const planned = planTunnel(ctx.port, params)
  if ('error' in planned) {
    return { state: 'failed', code: planned.code, observed: planned.observed }
  }
  const plan = planned.plan
  const purpose = params.purpose ?? 'harvest'
  const inventoryBefore = totalCount(ctx.port.inventory())
  let dug = 0
  let alreadyAir = 0
  let stoppedAt: DigCell | null = null
  let reason: string | undefined
  let causeCode: string | undefined
  let equipped: string | undefined

  outer: for (let index = 1; index < plan.path.length; index += 1) {
    const cell = plan.path[index]!
    for (let layer = 0; layer < plan.height; layer += 1) {
      const block = { x: cell.x, y: cell.y + layer, z: cell.z }
      const check = inspectTunnelBlock(ctx.port, block, plan.direction, plan.preserveFloor)
      if (check.stop === true) {
        stoppedAt = block
        reason = check.reason
        causeCode = check.code
        break outer
      }
      if (check.air === true) {
        alreadyAir += 1
        continue
      }
      const choice = chooseTool(check.block!, ctx.port.inventory(), purpose)
      if (choice.error !== undefined) {
        stoppedAt = block
        reason = choice.error === 'BLOCK_UNBREAKABLE' ? 'unbreakable' : 'tool'
        causeCode = choice.error
        break outer
      }
      if (choice.item !== undefined && choice.item !== equipped) {
        const result = await ctx.port.equip(choice.item)
        if (result.state !== 'ok') {
          stoppedAt = block
          reason = 'equip'
          causeCode = result.code ?? 'EQUIP_FAILED'
          break outer
        }
        equipped = choice.item
      }
      const result = await ctx.port.dig(block)
      if (result.state !== 'ok') {
        stoppedAt = block
        reason = 'dig'
        causeCode = result.code ?? 'DIG_FAILED'
        break outer
      }
      const first = ctx.port.blockAt(block)
      await sleep(120)
      const second = ctx.port.blockAt(block)
      if (!isAirBlock(first) || !isAirBlock(second)) {
        stoppedAt = block
        reason = 'readback'
        causeCode = 'DIG_READBACK_UNSTABLE'
        break outer
      }
      dug += 1
    }
    const moved = await ctx.port.moveTo(cell, { range: 0, timeoutMs: 15_000 })
    if (moved.state !== 'ok') {
      stoppedAt = cell
      reason = 'move'
      causeCode = moved.code ?? 'DIG_TUNNEL_MOVE_FAILED'
      break
    }
  }

  const returnable = reason === undefined && tunnelReturnable(ctx.port, plan.path, plan.height)
  const pickup = purpose === 'harvest' && dug > 0
    ? await pickupNearby(ctx.port, tunnelCenter(plan.path), { delayTicks: 8 })
    : undefined
  const inventoryAfter = totalCount(ctx.port.inventory())
  const observed: Record<string, JsonValue> = {
    kind: 'dig.tunnel',
    shape: 'tunnel',
    from: plan.start,
    to: plan.end,
    height: plan.height,
    preserveFloor: plan.preserveFloor,
    purpose,
    planned: plan.cells.length,
    dug,
    alreadyAir,
    path: plan.path as unknown as JsonValue,
    returnable,
    stoppedAt,
    inventoryBefore,
    inventoryAfter,
    dropDelta: inventoryAfter - inventoryBefore,
    ...(pickup === undefined ? {} : { pickup: pickup.observed }),
  }
  if (reason !== undefined) {
    return {
      state: 'failed',
      code: 'DIG_PARTIAL',
      observed: {
        ...observed,
        reason,
        ...(causeCode === undefined ? {} : { causeCode }),
        partial: {
          dug,
          planned: plan.cells.length,
          stoppedAt,
          reason,
          ...(causeCode === undefined ? {} : { causeCode }),
        },
      },
    }
  }
  return { state: 'succeeded', observed }
}

function planTunnel(
  port: DriverCtx['port'],
  params: DigParams,
): { plan: TunnelPlan } | { error: true; code: string; observed: JsonValue } {
  const to = params.to
  if (!isCell(to)) return { error: true, code: 'BAD_ARGS', observed: { detail: 'tunnel requires integer to' } }
  const self = port.self().pos
  const start = { x: Math.floor(self.x), y: Math.floor(self.y), z: Math.floor(self.z) }
  const dx = to.x - start.x
  const dz = to.z - start.z
  const dy = to.y - start.y
  if ((dx === 0 && dz === 0) || (dx !== 0 && dz !== 0)) {
    return {
      error: true,
      code: 'BAD_ARGS',
      observed: { detail: 'tunnel requires exactly one horizontal direction', from: start, to },
    }
  }
  if (Math.abs(dy) > 1) {
    return {
      error: true,
      code: 'BAD_ARGS',
      observed: { detail: 'tunnel allows at most one y-step', from: start, to },
    }
  }
  const axis = dx === 0 ? 'z' : 'x'
  const step = Math.sign(axis === 'x' ? dx : dz)
  const length = Math.abs(dx) + Math.abs(dz)
  const height = params.height ?? 2
  const maxBlocks = Math.min(HARD_MAX_BLOCKS, params.maxBlocks ?? DEFAULT_MAX_BLOCKS)
  const path: DigCell[] = [start]
  for (let index = 1; index <= length; index += 1) {
    path.push({
      x: start.x + (axis === 'x' ? step * index : 0),
      y: index === length ? to.y : start.y,
      z: start.z + (axis === 'z' ? step * index : 0),
    })
  }
  const cells: DigCell[] = []
  for (const cell of path.slice(1)) {
    for (let layer = 0; layer < height; layer += 1) {
      cells.push({ x: cell.x, y: cell.y + layer, z: cell.z })
    }
  }
  if (cells.length > maxBlocks) {
    return {
      error: true,
      code: 'DIG_VOLUME_TOO_LARGE',
      observed: { planned: cells.length, maxBlocks, kind: 'dig.tunnel' },
    }
  }
  return {
    plan: {
      start,
      end: to,
      axis,
      direction: axis === 'x' ? { x: step, y: 0, z: 0 } : { x: 0, y: 0, z: step },
      height,
      preserveFloor: params.preserveFloor !== false,
      path,
      cells,
      maxBlocks,
    },
  }
}

function inspectTunnelBlock(
  port: DriverCtx['port'],
  block: DigCell,
  direction: DigCell,
  preserveFloor: boolean,
): { stop: true; reason: string; code?: string } | { stop?: false; air: true } | { stop?: false; air?: false; block: BlockInfo } {
  const before = port.blockAt(block)
  if (before === null || !before.loaded) return { stop: true, reason: 'unloaded' }
  if (isFluidName(before.name)) return { stop: true, reason: 'fluid', code: before.name }
  if (preserveFloor && selfCovers(port.self().pos, block)) return { stop: true, reason: 'preserve-floor' }
  const behind = port.blockAt({
    x: block.x - direction.x,
    y: block.y,
    z: block.z - direction.z,
  })
  if (behind === null || !behind.loaded) return { stop: true, reason: 'unloaded' }
  if (isFluidName(behind.name)) return { stop: true, reason: 'fluid', code: behind.name }
  if (isAirName(before.name)) return { air: true }
  if (before.diggable === false) return { stop: true, reason: 'unbreakable', code: 'BLOCK_UNBREAKABLE' }
  return { block: before }
}

function tunnelReturnable(
  port: DriverCtx['port'],
  path: readonly DigCell[],
  height: number,
): boolean {
  if (height < 2) return false
  for (const cell of path) {
    const feet = port.blockAt(cell)
    const head = port.blockAt({ x: cell.x, y: cell.y + 1, z: cell.z })
    const support = port.blockAt({ x: cell.x, y: cell.y - 1, z: cell.z })
    if (feet === null || head === null || support === null) return false
    if (!feet.loaded || !head.loaded || !support.loaded) return false
    if (!isAirName(feet.name) || !isAirName(head.name)) return false
    if (isFluidName(feet.name) || isFluidName(head.name) || isFluidName(support.name)) return false
    if (isAirName(support.name)) return false
  }
  return true
}

function tunnelCenter(path: readonly DigCell[]): DigCell {
  const first = path[0]!
  const last = path.at(-1)!
  return {
    x: Math.floor((first.x + last.x) / 2),
    y: Math.floor((first.y + last.y) / 2),
    z: Math.floor((first.z + last.z) / 2),
  }
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

function isFluidName(name: string): boolean {
  return name === 'water' || name === 'lava' || name === 'bubble_column'
}

function isAirBlock(block: BlockInfo | null): boolean {
  return block !== null && block.loaded && isAirName(block.name)
}

/** Add the unified failure projection to every dig failure path. */
function attachDigFailure(result: DriverResult, params: DigParams): DriverResult {
  if (result.state !== 'failed' || readFailure(result.observed) !== undefined) return result
  const code = result.code ?? 'DIG_FAILED'
  const phase = code.startsWith('PICKUP_')
    ? 'pickup'
    : code === 'DIG_READBACK_UNSTABLE' ? 'readback' : 'execute'
  const facts: Record<string, JsonValue> = {}
  const single = { x: params.x, y: params.y, z: params.z }
  if (params.shape === undefined && isCell(single)) {
    facts.target = { x: single.x, y: single.y, z: single.z }
  } else if (params.shape === 'tunnel' && isCell(params.to)) {
    facts.target = { to: params.to } as unknown as JsonValue
  } else if (isCell(params.from) && isCell(params.to)) {
    facts.target = { from: params.from, to: params.to } as unknown as JsonValue
  }
  return {
    ...result,
    observed: withFailure(result.observed, failureBody({
      layer: 'driver',
      phase,
      code,
      observed: result.observed,
      facts,
      cause: {
        kind: code === 'DIG_VOLUME_TOO_LARGE' ? 'definition' : 'world',
        code,
      },
      recovery: code === 'DIG_PARTIAL' || code === 'DIG_VOLUME_TOO_LARGE' ? 'none' : 'replan',
    })),
  }
}

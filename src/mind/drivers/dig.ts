import type { BlockInfo } from '../../port/index.ts'
import { approachBlock } from '../approach.ts'
import { pickupNearby } from '../pickup.ts'
import type { SchemaNode } from '../schema.ts'
import { chooseTool } from '../tools.ts'
import type { DigPurpose } from '../tools.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle, sleep } from './handle.ts'

export const DIG_DRIVER_ID = 'dig'

const DIG_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    purpose: { type: 'string', enum: ['clear', 'harvest'] },
  },
  required: ['x', 'y', 'z'],
  additionalProperties: false,
}

type DigParams = { x: number; y: number; z: number; purpose?: DigPurpose }

/**
 * One Agent-selected block dig. Target selection stays outside the driver;
 * this driver chooses the held tool for that target and verifies the result.
 */
export function createDigDriver(): Driver {
  return {
    id: DIG_DRIVER_ID,
    schema: DIG_SCHEMA,
    defaults: {
      budget: { maxTicks: 600, maxWallMs: 30_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as DigParams
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      if (params.purpose !== undefined && params.purpose !== 'clear' && params.purpose !== 'harvest') {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as DigParams
      return new AsyncDriverHandle(
        `dig:${params.x},${params.y},${params.z}:${params.purpose ?? 'harvest'}`,
        dig(ctx, params),
      )
    },
  }
}

async function dig(ctx: DriverCtx, params: DigParams): Promise<DriverResult> {
  const purpose = params.purpose ?? 'harvest'
  const target = { x: params.x, y: params.y, z: params.z }
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
    if (equipped.state !== 'ok') {
      return { state: 'failed', code: equipped.code ?? 'EQUIP_FAILED' }
    }
  }

  const result = await ctx.port.dig(target)
  if (result.state === 'failed') return { state: 'failed', code: result.code ?? 'DIG_FAILED' }
  if (result.state === 'unknown') return { state: 'failed', code: result.code ?? 'CLIENT_TIMEOUT' }

  const first = ctx.port.blockAt(target)
  await sleep(200)
  const second = ctx.port.blockAt(target)
  if (!isAirBlock(first) || !isAirBlock(second)) {
    return { state: 'failed', code: 'DIG_READBACK_UNSTABLE' }
  }

  const pickup = purpose === 'harvest' ? await pickupNearby(ctx.port, target) : undefined
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
    return {
      state: 'failed',
      code: pickup.unreachable > 0 ? 'PICKUP_UNREACHABLE' : 'PICKUP_NOT_COLLECTED',
      observed,
    }
  }
  return { state: 'succeeded', observed }
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

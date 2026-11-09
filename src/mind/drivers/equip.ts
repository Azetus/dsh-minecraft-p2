import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle } from './handle.ts'

export const EQUIP_DRIVER_ID = 'equip'

const EQUIP_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    item: { type: 'string' },
    destination: { type: 'string', enum: ['hand', 'offhand'] },
    unequip: { type: 'boolean' },
  },
  additionalProperties: false,
}

type EquipParams = {
  item?: string
  destination?: 'hand' | 'offhand'
  /** Explicit Agent order: clear the destination slot instead of equipping. */
  unequip?: boolean
}

/** Select one inventory item as the held/off-hand item, or clear that slot. */
export function createEquipDriver(): Driver {
  return {
    id: EQUIP_DRIVER_ID,
    schema: EQUIP_SCHEMA,
    defaults: {
      budget: { maxTicks: 100, maxWallMs: 5_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as EquipParams
      const destination = params.destination ?? 'hand'
      if (destination !== 'hand' && destination !== 'offhand') return { ok: false, code: 'BAD_ARGS' }
      if (params.unequip === true) {
        return params.item === undefined ? { ok: true } : { ok: false, code: 'BAD_ARGS' }
      }
      if (typeof params.item !== 'string' || params.item.length === 0) return { ok: false, code: 'BAD_ARGS' }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as EquipParams
      const destination = params.destination ?? 'hand'
      const key = params.unequip === true
        ? `equip:unequip:${destination}`
        : `equip:${destination}:${params.item ?? ''}`
      return new AsyncDriverHandle(key, equip(ctx, params))
    },
  }
}

async function equip(ctx: DriverCtx, params: EquipParams): Promise<DriverResult> {
  const destination = params.destination ?? 'hand'
  if (params.unequip === true) return await unequip(ctx, destination)

  const item = params.item
  if (item === undefined || item.length === 0) return { state: 'failed', code: 'BAD_ARGS' }
  const available = ctx.body.inventory().some(entry => entry.name === item)
  if (!available) return { state: 'failed', code: 'EQUIP_ITEM_MISSING' }

  const result = await ctx.body.equip(item, destination)
  if (result.state !== 'ok') {
    return {
      state: 'failed',
      code: result.code ?? 'EQUIP_FAILED',
      ...(result.observed === undefined ? {} : { observed: result.observed }),
    }
  }
  const observed = isRecord(result.observed) ? result.observed : undefined
  const equipped = typeof observed?.equipped === 'string' ? observed.equipped : undefined
  const held = typeof observed?.held === 'string' ? observed.held : undefined
  const actual = destination === 'offhand' ? equipped : equipped ?? held
  if (actual === undefined) {
    return {
      state: 'failed',
      code: 'EQUIP_READBACK_UNKNOWN',
      observed: observed ?? { kind: 'equip', item, destination },
    }
  }
  if (actual !== item) {
    return {
      state: 'failed',
      code: 'EQUIP_READBACK_MISMATCH',
      observed: observed ?? { kind: 'equip', item, destination },
    }
  }
  return {
    state: 'succeeded',
    observed: {
      kind: 'equip',
      item,
      destination,
      equipped: actual,
      ...(destination === 'hand' ? { held: actual } : {}),
    },
  }
}

async function unequip(ctx: DriverCtx, destination: 'hand' | 'offhand'): Promise<DriverResult> {
  if (ctx.body.unequip === undefined) return { state: 'failed', code: 'UNEQUIP_FAILED' }
  const result = await ctx.body.unequip(destination)
  if (result.state !== 'ok') {
    return {
      state: 'failed',
      code: result.code ?? 'UNEQUIP_FAILED',
      ...(result.observed === undefined ? {} : { observed: result.observed }),
    }
  }
  const observed = isRecord(result.observed) ? result.observed : undefined
  if (!isRecord(observed) || !('equipped' in observed)) {
    return {
      state: 'failed',
      code: 'UNEQUIP_READBACK_UNKNOWN',
      observed: observed ?? { kind: 'unequip', destination },
    }
  }
  if (observed.equipped !== null && observed.equipped !== undefined) {
    return {
      state: 'failed',
      code: 'UNEQUIP_READBACK_MISMATCH',
      observed,
    }
  }
  return {
    state: 'succeeded',
    observed: {
      kind: 'unequip',
      destination,
      item: typeof observed.item === 'string' ? observed.item : null,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

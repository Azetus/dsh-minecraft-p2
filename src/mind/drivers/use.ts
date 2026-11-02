import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle } from './handle.ts'

export const USE_DRIVER_ID = 'use'

const USE_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    item: { type: 'string' },
    durationMs: { type: 'number' },
  },
  additionalProperties: false,
}

type UseParams = { x?: number; y?: number; z?: number; item?: string; durationMs?: number }

/**
 * One use interaction. A bed target is slept in; another block target is
 * activated; with no target, the held (or requested) item is used.
 */
export function createUseDriver(): Driver {
  return {
    id: USE_DRIVER_ID,
    schema: USE_SCHEMA,
    defaults: {
      budget: { maxTicks: 2_000, maxWallMs: 120_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as UseParams
      const target = toTarget(params)
      if (target === undefined && (typeof params.item !== 'string' || params.item.length === 0)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as UseParams
      return new AsyncDriverHandle(`use:${params.item ?? 'target'}:${params.x ?? ''},${params.y ?? ''},${params.z ?? ''}`,
        use(ctx, params))
    },
  }
}

async function use(ctx: DriverCtx, params: UseParams): Promise<DriverResult> {
  const target = toTarget(params)
  if (target !== undefined) {
    const block = ctx.port.blockAt(target)
    const self = ctx.port.self().pos
    // A bot already on/next to a bed cannot path to the bed block itself;
    // sleeping is still valid from this position.
    const alreadyAtBed = block !== null && block.loaded && block.name.endsWith('_bed')
      && Math.hypot(self.x - (target.x + 0.5), self.y - (target.y + 0.5), self.z - (target.z + 0.5)) <= 3
    if (!alreadyAtBed) {
      const moved = await ctx.port.moveTo(target, { range: 3, intent: 'interact', timeoutMs: 20_000, motion: true })
      if (moved.state !== 'ok') return { state: 'failed', code: moved.code ?? 'USE_MOVE_FAILED' }
    }
    if (block !== null && block.loaded && block.name.endsWith('_bed')) {
      const slept = await ctx.port.sleep(target)
      if (slept.state !== 'ok') return { state: 'failed', code: slept.code ?? 'USE_SLEEP_FAILED' }
      return { state: 'succeeded', observed: { kind: 'sleep', bed: target } }
    }
    const activated = await ctx.port.useOn(target)
    if (activated.state !== 'ok') return { state: 'failed', code: activated.code ?? 'USE_ON_FAILED' }
    return { state: 'succeeded', observed: { kind: 'use-on', target } }
  }

  const item = params.item
  if (typeof item !== 'string' || item.length === 0) return { state: 'failed', code: 'BAD_ARGS' }
  const equipped = await ctx.port.equip(item)
  if (equipped.state !== 'ok') return { state: 'failed', code: equipped.code ?? 'USE_EQUIP_FAILED' }
  const used = await ctx.port.useItem({ durationMs: Math.max(1_000, params.durationMs ?? 1_800) })
  if (used.state !== 'ok') return { state: 'failed', code: used.code ?? 'USE_ITEM_FAILED' }
  return { state: 'succeeded', observed: { kind: 'use-item', item } }
}

function toTarget(params: UseParams): { x: number; y: number; z: number } | undefined {
  if (typeof params.x !== 'number' || typeof params.y !== 'number' || typeof params.z !== 'number') return undefined
  if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) return undefined
  return { x: Math.floor(params.x), y: Math.floor(params.y), z: Math.floor(params.z) }
}

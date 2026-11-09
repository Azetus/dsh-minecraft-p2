import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle, actFailure } from './handle.ts'

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
    const block = ctx.body.blockAt(target)
    const self = ctx.body.self().pos
    // A bot already on/next to a bed cannot path to the bed block itself;
    // sleeping is still valid from this position.
    const alreadyAtBed = block !== null && block.loaded && block.name.endsWith('_bed')
      && Math.hypot(self.x - (target.x + 0.5), self.y - (target.y + 0.5), self.z - (target.z + 0.5)) <= 3
    if (!alreadyAtBed) {
      const moved = await ctx.body.moveTo(target, { range: 3, intent: 'interact', timeoutMs: 20_000 })
      if (moved.state !== 'ok') return actFailure(moved, 'USE_MOVE_FAILED')
    }
    if (block !== null && block.loaded && block.name.endsWith('_bed')) {
      const slept = await ctx.body.sleep(target)
      if (slept.state !== 'ok') return actFailure(slept, 'USE_SLEEP_FAILED')
      return { state: 'succeeded', observed: { kind: 'sleep', bed: target } }
    }
    const activated = await ctx.body.useOn(target)
    if (activated.state !== 'ok') return actFailure(activated, 'USE_ON_FAILED')
    return { state: 'succeeded', observed: { kind: 'use-on', target } }
  }

  const item = params.item
  if (typeof item !== 'string' || item.length === 0) return { state: 'failed', code: 'BAD_ARGS' }
  const equipped = await ctx.body.equip(item)
  if (equipped.state !== 'ok') return actFailure(equipped, 'USE_EQUIP_FAILED')
  const used = await ctx.body.useItem({ durationMs: Math.max(1_000, params.durationMs ?? 1_800) })
  if (used.state !== 'ok') return actFailure(used, 'USE_ITEM_FAILED')
  return { state: 'succeeded', observed: { kind: 'use-item', item } }
}

function toTarget(params: UseParams): { x: number; y: number; z: number } | undefined {
  if (typeof params.x !== 'number' || typeof params.y !== 'number' || typeof params.z !== 'number') return undefined
  if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) return undefined
  return { x: Math.floor(params.x), y: Math.floor(params.y), z: Math.floor(params.z) }
}

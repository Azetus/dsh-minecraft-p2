import type { ContainerTransferAction } from '../../port/index.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle } from './handle.ts'

export const CONTAINER_DRIVER_ID = 'container'

const CONTAINER_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    action: { type: 'string', enum: ['withdraw', 'deposit'] },
    item: { type: 'string' },
    count: { type: 'number' },
  },
  required: ['x', 'y', 'z', 'action', 'item'],
  additionalProperties: false,
}

type ContainerParams = {
  x: number
  y: number
  z: number
  action: 'withdraw' | 'deposit'
  item: string
  count?: number
}

/** Withdraw or deposit one stack/item through an Agent-selected container. */
export function createContainerDriver(): Driver {
  return {
    id: CONTAINER_DRIVER_ID,
    schema: CONTAINER_SCHEMA,
    defaults: {
      budget: { maxTicks: 400, maxWallMs: 30_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as ContainerParams
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      if (params.action !== 'withdraw' && params.action !== 'deposit') return { ok: false, code: 'BAD_ARGS' }
      if (typeof params.item !== 'string' || params.item.length === 0) return { ok: false, code: 'BAD_ARGS' }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as ContainerParams
      return new AsyncDriverHandle(
        `container:${params.action}:${params.item}`,
        transfer(ctx, params),
      )
    },
  }
}

async function transfer(ctx: DriverCtx, params: ContainerParams): Promise<DriverResult> {
  const chest = { x: params.x, y: params.y, z: params.z }
  const moved = await ctx.port.moveTo(chest, { range: 2, timeoutMs: 20_000 })
  if (moved.state !== 'ok') return { state: 'failed', code: moved.code ?? 'CONTAINER_MOVE_FAILED' }
  const result = await ctx.port.containerTransfer(
    chest,
    params.action as ContainerTransferAction,
    params.item,
    params.count ?? 1,
  )
  if (result.state !== 'ok') return { state: 'failed', code: result.code ?? 'CONTAINER_TRANSFER_FAILED' }
  return {
    state: 'succeeded',
    observed: {
      kind: 'container-transfer',
      action: params.action,
      item: params.item,
      count: params.count ?? 1,
      chest,
    },
  }
}

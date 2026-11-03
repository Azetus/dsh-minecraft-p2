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
    action: {
      type: 'string',
      enum: ['withdraw', 'deposit', 'load-input', 'load-fuel', 'take-input', 'take-fuel', 'take-output'],
    },
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
  action: ContainerTransferAction
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
      if (!['withdraw', 'deposit', 'load-input', 'load-fuel', 'take-input', 'take-fuel', 'take-output']
        .includes(params.action)) return { ok: false, code: 'BAD_ARGS' }
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
  const requested = params.count ?? 1
  const result = await ctx.port.containerTransfer(
    chest,
    params.action,
    params.item,
    requested,
  )
  if (result.state !== 'ok') return { state: 'failed', code: result.code ?? 'CONTAINER_TRANSFER_FAILED' }
  const observed = result.observed
  const playerBefore = numberField(observed, 'playerBefore')
  const playerAfter = numberField(observed, 'playerAfter')
  const containerBefore = numberField(observed, 'containerBefore')
  const containerAfter = numberField(observed, 'containerAfter')
  const base = {
    kind: 'container-transfer',
    action: params.action,
    item: params.item,
    count: requested,
    chest,
    ...(isRecord(observed) ? { transfer: observed } : {}),
  }
  if (playerBefore === undefined || playerAfter === undefined
    || containerBefore === undefined || containerAfter === undefined) {
    return { state: 'failed', code: 'CONTAINER_READBACK_UNKNOWN', observed: base }
  }
  const inbound = params.action === 'deposit'
    || params.action === 'load-input'
    || params.action === 'load-fuel'
  const playerMoved = inbound ? playerBefore - playerAfter : playerAfter - playerBefore
  const containerMoved = inbound ? containerAfter - containerBefore : containerBefore - containerAfter
  // take-* has no count parameter; any positive movement is the postcondition.
  const required = params.action.startsWith('take-') ? 1 : requested
  if (playerMoved < required || containerMoved < required) {
    return {
      state: 'failed',
      code: 'CONTAINER_INCOMPLETE',
      observed: {
        ...base,
        playerBefore,
        playerAfter,
        containerBefore,
        containerAfter,
        playerMoved,
        containerMoved,
        required,
      },
    }
  }
  return {
    state: 'succeeded',
    observed: {
      ...base,
      playerBefore,
      playerAfter,
      containerBefore,
      containerAfter,
      playerMoved,
      containerMoved,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

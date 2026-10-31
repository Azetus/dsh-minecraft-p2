import type { ClientPort } from '../../port/index.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle } from './handle.ts'

export const ATTACK_DRIVER_ID = 'attack'

const ATTACK_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    entityId: { type: 'string' },
    targetName: { type: 'string' },
    orderId: { type: 'string' },
  },
  required: ['entityId'],
  additionalProperties: false,
}

type AttackParams = { entityId: string; targetName?: string; orderId?: string }

/**
 * One explicit attack. Target authorization happens in the giver; this driver
 * never picks a target and never attacks without an Agent order.
 */
export function createAttackDriver(): Driver {
  return {
    id: ATTACK_DRIVER_ID,
    schema: ATTACK_SCHEMA,
    defaults: {
      budget: { maxTicks: 40, maxWallMs: 3_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as AttackParams
      if (typeof params.entityId !== 'string' || params.entityId.length === 0) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as AttackParams
      return new AsyncDriverHandle(
        `attack:${params.entityId}`,
        attack(ctx.port, params),
      )
    },
  }
}

async function attack(port: ClientPort, params: AttackParams): Promise<DriverResult> {
  const result = await port.attack(params.entityId)
  if (result.state !== 'ok') {
    return { state: 'failed', code: result.code ?? 'ATTACK_FAILED' }
  }
  return {
    state: 'succeeded',
    observed: {
      kind: 'attack',
      entityId: params.entityId,
      ...(params.targetName === undefined ? {} : { targetName: params.targetName }),
      ...(params.orderId === undefined ? {} : { orderId: params.orderId }),
    },
  }
}

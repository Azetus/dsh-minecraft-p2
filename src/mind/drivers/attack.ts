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
    /** Explicit Agent authorization for a named passive target; players stay protected. */
    allowPassive: { type: 'boolean' },
  },
  required: ['entityId'],
  additionalProperties: false,
}

type AttackParams = { entityId: string; targetName?: string; orderId?: string; allowPassive?: boolean }

/**
 * One explicit attack. Target authorization happens in the giver; this driver
 * never picks a target and never attacks without an Agent order.
 */
export function createAttackDriver(): Driver {
  return {
    id: ATTACK_DRIVER_ID,
    schema: ATTACK_SCHEMA,
    defaults: {
      budget: { maxTicks: 400, maxWallMs: 20_000 },
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
  const locate = () => {
    const self = port.self().pos
    return port.entities({ min: { x: self.x - 32, y: self.y - 8, z: self.z - 32 },
      max: { x: self.x + 32, y: self.y + 8, z: self.z + 32 } }).find(entity => entity.id === params.entityId)
  }
  const distanceTo = (p: { x: number; y: number; z: number }): number => {
    const self = port.self().pos
    return Math.hypot(self.x - p.x, self.y - p.y, self.z - p.z)
  }
  let target = locate()
  if (target === undefined) return { state: 'failed', code: 'ATTACK_TARGET_LOST' }
  if (distanceTo(target.position) > 3) {
    const moved = await port.moveTo(target.position, { range: 2.5, intent: 'attack', timeoutMs: 15_000 })
    if (moved.state !== 'ok') return { state: 'failed', code: moved.code ?? 'ATTACK_APPROACH_FAILED',
      ...(moved.observed === undefined ? {} : { observed: moved.observed }) }
    target = locate()
    if (target === undefined || distanceTo(target.position) > 3) return { state: 'failed', code: 'ATTACK_TARGET_MOVED' }
  }
  const passive = target.type !== 'player' && /passive|neutral|tameable/i.test(target.kind ?? '')
  if (target.type === 'player'
    || (passive && params.allowPassive !== true)
    || (params.targetName !== undefined && target.name !== params.targetName)) {
    return { state: 'failed', code: 'ATTACK_TARGET_CHANGED' }
  }
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

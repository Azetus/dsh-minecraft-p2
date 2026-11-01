import type { ClientPort, EntityInfo, Vec3 } from '../../port/index.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle, sleep } from './handle.ts'

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

const ATTACK_REACH = 3
const MAX_ATTACKS = 24
const MAX_CHASES = 8
const MAX_MISSES = 6
const ATTACK_INTERVAL_MS = 650
const CHASE_TIMEOUT_MS = 5_000
const TOTAL_MS = 40_000

/**
 * One explicit attack order with bounded tracking. The entity id is locked;
 * this driver never acquires a different target and never attacks a player or
 * an unauthorized passive/neutral entity.
 */
export function createAttackDriver(): Driver {
  return {
    id: ATTACK_DRIVER_ID,
    schema: ATTACK_SCHEMA,
    defaults: {
      budget: { maxTicks: 1_200, maxWallMs: 45_000 },
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
      return new AsyncDriverHandle(`attack:${params.entityId}`, attack(ctx.port, params))
    },
  }
}

async function attack(port: ClientPort, params: AttackParams): Promise<DriverResult> {
  const startedAt = Date.now()
  let attacks = 0
  let chases = 0
  let misses = 0
  let target = locate(port, params.entityId)
  if (target === undefined) return { state: 'failed', code: 'ATTACK_TARGET_LOST' }

  while (Date.now() - startedAt < TOTAL_MS && attacks < MAX_ATTACKS) {
    target = locate(port, params.entityId)
    if (target === undefined) {
      return attacks > 0
        ? { state: 'succeeded', observed: result(params, attacks, chases, true) }
        : { state: 'failed', code: 'ATTACK_TARGET_LOST' }
    }
    const guard = guardTarget(target, params)
    if (guard !== undefined) return { state: 'failed', code: guard, observed: result(params, attacks, chases, false) }

    const distance = distanceTo(port.self().pos, target.position)
    if (distance > ATTACK_REACH) {
      if (chases >= MAX_CHASES) {
        return { state: 'failed', code: 'ATTACK_CHASE_LIMIT', observed: result(params, attacks, chases, false) }
      }
      const moved = await port.moveTo(target.position, {
        range: 2.5,
        intent: 'attack',
        timeoutMs: CHASE_TIMEOUT_MS,
      })
      chases += 1
      if (moved.state !== 'ok') {
        await sleep(150)
      }
      continue
    }

    const hit = await port.attack(params.entityId)
    if (hit.state !== 'ok') {
      misses += 1
      if (misses >= MAX_MISSES) {
        return { state: 'failed', code: 'ATTACK_NO_HIT', observed: result(params, attacks, chases, false) }
      }
      await sleep(200)
      continue
    }
    attacks += 1
    misses = 0
    await sleep(ATTACK_INTERVAL_MS)
  }

  target = locate(port, params.entityId)
  if (attacks > 0 && target === undefined) {
    return { state: 'succeeded', observed: result(params, attacks, chases, true) }
  }
  if (attacks === 0) return { state: 'failed', code: 'ATTACK_NO_HIT', observed: result(params, 0, chases, false) }
  return { state: 'failed', code: 'ATTACK_NOT_KILLED', observed: result(params, attacks, chases, false) }
}

function locate(port: ClientPort, entityId: string): EntityInfo | undefined {
  const self = port.self().pos
  return port.entities({
    min: { x: self.x - 32, y: self.y - 8, z: self.z - 32 },
    max: { x: self.x + 32, y: self.y + 8, z: self.z + 32 },
  }).find(entity => entity.id === entityId)
}

function guardTarget(target: EntityInfo, params: AttackParams): string | undefined {
  if (target.type === 'player') return 'ATTACK_TARGET_PROTECTED'
  if (/passive|neutral|tameable/i.test(target.kind ?? '') && params.allowPassive !== true) {
    return 'ATTACK_TARGET_PROTECTED'
  }
  if (params.targetName !== undefined && target.name !== params.targetName) return 'ATTACK_TARGET_CHANGED'
  return undefined
}

function distanceTo(self: Vec3, target: Vec3): number {
  return Math.hypot(self.x - target.x, self.y - target.y, self.z - target.z)
}

function result(params: AttackParams, attacks: number, chases: number, killed: boolean) {
  return {
    kind: 'attack',
    entityId: params.entityId,
    attacks,
    chases,
    killed,
    ...(params.targetName === undefined ? {} : { targetName: params.targetName }),
    ...(params.orderId === undefined ? {} : { orderId: params.orderId }),
  }
}

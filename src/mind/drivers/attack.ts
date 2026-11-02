import { isRecord } from '../../contracts/protocol.ts'
import type { JsonValue } from '../../contracts/types.ts'
import type { ClientPort, ClientEvent, EntityInfo } from '../../port/index.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import {
  runMeleeCombat,
  type CombatAction,
  type CombatEntity,
  type CombatPort,
} from '../../motion/combat/index.ts'
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
 * One explicit attack order with bounded tracking. The entity id is locked;
 * this driver never acquires a different target and never attacks a player or
 * an unauthorized passive/neutral entity. `killed` requires an observed death
 * event; a target that merely leaves the query range is `targetLost`.
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
  const result = await runMeleeCombat(combatPort(port), params.entityId, {
    ...(params.targetName === undefined ? {} : { targetName: params.targetName }),
    ...(params.allowPassive === true ? { allowPassive: true } : {}),
  })
  return {
    state: result.state,
    ...(result.code === undefined ? {} : { code: result.code }),
    observed: result.observed as unknown as JsonValue,
  }
}

function combatPort(port: ClientPort): CombatPort {
  return {
    now: () => Date.now(),
    self: () => {
      const self = port.self()
      return { pos: self.pos, health: self.health }
    },
    entity: id => locate(port, id),
    canSee: id => port.canSee?.(id) ?? true,
    attackSpeed: () => port.attackSpeed?.() ?? 4,
    attack: id => asAction(port.attack(id)),
    moveTo: (pos, range, timeoutMs) => asAction(port.moveTo(pos, { range, intent: 'attack', timeoutMs, motion: true })),
    onEntityHurt: cb => subscribe(port, 'entityHurt', cb),
    onEntityDead: cb => subscribe(port, 'entityDead', cb),
  }
}

function asAction(result: Promise<{ state: 'ok' | 'failed' | 'unknown'; code?: string }>): Promise<CombatAction> {
  return result.then(entry => ({
    state: entry.state,
    ...(entry.code === undefined ? {} : { code: entry.code }),
  }))
}

function subscribe(port: ClientPort, event: ClientEvent, cb: (entityId: string) => void): () => void {
  let active = true
  const listener = (payload: unknown): void => {
    if (!active) return
    if (isRecord(payload) && typeof payload.entityId === 'string') cb(payload.entityId)
  }
  port.on(event, listener)
  return () => {
    active = false
    port.off?.(event, listener)
  }
}

function locate(port: ClientPort, entityId: string): CombatEntity | undefined {
  const self = port.self().pos
  const entity: EntityInfo | undefined = port.entities({
    min: { x: self.x - 32, y: self.y - 8, z: self.z - 32 },
    max: { x: self.x + 32, y: self.y + 8, z: self.z + 32 },
  }).find(candidate => candidate.id === entityId)
  if (entity === undefined) return undefined
  return {
    id: entity.id,
    name: entity.name,
    position: entity.position,
    ...(entity.type === undefined ? {} : { type: entity.type }),
    ...(entity.kind === undefined ? {} : { kind: entity.kind }),
  }
}

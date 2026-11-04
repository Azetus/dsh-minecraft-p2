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
import { failureBody, readFailure, withFailure } from '../failure.ts'
import { chooseWeapon } from '../tools.ts'

export const ATTACK_DRIVER_ID = 'attack'

const ATTACK_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    entityId: { type: 'string' },
    targetName: { type: 'string' },
    orderId: { type: 'string' },
    /** Explicit Agent order: skip the automatic player/passive guard. */
    allowAny: { type: 'boolean' },
    /** Bounded entity lookup box for a far explicit target; default 32. */
    locateRadius: { type: 'number', minimum: 8, maximum: 64 },
    /** Internal candidate keys, so a hot constant tree can renew instead of preempt. */
    continuationKey: { type: 'string' },
    /** Deprecated compatibility flag; explicit orders now use allowAny. */
    allowPassive: { type: 'boolean' },
  },
  required: ['entityId'],
  additionalProperties: false,
}

type AttackParams = {
  entityId: string
  targetName?: string
  orderId?: string
  allowAny?: boolean
  locateRadius?: number
  continuationKey?: string
  allowPassive?: boolean
}

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
      const key = params.continuationKey ?? `attack:${params.entityId}`
      const autoEquip = ctx.allowAutoEquip?.() ?? true
      return new AsyncDriverHandle(key, attack(ctx.port, params, autoEquip).then(result => attachAttackFailure(result, params)))
    },
  }
}

async function attack(port: ClientPort, params: AttackParams, autoEquip: boolean): Promise<DriverResult> {
  if (autoEquip) {
    const weapon = chooseWeapon(port.inventory())
    if (weapon !== undefined) {
      const equipped = await port.equip(weapon)
      if (equipped.state !== 'ok') {
        return {
          state: 'failed',
          code: equipped.code ?? 'EQUIP_FAILED',
          observed: (equipped.observed ?? { kind: 'equip', item: weapon }) as unknown as JsonValue,
        }
      }
    }
  }
  const result = await runMeleeCombat(combatPort(port, params.locateRadius ?? 32), params.entityId, {
    ...(params.targetName === undefined ? {} : { targetName: params.targetName }),
    ...(params.allowAny === true ? { allowAny: true } : {}),
    ...(params.allowPassive === true ? { allowPassive: true } : {}),
  })
  return {
    state: result.state,
    ...(result.code === undefined ? {} : { code: result.code }),
    observed: result.observed as unknown as JsonValue,
  }
}

function combatPort(port: ClientPort, locateRadius: number): CombatPort {
  return {
    now: () => Date.now(),
    self: () => {
      const self = port.self()
      return { pos: self.pos, health: self.health }
    },
    entity: id => locate(port, id, locateRadius),
    canSee: id => port.canSee?.(id) ?? true,
    attackSpeed: () => port.attackSpeed?.() ?? 4,
    attack: id => asAction(port.attack(id)),
    moveTo: (pos, range, timeoutMs) => asAction(port.moveTo(pos, { range, intent: 'attack', timeoutMs })),
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

function locate(port: ClientPort, entityId: string, locateRadius: number): CombatEntity | undefined {
  const self = port.self().pos
  const entity: EntityInfo | undefined = port.entities({
    min: { x: self.x - locateRadius, y: self.y - 16, z: self.z - locateRadius },
    max: { x: self.x + locateRadius, y: self.y + 16, z: self.z + locateRadius },
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

function attachAttackFailure(result: DriverResult, params: AttackParams): DriverResult {
  if (result.state !== 'failed' || readFailure(result.observed) !== undefined) return result
  const code = result.code ?? 'ATTACK_FAILED'
  return {
    ...result,
    observed: withFailure(result.observed, failureBody({
      layer: 'driver',
      phase: 'execute',
      code,
      observed: result.observed,
      facts: {
        entityId: params.entityId,
        ...(params.targetName === undefined ? {} : { targetName: params.targetName }),
      },
      cause: { kind: code === 'ATTACK_TARGET_PROTECTED' ? 'authority' : 'world', code },
      recovery: 'none',
    })),
  }
}

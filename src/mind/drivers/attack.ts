import { isRecord } from '../../contracts/protocol.ts'
import type { BodyApi, BodyEvent, Vec3 } from '../../body/api.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverValidation, Job, WorldView } from '../types.ts'
import type {
  CombatAction,
  CombatEntity,
  CombatPort,
  MeleeOptions,
} from '../../motion/combat/index.ts'
import { CombatSessionHandle, type CombatPrep } from './combat-session.ts'
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
    /** Kept for order compatibility; no longer drives a separate chase. */
    maxChases: { type: 'integer', minimum: 1, maximum: 64 },
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
  maxChases?: number
  continuationKey?: string
  allowPassive?: boolean
}

/**
 * One explicit attack order with bounded tracking. The attack driver is a
 * 50ms tick handle: the mind loop calls `tick()`, and `CombatSession` owns all
 * combat behavior (movement, shield, guard, attack).
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
      return new CombatSessionHandle(key, prepareCombat(ctx.body, params, autoEquip))
    },
  }
}

async function prepareCombat(
  port: BodyApi,
  params: AttackParams,
  autoEquip: boolean,
): Promise<CombatPrep> {
  const shieldAutoEquip = await ensureOffhandShield(port)
  if (autoEquip) {
    const weapon = chooseWeapon(port.inventory())
    if (weapon !== undefined) {
      const equipped = await port.equip(weapon)
      if (equipped.state !== 'ok') {
        throw codedError(equipped.code ?? 'EQUIP_FAILED', `weapon equip failed: ${weapon}`)
      }
    }
  }
  const options: MeleeOptions = {
    ...(params.targetName === undefined ? {} : { targetName: params.targetName }),
    ...(params.allowAny === true ? { allowAny: true } : {}),
    ...(params.allowPassive === true ? { allowPassive: true } : {}),
  }
  return {
    port: combatPort(port, params.locateRadius ?? 32),
    targetId: params.entityId,
    options,
    shieldAutoEquip,
  }
}

function combatPort(port: BodyApi, locateRadius: number): CombatPort {
  return {
    now: () => Date.now(),
    self: () => {
      const self = port.self()
      return {
        pos: self.pos,
        health: self.health,
        ...(self.height === undefined ? {} : { height: self.height }),
      }
    },
    entity: id => locate(port, id, locateRadius),
    canSee: id => port.canSee?.(id) ?? true,
    attackSpeed: () => port.attackSpeed?.() ?? 4,
    ...(port.attackReach === undefined ? {} : { reach: () => port.attackReach!() }),
    attack: id => asAction(port.attack(id)),
    ...(port.combatInput === undefined
      ? {}
      : {
          combatInput: (opts: {
            face: Vec3
            forward?: boolean
            back?: boolean
            left?: boolean
            right?: boolean
          }) => asAction(port.combatInput!(opts)),
        }),
    ...(port.lookAt === undefined ? {} : { lookAt: (pos: Vec3) => asAction(port.lookAt!(pos)) }),
    ...(port.offhand === undefined
      ? {}
      : { hasShield: () => normalizeName(port.offhand!()?.name) === 'shield' }),
    ...(port.offhandHold === undefined
      ? {}
      : { offhandHold: (active: boolean) => asAction(port.offhandHold!(active)) }),
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

function subscribe(port: BodyApi, event: BodyEvent, cb: (entityId: string) => void): () => void {
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

function locate(port: BodyApi, entityId: string, locateRadius: number): CombatEntity | undefined {
  const self = port.self().pos
  const inBox = (position: { x: number; y: number; z: number }): boolean =>
    Math.abs(position.x - self.x) <= locateRadius
    && Math.abs(position.y - self.y) <= 16
    && Math.abs(position.z - self.z) <= locateRadius
  const direct = port.entityById?.(entityId)
  const entity = direct !== undefined
    ? (inBox(direct.position) ? direct : undefined)
    : port.entities({
        min: { x: self.x - locateRadius, y: self.y - 16, z: self.z - locateRadius },
        max: { x: self.x + locateRadius, y: self.y + 16, z: self.z + locateRadius },
      }).find(candidate => candidate.id === entityId)
  if (entity === undefined) return undefined
  return {
    id: entity.id,
    name: entity.name,
    position: entity.position,
    ...(entity.velocity === undefined ? {} : { velocity: entity.velocity }),
    ...(entity.yaw === undefined ? {} : { yaw: entity.yaw }),
    ...(entity.type === undefined ? {} : { type: entity.type }),
    ...(entity.kind === undefined ? {} : { kind: entity.kind }),
    ...(entity.health === undefined ? {} : { health: entity.health }),
    ...(entity.width === undefined ? {} : { width: entity.width }),
    ...(entity.height === undefined ? {} : { height: entity.height }),
  }
}

type ShieldAutoEquip = 'equipped' | 'present' | 'skipped' | 'failed' | 'no-shield'

/**
 * Method-level convenience: if the off hand is empty and a shield is in the
 * inventory, put it there before combat. A non-empty off hand is never
 * replaced; the Agent's explicit off-hand choice wins.
 */
async function ensureOffhandShield(port: BodyApi): Promise<ShieldAutoEquip> {
  if (port.offhand === undefined) return 'skipped'
  const current = port.offhand()
  if (normalizeName(current?.name) === 'shield') return 'present'
  if (current !== undefined) return 'skipped'
  const shield = port.inventory().find(item => normalizeName(item.name) === 'shield')
  if (shield === undefined) return 'no-shield'
  const equipped = await port.equip(shield.name, 'offhand')
  if (equipped.state !== 'ok') return 'failed'
  return normalizeName(port.offhand()?.name) === 'shield' ? 'equipped' : 'failed'
}

function normalizeName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.replace(/^minecraft:/u, '')
}

function codedError(code: string, message: string): Error {
  const error = new Error(message)
  ;(error as { code?: string }).code = code
  return error
}

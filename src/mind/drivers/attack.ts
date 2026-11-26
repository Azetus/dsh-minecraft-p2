import { isRecord } from '../../contracts/protocol.ts'
import type { BodyApi, BodyEvent, Vec3 } from '../../body/api.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverValidation, Job, WorldView } from '../types.ts'
import type {
  CombatAction,
  CombatEntity,
  CombatPort,
  MeleeOptions,
  RangedCombatOutcome,
  RangedChargeTick,
  RangedCombatStatus,
} from '../../motion/combat/index.ts'
import { CombatSessionHandle, type CombatPrep } from './combat-session.ts'
import { RangedAttack } from './shoot.ts'
import { isArrowName, isCrossbowLoadedWithArrow } from '../ranged/crossbow.ts'
import { chooseWeapon } from '../tools.ts'

export const ATTACK_DRIVER_ID = 'attack'

const ATTACK_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    entityId: { type: 'string' },
    /** Additional allowed targets; the session switches inside this set. */
    entityIds: { type: 'array', items: { type: 'string' } },
    /** Pre-authorized fight: resolve when no allowed target remains. */
    engagement: { type: 'boolean' },
    targetName: { type: 'string' },
    orderId: { type: 'string' },
    /** Agent authorizes switching to a ranged weapon. */
    allowRanged: { type: 'boolean' },
    /** Explicit Agent order: skip the automatic player/passive guard. */
    allowAny: { type: 'boolean' },
    /** Bounded entity lookup box for a far explicit target; default 32. */
    locateRadius: { type: 'number', minimum: 8, maximum: 64 },
    /** Optional distance leash from the order start. */
    chaseLeash: { type: 'number', minimum: 2, maximum: 256 },
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
  entityIds?: string[]
  engagement?: boolean
  targetName?: string
  orderId?: string
  allowRanged?: boolean
  allowAny?: boolean
  locateRadius?: number
  chaseLeash?: number
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
      if (params.entityIds !== undefined
        && (!Array.isArray(params.entityIds) || params.entityIds.length > 16)) {
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
    targetIds: [...new Set([params.entityId, ...(params.entityIds ?? [])])],
    ...(params.engagement === true ? { engagement: true } : {}),
    ...(params.allowRanged === true ? { allowRanged: true } : {}),
    ...(params.chaseLeash === undefined ? {} : { chaseLeash: params.chaseLeash }),
    ...(params.targetName === undefined ? {} : { targetName: params.targetName }),
    ...(params.allowAny === true ? { allowAny: true } : {}),
    ...(params.allowPassive === true ? { allowPassive: true } : {}),
  }
  return {
    port: combatPort(port, params.locateRadius ?? 32, params.allowRanged === true),
    targetIds: options.targetIds ?? [params.entityId],
    options,
    shieldAutoEquip,
  }
}

function combatPort(port: BodyApi, locateRadius: number, allowRanged: boolean): CombatPort {
  let currentRanged: RangedAttack | undefined
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
    ...(port.pathTo === undefined
      ? {}
      : {
          pathTo: (pos: Vec3, range: number, timeoutMs: number) =>
            port.pathTo!(pos, range, timeoutMs),
        }),
    ...(port.combatInput === undefined
      ? {}
      : {
          combatInput: (opts: {
            face: Vec3
            forward?: boolean
            back?: boolean
            left?: boolean
            right?: boolean
            jump?: boolean
            preservePitch?: boolean
          }) => asAction(port.combatInput!(opts)),
        }),
    ...(port.lookAt === undefined ? {} : { lookAt: (pos: Vec3) => asAction(port.lookAt!(pos)) }),
    ...(port.offhand === undefined
      ? {}
      : { hasShield: () => normalizeName(port.offhand!()?.name) === 'shield' }),
    ...(port.offhandHold === undefined
      ? {}
      : { offhandHold: (active: boolean) => asAction(port.offhandHold!(active)) }),
    ...(allowRanged
      ? {
          ranged: {
            status: (target: CombatEntity) => rangedStatus(port, target),
            fire: async (
              target: CombatEntity,
              onTick?: RangedChargeTick,
            ): Promise<RangedCombatOutcome> => {
              const weapon = chooseRangedWeapon(port)
              if (weapon === undefined) return { state: 'unavailable', code: 'NO_RANGED_WEAPON' }
              const attack = new RangedAttack(port, {
                entityId: target.id,
                weapon,
                targetName: target.name,
                maxShots: 1,
                maxRange: RANGED_MAX,
              }, {
                requireStationary: false,
                useShooterVelocity: true,
                maxShots: 1,
                ...(onTick === undefined ? {} : { onChargeTick: onTick }),
              })
              currentRanged = attack
              try {
                const result = await attack.work()
                if (result.state === 'succeeded') {
                  return { state: 'hit', weapon }
                }
                if (result.state === 'interrupted') return { state: 'stopped', weapon }
                const code = result.code ?? ''
                if (code === 'SHOOT_MISSED') return { state: 'missed', code, weapon }
                if (code === 'SHOOT_INCONCLUSIVE') return { state: 'inconclusive', code, weapon }
                return { state: 'failed', code, weapon }
              } finally {
                currentRanged = undefined
              }
            },
            stop: () => currentRanged?.stop(),
          },
          switchToMelee: async (): Promise<void> => {
            const weapon = chooseWeapon(port.inventory())
            if (weapon !== undefined) await port.equip(weapon)
          },
        }
      : {}),
    onEntityHurt: cb => subscribe(port, 'entityHurt', cb),
    onEntityDead: cb => subscribe(port, 'entityDead', cb),
    ...(port.on === undefined
      ? {}
      : {
          onExplosion: (cb: (pos: Vec3, radius?: number) => void) => {
            const listener = (payload: unknown): void => {
              if (!isRecord(payload)) return
              const x = payload.x
              const y = payload.y
              const z = payload.z
              if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return
              cb({ x, y, z }, typeof payload.radius === 'number' ? payload.radius : undefined)
            }
            port.on('explosion', listener)
            return () => port.off?.('explosion', listener)
          },
        }),
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

const RANGED_MAX = 24

function chooseRangedWeapon(port: BodyApi): 'bow' | 'crossbow' | undefined {
  const held = port.held?.()
  if (held !== undefined
    && normalizeName(held.name) === 'crossbow'
    && isCrossbowLoadedWithArrow(held)) return 'crossbow'
  const inventory = port.inventory()
  if (inventory.some(item => normalizeName(item.name) === 'bow')) return 'bow'
  if (inventory.some(item => normalizeName(item.name) === 'crossbow')) return 'crossbow'
  return undefined
}

function hasRangedAmmo(port: BodyApi, weapon: 'bow' | 'crossbow'): boolean {
  const held = port.held?.()
  if (weapon === 'crossbow' && held !== undefined
    && normalizeName(held.name) === 'crossbow'
    && isCrossbowLoadedWithArrow(held)) return true
  if (port.inventory().some(item => isArrowName(item.name))) return true
  return isArrowName(port.offhand?.()?.name ?? '')
}

function rangedStatus(port: BodyApi, target: CombatEntity): RangedCombatStatus {
  const self = port.self().pos
  const range = Math.hypot(target.position.x - self.x, target.position.z - self.z)
  if (range > RANGED_MAX) return { ready: false, code: 'OUT_OF_RANGE' }
  const weapon = chooseRangedWeapon(port)
  if (weapon === undefined) return { ready: false, code: 'NO_RANGED_WEAPON' }
  if (!hasRangedAmmo(port, weapon)) return { ready: false, code: 'NO_AMMO', weapon }
  return { ready: true, weapon }
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

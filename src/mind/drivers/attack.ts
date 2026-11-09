import { isRecord } from '../../contracts/protocol.ts'
import type { JsonValue } from '../../contracts/types.ts'
import type { BodyApi, BodyEvent, Vec3 } from '../../body/api.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import {
  runMeleeCombat,
  type CombatAction,
  type CombatEntity,
  type CombatPort,
} from '../../motion/combat/index.ts'
import { defaultConstraints, createRules } from '../../motion/model/index.ts'
import { standingCell } from '../../motion/execute/index.ts'
import { standCells } from '../../motion/search/index.ts'
import { createReadOnlyMotionWorld } from '../standing.ts'
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
    /** Optional per-order chase cap; default 12. */
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
      return new AsyncDriverHandle(key, attack(ctx.body, params, autoEquip).then(result => attachAttackFailure(result, params)))
    },
  }
}

async function attack(port: BodyApi, params: AttackParams, autoEquip: boolean): Promise<DriverResult> {
  const shieldAutoEquip = await ensureOffhandShield(port)
  if (autoEquip) {
    const weapon = chooseWeapon(port.inventory())
    if (weapon !== undefined) {
      const equipped = await port.equip(weapon)
      if (equipped.state !== 'ok') {
        return {
          state: 'failed',
          code: equipped.code ?? 'EQUIP_FAILED',
          observed: {
            ...(isRecord(equipped.observed) ? equipped.observed : {}),
            shieldAutoEquip,
          } as unknown as JsonValue,
        }
      }
    }
  }
  const result = await runMeleeCombat(combatPort(port, params.locateRadius ?? 32), params.entityId, {
    ...(params.targetName === undefined ? {} : { targetName: params.targetName }),
    ...(params.allowAny === true ? { allowAny: true } : {}),
    ...(params.allowPassive === true ? { allowPassive: true } : {}),
    ...(params.maxChases === undefined ? {} : { maxChases: params.maxChases }),
  })
  return {
    state: result.state,
    ...(result.code === undefined ? {} : { code: result.code }),
    observed: {
      ...(isRecord(result.observed) ? result.observed : {}),
      shieldAutoEquip,
    } as unknown as JsonValue,
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
    moveTo: (pos, range, timeoutMs) => asAction(port.moveTo(pos, { range, intent: 'attack', timeoutMs })),
    ...(port.combatStep === undefined ? {} : {
      combatStep: async opts => {
        const result = await port.combatStep!({
          cell: opts.cell,
          face: opts.face,
          ...(opts.shield === undefined ? {} : { shield: opts.shield }),
          ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
        })
        const observed = isRecord(result.observed) ? result.observed : undefined
        return {
          state: result.state,
          ...(result.code === undefined ? {} : { code: result.code }),
          ...(observed?.shieldUsed === true ? { shieldUsed: true } : {}),
        }
      },
    }),
    standCells: query => {
      const world = createReadOnlyMotionWorld(point => port.blockAt(point))
      const constraints = defaultConstraints()
      const rules = createRules(world, constraints)
      const self = port.self()
      const near = {
        x: Math.floor(query.near.x),
        y: Math.floor(query.near.y),
        z: Math.floor(query.near.z),
      }
      const result = standCells(world, {
        near,
        desired: near,
        reach: { horizontal: 1, vertical: 1 },
        accept: (cell, feetY) => query.accept(
          { x: cell.x + 0.5, y: feetY, z: cell.z + 0.5 },
          feetY,
        ),
      }, {
        from: standingCell(rules, self.pos),
        constraints,
        reachability: { maxNodes: 256 },
        dry: true,
      })
      return result.cells.map(cell => ({
        cell: { x: cell.cell.x, y: cell.cell.y, z: cell.cell.z },
        feetY: cell.feetY,
        distance: cell.distance,
        reachable: cell.reachable,
        ...(cell.steps === undefined ? {} : { steps: cell.steps }),
      }))
    },
    ...(port.lookAt === undefined ? {} : { lookAt: (pos: Vec3) => asAction(port.lookAt!(pos)) }),
    ...(port.offhand === undefined
      ? {}
      : { hasShield: () => normalizeName(port.offhand!()?.name) === 'shield' }),
    shield: durationMs => asAction(port.useItem({ durationMs, offhand: true })),
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
    ...(entity.yaw === undefined ? {} : { yaw: entity.yaw }),
    ...(entity.type === undefined ? {} : { type: entity.type }),
    ...(entity.kind === undefined ? {} : { kind: entity.kind }),
    ...(entity.health === undefined ? {} : { health: entity.health }),
    ...(entity.width === undefined ? {} : { width: entity.width }),
    ...(entity.height === undefined ? {} : { height: entity.height }),
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

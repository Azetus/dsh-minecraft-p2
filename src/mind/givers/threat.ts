import type { EntityInfo, Vec3 } from '../../body/api.ts'
import type { DriverResult } from '../types.ts'
import { boxAround } from '../sensors.ts'
import type { Candidate, EvalCtx, WorkGiver, WorkGiverResult, WorldView } from '../types.ts'
import type { ReactionPolicy } from '../reaction-policy.ts'
import { isAutoFightTarget } from '../reaction-policy.ts'

export type FightTerminal = {
  keys: string
  at: number
  state: DriverResult['state']
  code?: string
}

export type ThreatFightGiver = WorkGiver & {
  noteTerminal(event: FightTerminal): void
  reset(): void
}

type Lock = {
  entityId: string
  name: string
  origin: Vec3
  lastPos: Vec3
}

const LOCK_QUERY_RADIUS = 40
const FAILED_TARGET_MS = 10_000
const FAILED_COOLDOWN_MS = 3_000
const INTERRUPTED_COOLDOWN_MS = 1_000

/**
 * Automatic defense gate. It only acquires an allowed hostile; approach and
 * attack stay in the existing melee driver. An explicit `attack` order owns
 * combat and suppresses this giver entirely.
 */
export function createThreatFightGiver(policy: () => ReactionPolicy): ThreatFightGiver {
  let lock: Lock | undefined
  let cooldownUntil = 0
  const failed = new Map<string, number>()

  return {
    id: 'threat.fight',
    find(ctx: EvalCtx, world: WorldView): WorkGiverResult {
      if (ctx.orderVerb === 'attack') return null
      const fight = policy().fight
      if (fight === null) return null
      const self = world.self
      if (self.health <= fight.retreatHealth) return null
      if (self.inLava || (self.inWater && !self.onGround)) return null

      if (lock !== undefined) {
        const entity = findEntity(world, lock.entityId)
        if (entity !== undefined) lock.lastPos = entity.position
        if (distance(lock.origin, lock.lastPos) > fight.leash) {
          lock = undefined
          cooldownUntil = ctx.now + FAILED_COOLDOWN_MS
          return null
        }
        if (entity !== undefined && !isAutoFightTarget(entity, policy())) {
          lock = undefined
          cooldownUntil = ctx.now + INTERRUPTED_COOLDOWN_MS
          return null
        }
        // Keep the lock through short observation gaps. The attack driver owns
        // target location/line-of-sight; yielding here would let escape/base
        // preempt and restart the same engagement in a loop.
        const fightNow = policy().fight
        return candidate(
          lock.entityId,
          lock.name,
          lock.lastPos,
          engagementIds(world, self.pos, policy, lock.entityId),
          fightNow === null ? undefined : fightNow.leash,
        )
      }

      if (ctx.now < cooldownUntil) return null
      for (const [id, until] of failed) {
        if (until <= ctx.now) failed.delete(id)
      }

      // The entity base sample covers every auto-fight radius (<=8), so no
      // targeted re-read is needed here.
      const targets = world.entitiesIn(boxAround(self.pos, fight.radius, 6))
      const ids: string[] = []
      let best: EntityInfo | undefined
      let bestDistance = Number.POSITIVE_INFINITY
      let preferred: EntityInfo | undefined
      for (const entity of targets) {
        if (failed.has(entity.id)) continue
        if (!isAutoFightTarget(entity, policy())) continue
        if (ctx.canSee?.(entity.id) === false) continue
        const range = distance(self.pos, entity.position)
        if (range > fight.radius) continue
        ids.push(entity.id)
        // Retaliate against whoever just hit us, but only when it passes every
        // other filter: attribution must not widen the auto-fight policy.
        if (ctx.attacker?.id === entity.id) preferred = entity
        if (range < bestDistance) {
          best = entity
          bestDistance = range
        }
      }
      if (preferred !== undefined) best = preferred
      if (best === undefined) return null
      lock = {
        entityId: best.id,
        name: best.name,
        origin: { x: self.pos.x, y: self.pos.y, z: self.pos.z },
        lastPos: best.position,
      }
      return candidate(best.id, best.name, best.position, ids, fight.leash)
    },
    noteTerminal(event: FightTerminal): void {
      const entityId = event.keys.slice('threat.fight:'.length)
      if (entityId.length === 0) return
      lock = undefined
      if (event.state === 'succeeded') {
        // entityDead can arrive before the entity leaves the sensor snapshot.
        // Keep the id out of acquisition long enough for the snapshot to settle.
        failed.set(entityId, event.at + FAILED_TARGET_MS)
        cooldownUntil = event.at + 500
      } else if (event.state === 'failed') {
        failed.set(entityId, event.at + FAILED_TARGET_MS)
        cooldownUntil = event.at + FAILED_COOLDOWN_MS
      } else if (event.state === 'interrupted') {
        cooldownUntil = event.at + INTERRUPTED_COOLDOWN_MS
      }
    },
    reset(): void {
      lock = undefined
      cooldownUntil = 0
      failed.clear()
    },
  }
}

function candidate(
  entityId: string,
  name: string,
  position: Vec3,
  entityIds: string[] = [],
  chaseLeash?: number,
): Candidate {
  const targets = [...new Set([entityId, ...entityIds])].slice(0, 8)
  return {
    driverId: 'attack',
    target: { kind: 'point', pos: position },
    params: {
      entityId,
      entityIds: targets,
      engagement: true,
      ...(targets.length === 1 ? { targetName: name } : {}),
      ...(chaseLeash === undefined ? {} : { chaseLeash }),
      continuationKey: `threat.fight:${entityId}`,
    },
    keys: `threat.fight:${entityId}`,
  }
}

function findEntity(world: WorldView, entityId: string): EntityInfo | undefined {
  return world.entitiesIn(boxAround(world.self.pos, LOCK_QUERY_RADIUS, 16))
    .find(entity => entity.id === entityId)
}

function engagementIds(world: WorldView, self: Vec3, policy: () => ReactionPolicy, primary: string): string[] {
  const fight = policy().fight
  if (fight === null) return [primary]
  const ids = [primary]
  for (const entity of world.entitiesIn(boxAround(self, fight.radius, 6))) {
    if (ids.length >= 8) break
    if (entity.id === primary || !isAutoFightTarget(entity, policy())) continue
    if (distance(self, entity.position) > fight.radius) continue
    ids.push(entity.id)
  }
  return ids
}

function distance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)
}

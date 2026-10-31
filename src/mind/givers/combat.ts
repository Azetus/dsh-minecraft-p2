import type { JsonValue } from '../../contracts/types.ts'
import type { EntityInfo } from '../../port/index.ts'
import { boxAround } from '../sensors.ts'
import type { Candidate, EvalCtx, WorkGiver, WorldView } from '../types.ts'

type OrderView = {
  order: { id: string; verb: string; params?: Record<string, JsonValue> }
}

function activeOrder(active: () => OrderView | undefined, verb: string): OrderView | undefined {
  const current = active()
  return current?.order.verb === verb ? current : undefined
}

function canonicalName(name: string): string {
  return name.replace(/^minecraft:/u, '')
}

function allowedNames(params: Record<string, JsonValue> | undefined): Set<string> {
  const raw = params?.allowedTargets ?? params?.targets
  if (!Array.isArray(raw)) return new Set()
  return new Set(raw.filter((name): name is string => typeof name === 'string').map(canonicalName))
}

function isProtected(entity: EntityInfo): boolean {
  if (entity.type === 'player') return true
  const kind = entity.kind ?? ''
  return /passive|neutral|tameable/i.test(kind)
}

function isHostile(entity: EntityInfo): boolean {
  return entity.type === 'hostile' || /hostile/i.test(entity.kind ?? '')
}

function nearest(entities: EntityInfo[], self: { x: number; y: number; z: number }): EntityInfo | undefined {
  let best: EntityInfo | undefined
  let distance = Number.POSITIVE_INFINITY
  for (const entity of entities) {
    const candidate = Math.hypot(
      entity.position.x - self.x,
      entity.position.y - self.y,
      entity.position.z - self.z,
    )
    if (candidate < distance) {
      best = entity
      distance = candidate
    }
  }
  return best
}

/** Explicit `attack` order: exactly the Agent-named entity, no acquisition. */
export function createAttackOrderGiver(active: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.attack',
    find(_ctx: EvalCtx, world: WorldView): Candidate | null {
      const current = activeOrder(active, 'attack')
      if (current === undefined) return null
      const entityId = current.order.params?.entityId
      if (typeof entityId !== 'string' || entityId.length === 0) return null
      const entity = world.entitiesIn(boxAround(world.self.pos, 32, 8))
        .find(candidate => candidate.id === entityId)
      if (entity === undefined || isProtected(entity)) return null
      return {
        driverId: 'attack',
        target: { kind: 'point', pos: entity.position },
        params: {
          entityId: entity.id,
          targetName: entity.name,
          orderId: current.order.id,
        },
        keys: `order.attack:${current.order.id}:${entity.id}`,
      }
    },
  }
}

/**
 * Explicit `combat` order: acquire only the Agent's allowed hostiles in a
 * bounded radius. Players/neutrals are protected even if listed.
 */
export function createCombatGiver(active: () => OrderView | undefined): WorkGiver {
  return {
    id: 'order.combat',
    find(_ctx: EvalCtx, world: WorldView): Candidate | null {
      const current = activeOrder(active, 'combat')
      if (current === undefined) return null
      const allowed = allowedNames(current.order.params)
      if (allowed.size === 0) return null
      const radius = typeof current.order.params?.radius === 'number'
        ? Math.max(1, Math.min(16, Math.floor(current.order.params.radius)))
        : 8
      const entities = world.entitiesIn(boxAround(world.self.pos, radius, 4))
        .filter(entity => isHostile(entity) && !isProtected(entity) && allowed.has(canonicalName(entity.name)))
      const target = nearest(entities, world.self.pos)
      if (target === undefined) return null
      return {
        driverId: 'attack',
        target: { kind: 'point', pos: target.position },
        params: {
          entityId: target.id,
          targetName: target.name,
          orderId: current.order.id,
        },
        keys: `order.combat:${current.order.id}:${target.id}`,
      }
    },
  }
}

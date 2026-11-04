import type { EntityInfo, Vec3 } from '../../port/index.ts'
import { nearestStandCell } from '../../motion/search/index.ts'
import type { BaseActivityController } from '../base-activity.ts'
import { boxAround } from '../sensors.ts'
import { createReadOnlyMotionWorld } from '../standing.ts'
import type { Candidate, EvalCtx, Handoff, WorkGiver, WorkGiverResult, WorldView } from '../types.ts'
import { feetOf, moveCandidate } from './common.ts'

const ESCORT_LOOKUP_RADIUS = 48
const ESCORT_LOOKUP_VERTICAL = 16
const WANDER_MIN_DISTANCE = 0.9
const REACH_NODES = 192

/**
 * The default activity giver. It is below `duty.work` in the main tree and only
 * selects a bounded local move: it never digs, places, attacks, or creates a
 * task. The controller owns the anchor and the decision cadence.
 */
export function createBaseActivityGiver(base: BaseActivityController): WorkGiver {
  return {
    id: 'base.work',
    find(ctx: EvalCtx, world: WorldView): WorkGiverResult {
      if (!base.isActive()) return null
      const view = base.view()
      if (view.kind === 'idle') return null
      if (view.kind === 'wandering') return wander(base, ctx, world, view.params.radius ?? 8)
      return escort(base, ctx, world, view.params.target ?? '', view.params.distance ?? 3)
    },
  }
}

function wander(
  base: BaseActivityController,
  ctx: EvalCtx,
  world: WorldView,
  radius: number,
): Candidate | Handoff | null {
  if (!base.shouldDecide(ctx.now)) return null
  const anchor = base.anchor()
  const feet = feetOf(world.self.pos)
  if (anchor === undefined) {
    base.noteFailure(ctx.now)
    return null
  }
  const seq = base.nextSequence()
  const angle = (seq * 2.399963229728653) % (Math.PI * 2)
  const span = Math.max(1, radius)
  const distance = 1 + (seq * 37) % span
  const desired: Vec3 = {
    x: anchor.x + Math.round(Math.cos(angle) * distance),
    y: anchor.y,
    z: anchor.z + Math.round(Math.sin(angle) * distance),
  }
  const query = nearestStandCell(
    createReadOnlyMotionWorld(point => world.blockAt(point)),
    {
      near: anchor,
      desired,
      reach: { horizontal: radius, vertical: 2 },
      accept: cell => {
        const flat = Math.hypot(cell.x - anchor.x, cell.z - anchor.z)
        return flat >= WANDER_MIN_DISTANCE && flat <= radius + 0.5
      },
    },
    { from: feet, reachability: { maxNodes: REACH_NODES } },
  )
  const best = query.best
  if (best === undefined) {
    base.noteFailure(ctx.now)
    return null
  }
  if (best.cell.x === feet.x && best.cell.y === feet.y && best.cell.z === feet.z) {
    base.noteArrival(ctx.now)
    return null
  }
  // Keep the offered delay short; the body records the real arrival/failure
  // after the move job settles.
  base.scheduleNext(ctx.now, 6_000)
  return moveCandidate(
    { x: best.cell.x, y: best.cell.y, z: best.cell.z },
    `base:wander:${anchor.x},${anchor.y},${anchor.z}:${seq}`,
    8_000,
  )
}

function escort(
  base: BaseActivityController,
  ctx: EvalCtx,
  world: WorldView,
  target: string,
  distance: number,
): Candidate | Handoff | null {
  if (target.length === 0) return null
  const self = world.self
  let entity = findTarget(world, target)
  if (entity === undefined && base.lookupDue(ctx.now)) {
    ctx.observeEntities?.(boxAround(self.pos, ESCORT_LOOKUP_RADIUS, ESCORT_LOOKUP_VERTICAL))
    base.noteLookup(ctx.now)
    entity = findTarget(world, target)
  }
  if (entity === undefined) {
    base.markWaiting('TARGET_LOST', ctx.now)
    return null
  }
  base.clearWaiting(ctx.now)
  const flat = Math.hypot(
    entity.position.x - self.pos.x,
    entity.position.z - self.pos.z,
  )
  if (flat <= distance + 1) return null
  if (!base.shouldDecide(ctx.now)) return null

  const targetCell = feetOf(entity.position)
  const query = nearestStandCell(
    createReadOnlyMotionWorld(point => world.blockAt(point)),
    {
      near: targetCell,
      desired: feetOf(self.pos),
      reach: { horizontal: Math.max(1, Math.min(8, Math.floor(distance))), vertical: 2 },
    },
    { from: feetOf(self.pos), reachability: { maxNodes: REACH_NODES } },
  )
  const best = query.best
  if (best === undefined) {
    base.scheduleNext(ctx.now, 2_000)
    return null
  }
  base.scheduleNext(ctx.now, 750)
  const key = `${best.cell.x},${best.cell.y},${best.cell.z}`
  // Exact arrival: a range-1 goal can stop one cell short of the chosen escort
  // cell, leaving the body permanently just outside the follow distance.
  return moveCandidate(
    { x: best.cell.x, y: best.cell.y, z: best.cell.z },
    `base:escort:${target}:${key}`,
    8_000,
    0,
  )
}

function findTarget(world: WorldView, target: string): EntityInfo | undefined {
  const normalized = target.replace(/^minecraft:/u, '')
  const self = world.self.pos
  return world.entitiesIn(boxAround(self, ESCORT_LOOKUP_RADIUS, ESCORT_LOOKUP_VERTICAL))
    .filter(entity => entity.username === normalized || entity.name === normalized)
    .sort((left, right) => flatDistance(left.position, self) - flatDistance(right.position, self))[0]
}

function flatDistance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.z - right.z)
}

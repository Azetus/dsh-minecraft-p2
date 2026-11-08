import type { EntityInfo, Vec3 } from '../../port/index.ts'
import { nearestStandCell, standCells } from '../../motion/search/index.ts'
import type { BaseActivityController } from '../base-activity.ts'
import { boxAround } from '../sensors.ts'
import { createReadOnlyMotionWorld } from '../standing.ts'
import type { Candidate, EvalCtx, Handoff, WorkGiver, WorkGiverResult, WorldView } from '../types.ts'
import { feetOf, moveCandidate, standability } from './common.ts'

const WANDER_MIN_DISTANCE = 0.9
const REACH_NODES = 192

/**
 * Escort is a known-target follow, not an area search: the mind resolves the
 * target through the adapter's identity index every tick, so there is no
 * client-side distance cap. The server's entity tracking range is the only
 * visibility limit, and a bounded last-known chase covers the moment it drops.
 */
const ESCORT_RECHECK_MS = 750
const ESCORT_MOVE_TIMEOUT_MS = 25_000
export const ESCORT_LOST_GRACE_MS = 2_000
/** Snapshot fallback bounds for adapters without an identity index. */
const ESCORT_FALLBACK_RADIUS = 48
const ESCORT_FALLBACK_VERTICAL = 16

type EscortState = {
  target?: string
  /** Time of the last real resolution; -Infinity means never seen. */
  lastSeenAt: number
  /** Last resolved feet cell, used for the bounded chase after a loss. */
  lastKnown?: Vec3 | undefined
}

/**
 * The default activity giver. It is below `duty.work` in the main tree and only
 * selects a bounded local move: it never digs, places, attacks, or creates a
 * task. The controller owns the anchor and the decision cadence.
 */
export function createBaseActivityGiver(base: BaseActivityController): WorkGiver {
  const escortState: EscortState = { lastSeenAt: Number.NEGATIVE_INFINITY }
  return {
    id: 'base.work',
    find(ctx: EvalCtx, world: WorldView): WorkGiverResult {
      if (!base.isActive()) return null
      const view = base.view()
      if (view.kind === 'idle') return null
      if (view.kind === 'wandering') return wander(base, ctx, world, view.params.radius ?? 8)
      return escort(base, ctx, world, view.params.target ?? '', view.params.distance ?? 3, escortState)
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
  state: EscortState,
): Candidate | Handoff | null {
  if (target.length === 0) return null
  if (state.target !== target) {
    state.target = target
    state.lastSeenAt = Number.NEGATIVE_INFINITY
    state.lastKnown = undefined
  }

  const self = world.self
  const focused = ctx.focus !== undefined && matchesTarget(ctx.focus, target) ? ctx.focus : undefined
  const entity = focused ?? findTarget(world, target)
  if (entity !== undefined) {
    state.lastSeenAt = ctx.now
    state.lastKnown = feetOf(entity.position)
    base.clearWaiting(ctx.now)
    const flat = Math.hypot(entity.position.x - self.pos.x, entity.position.z - self.pos.z)
    if (flat <= distance + 1) return null
    if (!base.shouldDecide(ctx.now)) return null
    const goal = escortGoal(world, entity, distance, self.pos)
    base.scheduleNext(ctx.now, ESCORT_RECHECK_MS)
    const key = `${goal.cell.x},${goal.cell.y},${goal.cell.z}`
    return moveCandidate(
      goal.cell,
      `base:escort:${target}:${key}`,
      ESCORT_MOVE_TIMEOUT_MS,
      goal.exact ? 0 : followRange(distance),
    )
  }

  // The target is not visible this tick. Inside the grace window keep walking
  // to where it was last seen; only a sustained loss becomes TARGET_LOST.
  if (ctx.now - state.lastSeenAt < ESCORT_LOST_GRACE_MS && state.lastKnown !== undefined) {
    if (!base.shouldDecide(ctx.now)) return null
    base.scheduleNext(ctx.now, ESCORT_RECHECK_MS)
    const last = state.lastKnown
    return moveCandidate(
      last,
      `base:escort:${target}:chase:${last.x},${last.y},${last.z}`,
      ESCORT_MOVE_TIMEOUT_MS,
      followRange(distance),
    )
  }

  base.markWaiting('TARGET_LOST', ctx.now)
  return null
}

/**
 * A stand cell within the follow distance is an exact-arrival goal, so the body
 * does not stop one cell outside the intended gap. When the target is outside
 * the block snapshot (or its cell is not standable), the goal falls back to the
 * target point itself and lets the move driver stop within `range`: the actual
 * path runs on the provider's live world, not on the bounded snapshot.
 */
function escortGoal(
  world: WorldView,
  entity: EntityInfo,
  distance: number,
  selfPos: Vec3,
): { cell: Vec3; exact: boolean } {
  const targetCell = feetOf(entity.position)
  if (standability(world, targetCell).state !== 'unknown') {
    const range = followRange(distance)
    const query = standCells(
      createReadOnlyMotionWorld(point => world.blockAt(point)),
      {
        near: targetCell,
        desired: feetOf(selfPos),
        reach: { horizontal: range, vertical: 2 },
        // A box reach can put a corner candidate outside the follow gap. Filter
        // by true horizontal distance so the exact goal is really within it;
        // otherwise the body stands at the corner and re-issues the same move
        // every 750ms.
        accept: cell => Math.hypot(cell.x - targetCell.x, cell.z - targetCell.z) <= distance + 0.5,
      },
      { from: feetOf(selfPos), reachability: { maxNodes: REACH_NODES } },
    )
    const pick = query.cells.find(candidate => candidate.reachable !== 'no') ?? query.cells[0]
    if (pick !== undefined) return { cell: pick.cell, exact: true }
  }
  return { cell: targetCell, exact: false }
}

function followRange(distance: number): number {
  return Math.max(1, Math.min(8, Math.floor(distance)))
}

function matchesTarget(entity: EntityInfo, target: string): boolean {
  const wanted = target.replace(/^minecraft:/u, '')
  return entity.username === wanted || entity.name === wanted
}

function findTarget(world: WorldView, target: string): EntityInfo | undefined {
  const wanted = target.replace(/^minecraft:/u, '')
  const self = world.self.pos
  return world.entitiesIn(boxAround(self, ESCORT_FALLBACK_RADIUS, ESCORT_FALLBACK_VERTICAL))
    .filter(entity => entity.username === wanted || entity.name === wanted)
    .sort((left, right) => flatDistance(left.position, self) - flatDistance(right.position, self))[0]
}

function flatDistance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.z - right.z)
}

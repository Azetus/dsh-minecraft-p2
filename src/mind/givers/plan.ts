import type { JsonValue } from '../../contracts/types.ts'
import type { Vec3 } from '../../port/index.ts'
import { planBuildAccess, interiorBounds } from '../build-access.ts'
import { evaluatePlan, isAirName, isFluidName, itemPosition } from '../plan.ts'
import type { PlanInstance, WorkItem } from '../plan.ts'
import { canClearBlock } from '../policy.ts'
import type { Candidate, EvalCtx, Handoff, WorkGiver, WorkGiverResult, WorldView } from '../types.ts'
import { nearestStandable, isStandable } from './common.ts'

/**
 * Plan work giver: walks all work items, returns the first executable one, and
 * hands off a short move when the only obstacle is reach. It never picks a
 * different target or executes.
 */
export function createPlanGiver(): WorkGiver {
  return {
    id: 'plan.work',
    find(ctx: EvalCtx, world: WorldView): WorkGiverResult {
      const plan = ctx.plan
      if (plan === undefined) return null

      const evaluation = evaluatePlan(plan, world, ctx.conflictPolicy)
      const access = planBuildAccess(plan, world, world.self.pos)
      if (access.blocked !== undefined) {
        return {
          kind: 'hold',
          reason: 'BUILD_ACCESS_BLOCKED',
          notify: true,
          data: {
            planId: plan.planId,
            reason: access.blocked.reason,
            detail: access.blocked.detail,
            workItems: plan.workItems.map(item => item.id),
          },
        }
      }
      const deferred = plan.deferredWorkItems === undefined
        ? access.deferred
        : new Set(plan.deferredWorkItems)
      // Leave the temporary entrance open until every other work item is done.
      // This is geometry-derived, not tied to any block name or material.
      const pendingNonDeferred = plan.workItems.some(item => !deferred.has(item.id)
        && evaluation.states.get(item.id)?.kind !== 'satisfied')
      // A clear policy turns an occupied place target into a clear handoff.
      // Fluids are not cleared: they remain a place attempt.
      if (ctx.conflictPolicy?.mode === 'clear') {
        for (const item of plan.workItems) {
          if (item.expected === undefined) continue
          const state = evaluation.states.get(item.id)
          if (state?.kind !== 'blocked' || state.reason !== 'CONFLICT') continue
          const position = itemPosition(plan, item)
          const current = world.blockAt(position)
          if (current === null || !current.loaded) continue
          if (isAirName(current.name) || isFluidName(current.name)) continue
          if (!canClearBlock(ctx.conflictPolicy, current.name)) continue
          const handoff: Handoff = {
            driverId: 'clear',
            target: { kind: 'point', pos: position },
            params: { x: position.x, y: position.y, z: position.z },
            reason: `clear conflict ${item.id}`,
            orderId: plan.orderId,
          }
          const key = `handoff:clear:${position.x},${position.y},${position.z}`
          if (ctx.isBlocked?.(key) === true) continue
          return handoff
        }
      }
      // A place target that coincides with the body cannot be placed; step
      // aside first. This also repairs an approach that ended on the cell.
      for (const item of plan.workItems) {
        const state = evaluation.states.get(item.id)
        if (state?.kind !== 'executable' || state.driverId !== 'place') continue
        const position = itemPosition(plan, item)
        const feet = world.self.pos
        if (Math.floor(feet.x) !== position.x || Math.floor(feet.z) !== position.z) continue
        if (Math.floor(feet.y) !== position.y && Math.floor(feet.y) !== position.y + 1) continue
        const stand = nearestStandable(world, position, 2, position, 1, position)
        if (stand === undefined) continue
        const handoff: Handoff = {
          driverId: 'move',
          target: { kind: 'point', pos: stand },
          params: { x: stand.x, y: stand.y, z: stand.z, range: 0, exact: true, timeoutMs: 8_000 },
          reason: `step aside ${item.id}`,
          orderId: plan.orderId,
        }
        const key = `handoff:move:${stand.x},${stand.y},${stand.z}`
        if (ctx.isBlocked?.(key) !== true) return handoff
      }
      // Enter through the still-open temporary entrance before placing
      // interior/roof work. This is an explicit access step, not a generic
      // "move to the block" fallback.
      if (plan.entranceInside !== undefined && !inInterior(plan, world.self.pos)
        && isStandable(world, plan.entranceInside)
        && ctx.isBlocked?.(`handoff:enter:${plan.planId}`) !== true) {
        return {
          driverId: 'move',
          target: { kind: 'point', pos: plan.entranceInside },
          params: {
            x: plan.entranceInside.x,
            y: plan.entranceInside.y,
            z: plan.entranceInside.z,
            range: 0,
            intent: 'interact',
            timeoutMs: 8_000,
          },
          reason: 'enter build interior',
          orderId: plan.orderId,
        }
      }
      // Iterate all items: a key blocked by repeated failures is skipped, and
      // the next executable item is still offered.
      for (const item of plan.workItems) {
        const state = evaluation.states.get(item.id)
        if (state?.kind !== 'executable') continue
        if (pendingNonDeferred && deferred.has(item.id)) continue
        const candidate = candidateFor(plan, item, state.driverId)
        if (ctx.isBlocked?.(candidate.keys) === true) continue
        return candidate
      }
      if (evaluation.satisfied) return null

      // The item may be outside the sensor box. Walk toward it before calling
      // it unreachable: the next snapshot will load those blocks.
      const unknown = plan.workItems.find(item => !(pendingNonDeferred && deferred.has(item.id))
        && evaluation.states.get(item.id)?.kind === 'unknown')
      if (unknown !== undefined) {
        const position = itemPosition(plan, unknown)
        // Moving to the work cell itself can be "arrived" without loading it
        // (range 4). Move to a standable neighbour so the next snapshot sees
        // the cell and the plan can decide executable vs blocked.
        const stand = standableFor(plan, world, position)
        const target = stand ?? position
        const handoff: Handoff = {
          driverId: 'move',
          target: { kind: 'point', pos: target },
          params: {
            x: target.x,
            y: target.y,
            z: target.z,
            range: stand === undefined ? 4 : 0,
            intent: 'interact',
            timeoutMs: 10_000,
          },
          reason: `approach ${unknown.id}`,
          orderId: plan.orderId,
        }
        const key = `handoff:${handoff.driverId}:${target.x},${target.y},${target.z}`
        if (ctx.isBlocked?.(key) !== true) return handoff
      }

      const unreachable = plan.workItems.filter(item => {
        if (pendingNonDeferred && deferred.has(item.id)) return false
        const state = evaluation.states.get(item.id)
        return state?.kind === 'blocked' && (state as { reason?: string }).reason === 'UNREACHABLE'
      })
      for (const item of unreachable) {
        const target = itemPosition(plan, item)
        // The navigation goal selects a reachable standing cell within block
        // interaction reach, excluding the work cell itself.
        const stand = standableFor(plan, world, target)
        if (stand === undefined) continue
        const handoff: Handoff = {
          driverId: 'move',
          target: { kind: 'point', pos: stand },
          params: { x: stand.x, y: stand.y, z: stand.z, range: 0, intent: 'interact', timeoutMs: 8_000 },
          reason: `reach ${item.id}`,
          orderId: plan.orderId,
        }
        const handoffKey = `handoff:${handoff.driverId}:${stand.x},${stand.y},${stand.z}`
        if (ctx.isBlocked?.(handoffKey) === true) continue
        return handoff
      }
      if (evaluation.blocked) return { kind: 'hold', reason: 'PLAN_BLOCKED', notify: false }
      return null
    },
  }
}

function candidateFor(plan: PlanInstance, item: WorkItem, driverId: string): Candidate {
  const position = itemPosition(plan, item)
  const params: Record<string, JsonValue> = { x: position.x, y: position.y, z: position.z }
  if ((item.kind === 'place' || item.kind === 'hold') && item.expected !== undefined) {
    params.item = item.expected.name
    if (item.expected.state !== undefined) params.expectedState = item.expected.state
  }
  if (item.kind === 'prepare' || item.kind === 'enter') params.range = 1
  return {
    driverId,
    target: { kind: 'point', pos: position },
    params,
    keys: `plan:${plan.planId}:${item.id}`,
    orderId: plan.orderId,
  }
}

function inInterior(plan: PlanInstance, pos: Vec3): boolean {
  const interior = interiorBounds(plan)
  return Math.floor(pos.x) >= interior.min.x && Math.floor(pos.x) <= interior.max.x
    && Math.floor(pos.y) >= interior.min.y && Math.floor(pos.y) <= interior.max.y
    && Math.floor(pos.z) >= interior.min.z && Math.floor(pos.z) <= interior.max.z
}

/**
 * Work over the interior is best approached from inside. In particular, a
 * roof cell cannot be placed through a wall from outside; prefer an interior
 * standable cell when the target's x/z lies over the room.
 */
function standableFor(plan: PlanInstance, world: WorldView, target: Vec3): Vec3 | undefined {
  const interior = interiorBounds(plan)
  const overInterior = target.x >= interior.min.x && target.x <= interior.max.x
    && target.z >= interior.min.z && target.z <= interior.max.z
  // Roof/wall cells just outside the interior still need an interior stand:
  // placing them from outside is blocked by the shell or has no sight line.
  const nearInterior = target.x >= interior.min.x - 1 && target.x <= interior.max.x + 1
    && target.z >= interior.min.z - 1 && target.z <= interior.max.z + 1
    && target.y >= interior.min.y - 1 && target.y <= interior.max.y + 1
  if (overInterior || nearInterior) {
    let best: Vec3 | undefined
    let bestDistance = Number.POSITIVE_INFINITY
    for (let x = interior.min.x; x <= interior.max.x; x += 1) {
      for (let z = interior.min.z; z <= interior.max.z; z += 1) {
        for (let y = interior.min.y; y <= interior.max.y; y += 1) {
          const cell = { x, y, z }
          if (!isStandable(world, cell)) continue
          const distance = Math.hypot(cell.x - target.x, cell.y - target.y, cell.z - target.z)
          if (distance < bestDistance) {
            best = cell
            bestDistance = distance
          }
        }
      }
    }
    if (best !== undefined) return best
  }
  return nearestStandable(world, target, 3, target, 3, target)
}

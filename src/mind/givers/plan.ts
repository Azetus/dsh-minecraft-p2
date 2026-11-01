import type { JsonValue } from '../../contracts/types.ts'
import { evaluatePlan, isAirName, isFluidName, itemPosition } from '../plan.ts'
import type { PlanInstance, WorkItem } from '../plan.ts'
import { canClearBlock } from '../policy.ts'
import type { Candidate, EvalCtx, Handoff, WorkGiver, WorkGiverResult, WorldView } from '../types.ts'
import { nearestStandable } from './common.ts'

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
        }
        const key = `handoff:move:${stand.x},${stand.y},${stand.z}`
        if (ctx.isBlocked?.(key) !== true) return handoff
      }
      // Iterate all items: a key blocked by repeated failures is skipped, and
      // the next executable item is still offered.
      for (const item of plan.workItems) {
        const state = evaluation.states.get(item.id)
        if (state?.kind !== 'executable') continue
        const candidate = candidateFor(plan, item, state.driverId)
        if (ctx.isBlocked?.(candidate.keys) === true) continue
        return candidate
      }
      if (evaluation.satisfied) return null

      // The item may be outside the sensor box. Walk toward it before calling
      // it unreachable: the next snapshot will load those blocks.
      const unknown = plan.workItems.find(item => evaluation.states.get(item.id)?.kind === 'unknown')
      if (unknown !== undefined) {
        const position = itemPosition(plan, unknown)
        const handoff: Handoff = {
          driverId: 'move',
          target: { kind: 'point', pos: position },
          params: { x: position.x, y: position.y, z: position.z, range: 4, intent: 'interact', timeoutMs: 10_000 },
          reason: `approach ${unknown.id}`,
        }
        const key = `handoff:${handoff.driverId}:${position.x},${position.y},${position.z}`
        if (ctx.isBlocked?.(key) !== true) return handoff
      }

      const unreachable = plan.workItems.filter(item => {
        const state = evaluation.states.get(item.id)
        return state?.kind === 'blocked' && (state as { reason?: string }).reason === 'UNREACHABLE'
      })
      for (const item of unreachable) {
        const target = itemPosition(plan, item)
        // The navigation goal selects a reachable standing cell within block
        // interaction reach, excluding the work cell itself.
        const handoff: Handoff = {
          driverId: 'move',
          target: { kind: 'point', pos: target },
          params: { x: target.x, y: target.y, z: target.z, range: 4, intent: 'interact', timeoutMs: 8_000 },
          reason: `reach ${item.id}`,
        }
        const handoffKey = `handoff:${handoff.driverId}:${target.x},${target.y},${target.z}`
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
  }
}

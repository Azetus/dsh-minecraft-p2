import type { JsonValue } from '../../contracts/types.ts'
import { evaluatePlan, itemPosition } from '../plan.ts'
import type { PlanInstance, WorkItem } from '../plan.ts'
import type { Candidate, EvalCtx, Handoff, WorkGiver, WorldView } from '../types.ts'
import { nearestStandable } from './common.ts'

/**
 * Plan work giver: walks all work items, returns the first executable one, and
 * hands off a short move when the only obstacle is reach. It never picks a
 * different target or executes.
 */
export function createPlanGiver(): WorkGiver {
  return {
    id: 'plan.work',
    find(ctx: EvalCtx, world: WorldView): Candidate | Handoff | null {
      const plan = ctx.plan
      if (plan === undefined) return null

      const evaluation = evaluatePlan(plan, world)
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

      const unreachable = plan.workItems.filter(item => {
        const state = evaluation.states.get(item.id)
        return state?.kind === 'blocked' && (state as { reason?: string }).reason === 'UNREACHABLE'
      })
      for (const item of unreachable) {
        const target = itemPosition(plan, item)
        // Stand next to the work item, not merely somewhere near the current
        // body: a stand three blocks away can still be out of reach.
        const stand = nearestStandable(world, target, 2, target, 1)
        if (stand === undefined) continue
        const handoff: Handoff = {
          driverId: 'move',
          target: { kind: 'point', pos: stand },
          params: { x: stand.x, y: stand.y, z: stand.z, range: 1, timeoutMs: 8_000 },
          reason: `reach ${item.id}`,
        }
        const handoffKey = `handoff:${handoff.driverId}:${stand.x},${stand.y},${stand.z}`
        if (ctx.isBlocked?.(handoffKey) === true) continue
        return handoff
      }
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

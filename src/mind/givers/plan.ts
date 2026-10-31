import type { JsonValue } from '../../contracts/types.ts'
import { evaluatePlan, itemPosition } from '../plan.ts'
import type { PlanInstance, WorkItem } from '../plan.ts'
import type { Candidate, EvalCtx, Handoff, WorkGiver, WorldView } from '../types.ts'
import { feetOf, nearestStandable } from './common.ts'

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
      if (evaluation.next !== undefined && evaluation.next.state.kind === 'executable') {
        const item = evaluation.next.item
        return candidateFor(plan, item, evaluation.next.state.driverId)
      }
      if (evaluation.satisfied) return null

      const unreachable = plan.workItems.find(item => evaluation.states.get(item.id)?.kind === 'blocked'
        && (evaluation.states.get(item.id) as { reason?: string }).reason === 'UNREACHABLE')
      if (unreachable === undefined) return null

      const target = itemPosition(plan, unreachable)
      const self = feetOf(world.self.pos)
      const stand = nearestStandable(world, target, 3, self, 2)
      if (stand === undefined) return null
      return {
        driverId: 'move',
        target: { kind: 'point', pos: stand },
        params: { x: stand.x, y: stand.y, z: stand.z, range: 1, timeoutMs: 8_000 },
        reason: `reach ${unreachable.id}`,
      }
    },
  }
}

function candidateFor(plan: PlanInstance, item: WorkItem, driverId: string): Candidate {
  const position = itemPosition(plan, item)
  const params: Record<string, JsonValue> = { x: position.x, y: position.y, z: position.z }
  if ((item.kind === 'place' || item.kind === 'hold') && item.expected !== undefined) {
    params.item = item.expected.name
  }
  if (item.kind === 'prepare' || item.kind === 'enter') params.range = 1
  return {
    driverId,
    target: { kind: 'point', pos: position },
    params,
    keys: `plan:${plan.planId}:${item.id}`,
  }
}

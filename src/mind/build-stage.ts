import { interiorBounds } from './build-access.ts'
import { itemPosition } from './plan.ts'
import type { PlanInstance, WorkItem, WorkState } from './plan.ts'

/**
 * Geometry-only build staging. No block types are involved: the floor is below
 * the interior, the lower shell is reachable from outside, the upper shell and
 * roof need the interior, interior furniture comes after the shell, and the
 * temporary entrance is closed last. A stage is a hard barrier: work items from
 * a later stage are never offered before every earlier stage is satisfied.
 */
export const STAGE_COUNT = 5

export type StageSummary = {
  stage: number
  total: number
  satisfied: number
  executable: number
  blocked: number
  unknown: number
  /** Pending = not satisfied. */
  pending: number
  done: boolean
}

export function buildStage(plan: PlanInstance, item: WorkItem, deferred: ReadonlySet<string>): number {
  if (deferred.has(item.id)) return STAGE_COUNT
  const at = itemPosition(plan, item)
  // Without a verifier there is no declared interior: stage 4 does not exist
  // and the vertical geometry alone orders the build.
  if (plan.verify !== undefined) {
    const interior = interiorBounds(plan)
    if (at.x >= interior.min.x && at.x <= interior.max.x
      && at.y >= interior.min.y && at.y <= interior.max.y
      && at.z >= interior.min.z && at.z <= interior.max.z) return 4
  }
  const interior = interiorBounds(plan)
  if (at.y < interior.min.y) return 1
  if (at.y <= interior.min.y + 1) return 2
  return 3
}

export function stageItems(
  plan: PlanInstance,
  deferred: ReadonlySet<string>,
  stage: number,
): WorkItem[] {
  return plan.workItems.filter(item => buildStage(plan, item, deferred) === stage)
}

/** Lowest stage that still has pending work; 5 when everything is satisfied. */
export function currentStage(
  plan: PlanInstance,
  deferred: ReadonlySet<string>,
  states: ReadonlyMap<string, WorkState>,
): number {
  let current = STAGE_COUNT
  for (const item of plan.workItems) {
    if (states.get(item.id)?.kind === 'satisfied') continue
    current = Math.min(current, buildStage(plan, item, deferred))
  }
  return current
}

export function stageSummaries(
  plan: PlanInstance,
  deferred: ReadonlySet<string>,
  states: ReadonlyMap<string, WorkState>,
): StageSummary[] {
  const summaries: StageSummary[] = []
  for (let stage = 1; stage <= STAGE_COUNT; stage += 1) {
    const items = stageItems(plan, deferred, stage)
    const summary: StageSummary = {
      stage,
      total: items.length,
      satisfied: 0,
      executable: 0,
      blocked: 0,
      unknown: 0,
      pending: 0,
      done: true,
    }
    for (const item of items) {
      const state = states.get(item.id)
      if (state?.kind === 'satisfied') summary.satisfied += 1
      else if (state?.kind === 'executable') summary.executable += 1
      else if (state?.kind === 'blocked') summary.blocked += 1
      else if (state?.kind === 'unknown') summary.unknown += 1
      if (state?.kind !== 'satisfied') {
        summary.pending += 1
        summary.done = false
      }
    }
    summaries.push(summary)
  }
  return summaries
}

/** Stable identity for stage progress events. */
export function stageKey(summaries: StageSummary[], current: number): string {
  return `${current}:${summaries
    .map(summary => `${summary.stage}/${summary.satisfied}/${summary.blocked}/${summary.unknown}`)
    .join('|')}`
}

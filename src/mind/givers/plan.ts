import type { JsonValue } from '../../contracts/types.ts'
import type { Vec3 } from '../../body/api.ts'
import { interiorBounds, planBuildAccess } from '../build-access.ts'
import { buildStage, currentStage, stageItems, stageSummaries } from '../build-stage.ts'
import { evaluatePlan, isAirName, isFluidName, itemCells, itemPosition } from '../plan.ts'
import type { PlanInstance, WorkItem } from '../plan.ts'
import { canClearBlock } from '../policy.ts'
import { itemObservationBox } from '../plan-observation.ts'
import { MAX_ITEM_STANCES, MAX_STANCE_CANDIDATES, MAX_STANCE_TRIES, PlanItemLedger, placementStances, stepAsideStances } from '../placement.ts'
import type { StanceRejection } from '../placement.ts'
import type { Candidate, EvalCtx, Handoff, WorkGiver, WorkGiverResult, WorldView } from '../types.ts'
import { isStandable, nearestStandable } from './common.ts'

/**
 * Plan work giver: offers the first executable item of the current build stage
 * and hands off the movement it needs. It never picks a different target and
 * never executes.
 *
 * Failure identity is per `(plan, work item, stance)` in a `PlanItemLedger`, not
 * a plan-wide stance set: a stance that failed for one cell must not empty the
 * candidate pool of another cell. An item that cannot be placed is blocked with
 * a concrete reason and the next item is offered; only a stage with no
 * advanceable item is reported upward.
 */
export function createPlanGiver(options: { ledger?: PlanItemLedger } = {}): WorkGiver {
  const ledger = options.ledger ?? new PlanItemLedger()
  return {
    id: 'plan.work',
    find(ctx: EvalCtx, world: WorldView): WorkGiverResult {
      const plan = ctx.plan
      if (plan === undefined) return null
      const deferred = plan.deferredWorkItems === undefined
        ? planBuildAccess(plan, world, world.self.pos).deferred
        : new Set(plan.deferredWorkItems)

      let evaluation = evaluatePlan(plan, world, ctx.conflictPolicy)
      // Unknown is resolved by a targeted internal re-read, not by moving:
      // `moveTo arrived` proved nothing and used to loop forever.
      const unknownItems = () => plan.workItems
        .filter(item => evaluation.states.get(item.id)?.kind === 'unknown')
      if (unknownItems().length > 0 && ctx.observe !== undefined) {
        for (const item of unknownItems()) ctx.observe(itemObservationBox(plan, item))
        evaluation = evaluatePlan(plan, world, ctx.conflictPolicy)
      }
      // Refresh the ledger for every stage item so a changed world clears an
      // earlier block; only this stage is consulted below.
      for (const item of plan.workItems) {
        ledger.entry(plan, item, buildStage(plan, item, deferred), itemPosition(plan, item), world)
      }

      if (evaluation.satisfied) return null
      const states = evaluation.states
      const summaries = stageSummaries(plan, deferred, states)
      const stage = currentStage(plan, deferred, states)
      const items = stageItems(plan, deferred, stage)

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

      // A clear policy turns an occupied place target into a clear handoff.
      if (ctx.conflictPolicy?.mode === 'clear') {
        for (const item of items) {
          if (item.expected === undefined) continue
          const state = states.get(item.id)
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
            workItemId: item.id,
          }
          const key = `handoff:clear:${position.x},${position.y},${position.z}`
          if (ctx.isBlocked?.(key) === true) continue
          return handoff
        }
      }

      // Furniture is placed from inside; entering is only forced at that point.
      if (stage >= 4 && plan.entranceInside !== undefined && !inInterior(plan, world.self.pos)
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
            timeoutMs: 8_000,
          },
          reason: 'enter build interior',
          orderId: plan.orderId,
        }
      }

      let underBody: WorkItem | undefined
      for (const item of items) {
        const state = states.get(item.id)
        if (state?.kind !== 'executable') continue
        if (ledger.blocked(plan, item) !== undefined) continue
        if (item.kind !== 'place' && item.kind !== 'hold') {
          // A non-place item has no stance pool; two jobs with no world change
          // are the item-level evidence that it cannot progress.
          if (ledger.tries(plan, item) >= MAX_STANCE_TRIES) {
            ledger.block(plan, item, 'PLACE_FAILED', 'job produced no world change twice')
            continue
          }
          return candidateFor(plan, item, state.driverId, world, stage)
        }
        // A cell under the body cannot be placed. Skip it and place another
        // item first: that moves the body away without a ping-pong handoff.
        if (overlapsBody(item, plan, world)) {
          underBody ??= item
          continue
        }
        const choices = pickStances(ledger, plan, item, placementStances(plan, world, item, stage), ctx)
        if (choices.length === 0) {
          ledger.block(
            plan,
            item,
            'NO_PLACE_STANCE',
            'no standable placement stance can reach an exposed support face',
            staleRejections(ledger, plan, item),
          )
          continue
        }
        return candidateFor(plan, item, state.driverId, world, stage, choices)
      }

      // Everything reachable is under the body (for example the last floor
      // cell): step off the footprint, preferring a cell that is not itself a
      // pending target.
      if (underBody !== undefined) {
        const choice = pickStance(ledger, plan, underBody, stepAsideStances(plan, world, underBody, stage), ctx)
        if (choice !== undefined) {
          return {
            driverId: 'move',
            target: { kind: 'point', pos: choice },
            params: { x: choice.x, y: choice.y, z: choice.z, range: 0, exact: true, timeoutMs: 8_000 },
            reason: `step aside ${underBody.id}`,
            orderId: plan.orderId,
            workItemId: underBody.id,
          }
        }
      }

      // No executable item: unknown cells are re-read, then reported as an
      // observation gap instead of moving the body somewhere.
      const unknown = items.filter(item => states.get(item.id)?.kind === 'unknown')
      if (unknown.length > 0) {
        let blockedAny = false
        for (const item of unknown) {
          const reads = ledger.noteUnknown(plan, item)
          if (reads >= 2) {
            ledger.block(
              plan,
              item,
              'UNKNOWN',
              'cell did not load after a targeted observation',
              staleRejections(ledger, plan, item),
            )
            blockedAny = true
          }
        }
        if (blockedAny) return stageBlocked(plan, stage, summaries, items, states, ledger)
        return null
      }

      // Reach is the only remaining obstacle: hand off a real stance, or block.
      for (const item of items) {
        const state = states.get(item.id)
        if (state?.kind !== 'blocked' || state.reason !== 'UNREACHABLE') continue
        const choices = pickStances(ledger, plan, item, reachStances(plan, world, item, stage), ctx)
        if (choices.length === 0) {
          ledger.block(
            plan,
            item,
            'NO_PLACE_STANCE',
            'unreachable and no remaining placement stance',
            staleRejections(ledger, plan, item),
          )
          continue
        }
        const stand = choices[0]!
        const handoff: Handoff = {
          driverId: 'move',
          target: { kind: 'point', pos: stand },
          params: { x: stand.x, y: stand.y, z: stand.z, range: 0, timeoutMs: 8_000 },
          reason: `reach ${item.id}`,
          orderId: plan.orderId,
          workItemId: item.id,
        }
        const handoffKey = `handoff:${handoff.driverId}:${stand.x},${stand.y},${stand.z}`
        if (ctx.isBlocked?.(handoffKey) === true) continue
        return handoff
      }

      return stageBlocked(plan, stage, summaries, items, states, ledger)
    },
  }
}

function candidateFor(
  plan: PlanInstance,
  item: WorkItem,
  driverId: string,
  world: WorldView,
  stage: number,
  choices: Vec3[] = [],
): Candidate {
  const position = itemPosition(plan, item)
  const params: Record<string, JsonValue> = { x: position.x, y: position.y, z: position.z }
  if (item.expected !== undefined) {
    params.item = item.expected.name
    if (item.expected.state !== undefined) params.expectedState = item.expected.state
  }
  if (driverId === 'place') {
    const cells = itemCells(plan, item)
    if (cells.length > 1) params.cells = cells.slice(1).map(cell => cell.pos)
    const yaw = groupYaw(plan, item)
    if (yaw !== undefined) params.yaw = yaw
    params.stands = choices.map(stand => ({ x: stand.x, y: stand.y, z: stand.z }))
  }
  if (item.kind === 'prepare' || item.kind === 'enter') params.range = 1
  return {
    driverId,
    target: { kind: 'point', pos: position },
    params,
    keys: `plan:${plan.planId}:${item.id}`,
    orderId: plan.orderId,
    workItemId: item.id,
  }
}

/** Bounded, ledger-aware stance pick: skip failed cells, keep the order. */
function pickStances(
  ledger: PlanItemLedger,
  plan: PlanInstance,
  item: WorkItem,
  choices: Array<{ stance: Vec3 }>,
  ctx: EvalCtx,
): Vec3[] {
  const failed = ledger.failedStances(plan, item)
  const seen = new Set<string>()
  const result: Vec3[] = []
  for (const choice of choices) {
    const key = `${choice.stance.x},${choice.stance.y},${choice.stance.z}`
    if (seen.has(key) || failed.has(key)) continue
    seen.add(key)
    result.push(choice.stance)
    if (result.length >= Math.min(MAX_ITEM_STANCES, MAX_STANCE_CANDIDATES)) break
  }
  // A stance whose move handoff the tracker blocked gives no new information;
  // it is skipped here and the next stance is offered.
  return result.filter(stand => ctx.isBlocked?.(`handoff:move:${stand.x},${stand.y},${stand.z}`) !== true)
}

function pickStance(
  ledger: PlanItemLedger,
  plan: PlanInstance,
  item: WorkItem,
  choices: Array<{ stance: Vec3 }>,
  ctx: EvalCtx,
): Vec3 | undefined {
  return pickStances(ledger, plan, item, choices, ctx)[0]
}

function stageBlocked(
  plan: PlanInstance,
  stage: number,
  summaries: ReturnType<typeof stageSummaries>,
  items: WorkItem[],
  states: ReturnType<typeof evaluatePlan>['states'],
  ledger: PlanItemLedger,
): WorkGiverResult {
  const blockedItems = items
    .filter(item => states.get(item.id)?.kind !== 'satisfied')
    .map(item => {
      const state = states.get(item.id)
      const entry = ledger.blocked(plan, item)
      const lastCode = ledger.lastCode(plan, item)
      const position = itemPosition(plan, item)
      return {
        workItemId: item.id,
        target: { x: position.x, y: position.y, z: position.z },
        expected: item.expected?.name ?? null,
        ...(state?.kind === 'blocked' ? { reason: state.reason } : {}),
        ...(entry === undefined
          ? { detail: state?.kind === 'unknown' ? 'observation is incomplete' : 'no executable step' }
          : { reason: entry.reason, detail: entry.detail }),
        ...(entry === undefined ? {} : { triedStances: entry.triedStances as unknown as JsonValue }),
        ...(lastCode === undefined ? {} : { lastCode }),
      }
    })
  return {
    kind: 'hold',
    reason: 'PLAN_BLOCKED',
    notify: false,
    data: {
      planId: plan.planId,
      stage,
      items: blockedItems as unknown as JsonValue,
      stages: summaries as unknown as JsonValue,
    },
  }
}

function staleRejections(
  ledger: PlanItemLedger,
  plan: PlanInstance,
  item: WorkItem,
): StanceRejection[] {
  const entries = ledger.entries(plan)
  const entry = entries.find(candidate => candidate.itemId === item.id)
  return entry === undefined ? [] : ledger.rejections(entry)
}

/**
 * Reach stances for non-placement work (clear/prepare): any standable cell in
 * interaction range is enough; a placement line is not required.
 */
function reachStances(
  plan: PlanInstance,
  world: WorldView,
  item: WorkItem,
  stage: number,
): Array<{ stance: Vec3 }> {
  if (item.kind === 'place' || item.kind === 'hold') return placementStances(plan, world, item, stage)
  const target = itemPosition(plan, item)
  const stand = nearestStandable(world, target, 3, target, 3)
  return stand === undefined ? [] : [{ stance: stand }]
}

function overlapsBody(item: WorkItem, plan: PlanInstance, world: WorldView): boolean {
  const feet = {
    x: Math.floor(world.self.pos.x),
    y: Math.floor(world.self.pos.y),
    z: Math.floor(world.self.pos.z),
  }
  return itemCells(plan, item).some(cell => cell.pos.x === feet.x && cell.pos.z === feet.z
    && (cell.pos.y === feet.y || cell.pos.y === feet.y + 1))
}

/**
 * A two-cell group with declared foot/head parts needs the body to face from
 * the foot toward the head. Vanilla places the head in the player's horizontal
 * facing direction; yaw 0 = +z, 90 = -x, 180 = -z, 270 = +x.
 */
function groupYaw(plan: PlanInstance, item: WorkItem): number | undefined {
  const cells = itemCells(plan, item)
  if (cells.length !== 2) return undefined
  const anchor = cells[0]!
  const other = cells[1]!
  if (anchor.expected.state?.part !== 'foot' || other.expected.state?.part !== 'head') return undefined
  const dx = other.pos.x - anchor.pos.x
  const dz = other.pos.z - anchor.pos.z
  if (Math.abs(dx) + Math.abs(dz) !== 1) return undefined
  return Math.atan2(-dx, dz)
}

function inInterior(plan: PlanInstance, pos: Vec3): boolean {
  const interior = interiorBounds(plan)
  return Math.floor(pos.x) >= interior.min.x && Math.floor(pos.x) <= interior.max.x
    && Math.floor(pos.y) >= interior.min.y && Math.floor(pos.y) <= interior.max.y
    && Math.floor(pos.z) >= interior.min.z && Math.floor(pos.z) <= interior.max.z
}

import type { JsonValue } from '../../contracts/types.ts'
import type { Vec3 } from '../../body/api.ts'
import { interiorBounds, planBuildAccess, planSafeExits } from '../build-access.ts'
import { buildStage, currentStage, stageItems, stageSummaries } from '../build-stage.ts'
import { evaluatePlan, isAirName, isFluidName, itemCells, itemPosition } from '../plan.ts'
import type { PlanInstance, SafeExit, WorkItem } from '../plan.ts'
import { canClearBlock } from '../policy.ts'
import { itemObservationBox } from '../plan-observation.ts'
import { MAX_ITEM_STANCES, MAX_STANCE_TRIES, PlanItemLedger, canPlaceFrom, canReachSafeExit, placementStances, stepAsideStances } from '../placement.ts'
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
  const batchStates = new WeakMap<PlanInstance, {
    anchor: Vec3
    covered: string[]
    offers: number
    since: number
    placed: number
  }>()
  const zeroProgress = new WeakMap<PlanInstance, number>()
  // Plans created outside the body (tests, restored fixtures) may not carry the
  // frozen exit set; compute it once from the first snapshot and keep it.
  const safeExitCache = new WeakMap<PlanInstance, SafeExit[]>()
  const safeExitsFor = (
    plan: PlanInstance,
    world: WorldView,
    entrance?: { inside: Vec3; outside: Vec3 },
  ): SafeExit[] => {
    const known = plan.safeExits ?? safeExitCache.get(plan)
    if (known !== undefined) return known
    const exits = planSafeExits(plan, world, world.self.pos, entrance)
    safeExitCache.set(plan, exits)
    return exits
  }
  const finishBatch = (
    plan: PlanInstance,
    previous: { anchor: Vec3; covered: string[]; offers: number; since: number; placed: number } | undefined,
  ): void => {
    if (previous === undefined || previous.offers === 0) return
    if (previous.placed === 0) {
      zeroProgress.set(plan, (zeroProgress.get(plan) ?? 0) + 1)
    } else {
      zeroProgress.set(plan, 0)
    }
  }
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
      // The stage is a priority/report label, not a barrier: a side-supported
      // higher item may be placed while a lower stage still has pending work.
      // Deferred entrance items stay out of the frontier until everything else
      // is satisfied.
      const finalPhase = plan.workItems.every(item => deferred.has(item.id)
        || states.get(item.id)?.kind === 'satisfied')
      const items = plan.workItems
        .filter(item => finalPhase || !deferred.has(item.id))
        .sort((left, right) => comparePlanItems(plan, left, right, deferred, world))
      const currentStageItems = stageItems(plan, deferred, stage)

      const previousBatch = batchStates.get(plan)
      if (previousBatch !== undefined) {
        const satisfiedNow = previousBatch.covered.filter(id => states.get(id)?.kind === 'satisfied')
        if (satisfiedNow.length > 0) {
          previousBatch.placed += satisfiedNow.length
          previousBatch.covered = previousBatch.covered.filter(id => states.get(id)?.kind !== 'satisfied')
          zeroProgress.set(plan, 0)
        }
      }

      const access = planBuildAccess(plan, world, world.self.pos)
      if (access.blocked !== undefined) {
        return {
          kind: 'hold',
          reason: 'BUILD_ACCESS_BLOCKED',
          notify: false,
          data: {
            planId: plan.planId,
            reason: access.blocked.reason,
            detail: access.blocked.detail,
            stopReason: 'BUILD_ACCESS_BLOCKED',
            workItems: plan.workItems.map(item => item.id),
          },
        }
      }
      const safeExits = safeExitsFor(plan, world, access.entrance)

      // Three batches with no confirmed placement is enough: the world is not
      // yielding to this build, and the receipt should reach the Agent instead
      // of burning the whole blueprint.
      if ((zeroProgress.get(plan) ?? 0) >= MAX_ZERO_PROGRESS_BATCHES) {
        return stageBlocked(plan, stage, summaries, items, states, ledger, 'NO_PROGRESS')
      }

      // A clear policy turns an occupied place target into a clear handoff.
      // Only the current stage is considered here: clearing a far conflict
      // before the lower-stage work would move the body away for no progress.
      if (ctx.conflictPolicy?.mode === 'clear') {
        for (const item of currentStageItems) {
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

      // The final phase closes the temporary entrance. If the body is still
      // inside, leave through the opening first: closing it from inside can
      // seal the body in, and a solid entrance cannot be reopened.
      if (finalPhase && plan.entranceInside !== undefined && inInterior(plan, world.self.pos)) {
        const exit = safeExits.find(candidate => candidate.exterior && isStandable(world, candidate.cell))
        if (exit !== undefined
          && ctx.isBlocked?.(`handoff:move:${exit.cell.x},${exit.cell.y},${exit.cell.z}`) !== true) {
          return {
            driverId: 'move',
            target: { kind: 'point', pos: exit.cell },
            params: {
              x: exit.cell.x,
              y: exit.cell.y,
              z: exit.cell.z,
              range: 0,
              exact: true,
              timeoutMs: 8_000,
            },
            reason: 'exit build interior before closing entrance',
            orderId: plan.orderId,
          }
        }
      }

      // One stance can place many frontier items. Reuse the anchor until its
      // coverage is empty or the bounded batch is full; each job still places
      // exactly one work item (the driver contract is unchanged).
      const frontier = items.filter(item => {
        if (item.kind !== 'place' && item.kind !== 'hold') return false
        if (ledger.blocked(plan, item) !== undefined) return false
        if (ledger.deferred(plan, item) !== undefined) return false
        const state = states.get(item.id)
        return state?.kind === 'executable'
          || (state?.kind === 'blocked' && state.reason === 'UNREACHABLE')
      })
      if (frontier.length > 0) {
        const previous = batchStates.get(plan)
        const batch = chooseBatchAnchor(plan, world, safeExits, ledger, frontier, deferred, previous, ctx.now)
        if (batch !== undefined) {
          if (!batch.reused) finishBatch(plan, previous)
          const byId = new Map(items.map(item => [item.id, item] as const))
          const failedAtAnchor: string[] = []
          for (const id of batch.covered) {
            const item = byId.get(id)
            if (item === undefined) continue
            const itemState = states.get(item.id)
            if (itemState === undefined
              || (itemState.kind !== 'executable'
                && !(itemState.kind === 'blocked' && itemState.reason === 'UNREACHABLE'))) {
              failedAtAnchor.push(id)
              continue
            }
            const cells = itemCells(plan, item).map(cell => cell.pos)
            // The world changes between jobs; a stance that covered this item
            // when the batch was chosen may no longer expose a reachable face.
            if (!canPlaceFrom(world, cells, batch.anchor)) {
              failedAtAnchor.push(id)
              continue
            }
            // Anchor first, then the item's own pool. The batch saves the walk
            // when the anchor still works; if the world moved on, the driver
            // can still place the item from another stance in the same job
            // instead of burning a failed job.
            const pool = [
              { stance: batch.anchor },
              ...placementStances(plan, world, item, stageOf(plan, item, deferred), safeExits, batch.anchor),
            ]
            const choices = pickStances(
              ledger,
              plan,
              item,
              pool,
              ctx,
              world,
              safeExits,
              cells,
            )
            if (choices.length === 0) {
              failedAtAnchor.push(id)
              continue
            }
            const offers = batch.reused && previous !== undefined ? previous.offers + 1 : 1
            const since = batch.reused && previous !== undefined ? previous.since : ctx.now
            const placed = batch.reused && previous !== undefined ? previous.placed : 0
            const remaining = batch.covered.filter(candidate => !failedAtAnchor.includes(candidate))
            batchStates.set(plan, {
              anchor: batch.anchor,
              covered: remaining,
              offers,
              since,
              placed,
            })
            return candidateFor(plan, item, 'place', world, stageOf(plan, item, deferred), choices)
          }
          // A reused batch that failed every covered item is retired once. A
          // newly selected batch was never offered, so only the old batch is
          // finished above.
          if (batch.reused) finishBatch(plan, previous)
          batchStates.delete(plan)
        } else {
          finishBatch(plan, previous)
          batchStates.delete(plan)
        }
      }

      let underBody: WorkItem | undefined
      for (const item of items) {
        const state = states.get(item.id)
        if (state?.kind !== 'executable') continue
        if (ledger.blocked(plan, item) !== undefined) continue
        if (ledger.deferred(plan, item) !== undefined) continue
        if (item.kind !== 'place' && item.kind !== 'hold') {
          // A non-place item has no stance pool; two jobs with no world change
          // are the item-level evidence that it cannot progress.
          if (ledger.tries(plan, item) >= MAX_STANCE_TRIES) {
            ledger.block(plan, item, 'PLACE_FAILED', 'job produced no world change twice')
            continue
          }
          return candidateFor(plan, item, state.driverId, world, stageOf(plan, item, deferred))
        }
        // A cell under the body cannot be placed. Skip it and place another
        // item first: that moves the body away without a ping-pong handoff.
        if (overlapsBody(item, plan, world)) {
          underBody ??= item
          continue
        }
        const choices = pickStances(
          ledger,
          plan,
          item,
          placementStances(plan, world, item, stageOf(plan, item, deferred), safeExits),
          ctx,
          world,
          safeExits,
          itemCells(plan, item).map(cell => cell.pos),
        )
        if (choices.length === 0) {
          ledger.block(
            plan,
            item,
            'NO_PLACE_STANCE',
            safeExits.length === 0
              ? 'no safe exit reference cell for placement'
              : 'no standable placement stance with a safe return path',
            staleRejections(ledger, plan, item),
          )
          continue
        }
        return candidateFor(plan, item, state.driverId, world, stageOf(plan, item, deferred), choices)
      }

      // Everything reachable is under the body (for example the last floor
      // cell): step off the footprint, preferring a cell that is not itself a
      // pending target.
      if (underBody !== undefined) {
        const choice = pickStance(
          ledger,
          plan,
          underBody,
          stepAsideStances(plan, world, underBody, stageOf(plan, underBody, deferred), safeExits),
          ctx,
          world,
          safeExits,
          [],
        )
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
      const unknown = items.filter(item => states.get(item.id)?.kind === 'unknown'
        && ledger.deferred(plan, item) === undefined)
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
        if (ledger.deferred(plan, item) !== undefined) continue
        const choices = pickStances(
          ledger,
          plan,
          item,
          reachStances(plan, world, item, stageOf(plan, item, deferred), safeExits),
          ctx,
          world,
          safeExits,
          [],
        )
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
  world: WorldView,
  safeExits: readonly SafeExit[],
  placed: readonly Vec3[],
): Vec3[] {
  const failed = ledger.failedStances(plan, item)
  const seen = new Set<string>()
  const result: Vec3[] = []
  for (const choice of choices) {
    const key = `${choice.stance.x},${choice.stance.y},${choice.stance.z}`
    if (seen.has(key) || failed.has(key)) continue
    seen.add(key)
    // A stance whose move handoff the tracker blocked gives no new information.
    if (ctx.isBlocked?.(`handoff:move:${key}`) === true) continue
    // The stance must still reach a safe exit after this item is placed. The
    // trial cells are the item's full group; a wall top or a closing entrance
    // is rejected here, before the driver moves. When no safe exit can be
    // established (synthetic/void worlds), keep the old stance policy: the
    // guard is only as strong as its reference cell.
    if (placed.length > 0 && safeExits.length > 0
      && canReachSafeExit(world, choice.stance, placed, safeExits) !== 'yes') continue
    result.push(choice.stance)
    if (result.length >= MAX_ITEM_STANCES) break
  }
  return result
}

function pickStance(
  ledger: PlanItemLedger,
  plan: PlanInstance,
  item: WorkItem,
  choices: Array<{ stance: Vec3 }>,
  ctx: EvalCtx,
  world: WorldView,
  safeExits: readonly SafeExit[],
  placed: readonly Vec3[],
): Vec3 | undefined {
  return pickStances(ledger, plan, item, choices, ctx, world, safeExits, placed)[0]
}

function stageBlocked(
  plan: PlanInstance,
  stage: number,
  summaries: ReturnType<typeof stageSummaries>,
  items: WorkItem[],
  states: ReturnType<typeof evaluatePlan>['states'],
  ledger: PlanItemLedger,
  stopReason = 'NO_FRONTIER',
): WorkGiverResult {
  const blockedItems = items
    .filter(item => states.get(item.id)?.kind !== 'satisfied')
    .map(item => {
      const state = states.get(item.id)
      const blocked = ledger.blocked(plan, item)
      const deferred = ledger.deferred(plan, item)
      const entry = blocked ?? deferred
      const lastCode = deferred?.code ?? ledger.lastCode(plan, item)
      const position = itemPosition(plan, item)
      return {
        workItemId: item.id,
        target: { x: position.x, y: position.y, z: position.z },
        expected: item.expected?.name ?? null,
        ...(state?.kind === 'blocked' ? { reason: state.reason } : {}),
        ...(entry === undefined
          ? { detail: state?.kind === 'unknown' ? 'observation is incomplete' : 'no executable step' }
          : { reason: entry.reason, detail: entry.detail }),
        ...(blocked === undefined ? {} : { triedStances: blocked.triedStances as unknown as JsonValue }),
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
      stopReason,
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
  safeExits: readonly SafeExit[],
): Array<{ stance: Vec3 }> {
  if (item.kind === 'place' || item.kind === 'hold') {
    return placementStances(plan, world, item, stage, safeExits)
  }
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

/** A batch is as long as this many offered items, or this wall time. */
const BATCH_MAX_ITEMS = 8
const BATCH_MAX_MS = 30_000
/** Consecutive batches with no confirmed placement before the plan stops. */
const MAX_ZERO_PROGRESS_BATCHES = 3
/** Seed stance pools are taken from at most this many frontier items. */
const BATCH_SEEDS = 2
/** Each seed contributes at most this many stance candidates. */
const BATCH_STANCE_CANDIDATES = 6

type BatchChoice = { anchor: Vec3; covered: string[]; reused: boolean }

function stageOf(plan: PlanInstance, item: WorkItem, deferred: ReadonlySet<string>): number {
  return buildStage(plan, item, deferred)
}

/** Stage is a priority, not a barrier; within a stage, build bottom-up. */
function comparePlanItems(
  plan: PlanInstance,
  left: WorkItem,
  right: WorkItem,
  deferred: ReadonlySet<string>,
  world: WorldView,
): number {
  const stage = stageOf(plan, left, deferred) - stageOf(plan, right, deferred)
  if (stage !== 0) return stage
  const leftPos = itemPosition(plan, left)
  const rightPos = itemPosition(plan, right)
  if (leftPos.y !== rightPos.y) return leftPos.y - rightPos.y
  const leftDistance = Math.hypot(
    leftPos.x - world.self.pos.x,
    leftPos.y - world.self.pos.y,
    leftPos.z - world.self.pos.z,
  )
  const rightDistance = Math.hypot(
    rightPos.x - world.self.pos.x,
    rightPos.y - world.self.pos.y,
    rightPos.z - world.self.pos.z,
  )
  if (leftDistance !== rightDistance) return leftDistance - rightDistance
  return left.id.localeCompare(right.id)
}

/**
 * Choose the stance that covers the most currently placeable work items.
 * Reuse the previous anchor while it still covers something; a new anchor is
 * seeded from the lowest/nearest frontier items and scored by coverage, with a
 * bottom-up tie-break. This is a greedy selection, not a promise of optimality.
 */
function chooseBatchAnchor(
  plan: PlanInstance,
  world: WorldView,
  safeExits: readonly SafeExit[],
  ledger: PlanItemLedger,
  frontier: WorkItem[],
  deferred: ReadonlySet<string>,
  previous: { anchor: Vec3; covered: string[]; offers: number; since: number } | undefined,
  now: number,
): BatchChoice | undefined {
  const feet = {
    x: Math.floor(world.self.pos.x),
    y: Math.floor(world.self.pos.y),
    z: Math.floor(world.self.pos.z),
  }
  if (previous !== undefined && now - previous.since < BATCH_MAX_MS && previous.offers < BATCH_MAX_ITEMS) {
    const covered = previous.covered.filter(id => frontier.some(item => item.id === id))
    if (covered.length > 0
      && isStandable(world, previous.anchor)
      && (safeExits.length === 0 || canReachSafeExit(world, previous.anchor, [], safeExits) === 'yes')) {
      return { anchor: previous.anchor, covered, reused: true }
    }
  }

  const seeds = [...frontier]
    .sort((left, right) => comparePlanItems(plan, left, right, deferred, world))
    .slice(0, BATCH_SEEDS)
  const candidates: Vec3[] = []
  const add = (stand: Vec3): void => {
    if (!candidates.some(candidate => sameCell(candidate, stand))) candidates.push(stand)
  }
  if (isStandable(world, feet)) add(feet)
  for (const seed of seeds) {
    const pool = placementStances(plan, world, seed, stageOf(plan, seed, deferred), safeExits)
    for (const choice of pool.slice(0, BATCH_STANCE_CANDIDATES)) add(choice.stance)
  }

  let best: { anchor: Vec3; covered: string[] } | undefined
  for (const stand of candidates) {
    if (!isStandable(world, stand)) continue
    if (safeExits.length > 0 && canReachSafeExit(world, stand, [], safeExits) !== 'yes') continue
    const covered = coveredBy(plan, world, ledger, stand, frontier)
    if (covered.length === 0) continue
    if (best === undefined
      || covered.length > best.covered.length
      || (covered.length === best.covered.length && preferAnchor(stand, best.anchor, feet))) {
      best = { anchor: stand, covered }
    }
  }
  return best === undefined ? undefined : { ...best, reused: false }
}

/** Items this anchor can place without standing on their target cells. */
function coveredBy(
  plan: PlanInstance,
  world: WorldView,
  ledger: PlanItemLedger,
  anchor: Vec3,
  frontier: WorkItem[],
): string[] {
  const covered: string[] = []
  const anchorKey = cellKeyOf(anchor)
  for (const item of frontier) {
    if (item.kind !== 'place' && item.kind !== 'hold') continue
    const cells = itemCells(plan, item).map(cell => cell.pos)
    // The body at the anchor may not occupy a target it is about to place.
    if (cells.some(cell => cell.x === anchor.x && cell.z === anchor.z
      && (cell.y === anchor.y || cell.y === anchor.y + 1))) continue
    if (ledger.failedStances(plan, item).has(anchorKey)) continue
    // Cheap bound before the line-of-sight predicate.
    if (!cells.some(cell => Math.abs(cell.x - anchor.x) <= 5
      && Math.abs(cell.y - anchor.y) <= 5
      && Math.abs(cell.z - anchor.z) <= 5)) continue
    if (!canPlaceFrom(world, cells, anchor)) continue
    covered.push(item.id)
  }
  return covered
}

function preferAnchor(candidate: Vec3, best: Vec3, feet: Vec3): boolean {
  if (candidate.y !== best.y) return candidate.y < best.y
  const candidateDistance = Math.hypot(candidate.x - feet.x, candidate.z - feet.z)
  const bestDistance = Math.hypot(best.x - feet.x, best.z - feet.z)
  if (candidateDistance !== bestDistance) return candidateDistance < bestDistance
  if (candidate.x !== best.x) return candidate.x < best.x
  return candidate.z < best.z
}

function cellKeyOf(at: Vec3): string {
  return `${at.x},${at.y},${at.z}`
}

function sameCell(left: Vec3, right: Vec3): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z
}

import { appendFileSync, readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { p2Error } from '../contracts/protocol.ts'
import type { MindStatusView } from '../contracts/protocol.ts'
import type { MindFocusView } from '../contracts/protocol.ts'
import type { ProviderRuntimeStatus } from '../contracts/protocol.ts'
import type { SuspensionState } from '../contracts/protocol.ts'
import type { DutyStatusView } from '../contracts/protocol.ts'
import type { BaseActivityView } from '../contracts/protocol.ts'
import type { MindDutyStartResult } from '../contracts/protocol.ts'
import type { ReactionPolicyView } from '../contracts/protocol.ts'
import type { MindOrderResult, MindQueueSummary } from '../contracts/protocol.ts'
import type { JsonValue } from '../contracts/types.ts'
import { ErrorCodes } from '../contracts/types.ts'
import { createMoveDriver, MOVE_DRIVER_ID } from '../mind/drivers/move.ts'
import { createClearDriver, CLEAR_DRIVER_ID } from '../mind/drivers/clear.ts'
import { createCheckDriver, CHECK_DRIVER_ID } from '../mind/drivers/check.ts'
import { createAttackDriver, ATTACK_DRIVER_ID } from '../mind/drivers/attack.ts'
import { createDigDriver, DIG_DRIVER_ID } from '../mind/drivers/dig.ts'
import { createCollectDriver, COLLECT_DRIVER_ID } from '../mind/drivers/collect.ts'
import { createContainerDriver, CONTAINER_DRIVER_ID } from '../mind/drivers/container.ts'
import { createPlaceDriver, PLACE_DRIVER_ID } from '../mind/drivers/place.ts'
import { createEquipDriver, EQUIP_DRIVER_ID } from '../mind/drivers/equip.ts'
import { createCraftDriver, CRAFT_DRIVER_ID } from '../mind/drivers/craft.ts'
import { createUseDriver, USE_DRIVER_ID } from '../mind/drivers/use.ts'
import { createTraverseDriver, TRAVERSE_DRIVER_ID } from '../mind/drivers/traverse.ts'
import { createStepDriver } from '../mind/drivers/step.ts'
import { createFatalDriver, FATAL_DRIVER_ID } from '../mind/drivers/fatal.ts'
import { MindEvents } from '../mind/events.ts'
import type { MindEvent } from '../mind/events.ts'
import { classifyFailure } from '../mind/diagnostics.ts'
import { ensureFailureObserved } from '../mind/failure.ts'
import { MindMetrics } from '../mind/metrics.ts'
import { createEscapeGiver } from '../mind/givers/escape.ts'
import { createCheckGiver, checkPosition } from '../mind/givers/check.ts'
import { AreaResourceIndex } from '../mind/area.ts'
import { DutyController } from '../mind/duty.ts'
import { createDutyGiver } from '../mind/givers/duty.ts'
import { BaseActivityController } from '../mind/base-activity.ts'
import type { BaseActivitySpec } from '../mind/base-activity.ts'
import { createBaseActivityGiver, ESCORT_LOST_GRACE_MS } from '../mind/givers/base-activity.ts'
import { createThreatFightGiver } from '../mind/givers/threat.ts'
import { createSelfEatGiver, createSelfUnstuckGiver } from '../mind/givers/self-care.ts'
import { ReactionPolicyState } from '../mind/reaction-policy.ts'
import { buildActivityView, resolveActivityLayer } from '../mind/activity.ts'
import type { ActivityLayer, MindActivityView } from '../contracts/protocol.ts'
import { createGoOrderGiver, createHoldOrderGiver, createTraverseGiver } from '../mind/givers/orders.ts'
import { createAttackOrderGiver } from '../mind/givers/combat.ts'
import { createDigOrderGiver } from '../mind/givers/dig.ts'
import { createCollectOrderGiver } from '../mind/givers/collect.ts'
import { createContainerOrderGiver } from '../mind/givers/container.ts'
import {
  createCraftOrderGiver,
  createEquipOrderGiver,
  createPlaceOrderGiver,
  createUseOrderGiver,
} from '../mind/givers/primitives.ts'
import { createPlanGiver } from '../mind/givers/plan.ts'
import { currentStage, stageItems, stageKey, stageSummaries } from '../mind/build-stage.ts'
import { planObservationBoxes, verifyObservationBoxes } from '../mind/plan-observation.ts'
import { PlanItemLedger } from '../mind/placement.ts'
import { createMaterialGiver } from '../mind/givers/material.ts'
import { MindLoop } from '../mind/loop.ts'
import { OrderStore } from '../mind/orders.ts'
import { planShortage, materialSources } from '../mind/materials.ts'
import { blueprintPlan, parseBlueprint } from '../mind/blueprint.ts'
import { planBuildAccess, planSafeExits } from '../mind/build-access.ts'
import {
  evaluatePlan,
  instantiatePlan,
  isAirName,
  itemPosition,
  loadPlanTemplates,
  matchesExpected,
} from '../mind/plan.ts'
import type { PlanInstance, VerifySpec } from '../mind/plan.ts'
import { parseConflictPolicy, parseMaterialPolicy } from '../mind/policy.ts'
import type { ConflictPolicy, MaterialPolicy } from '../mind/policy.ts'
import { parseHazardPolicy } from '../mind/policy.ts'
import type { HazardPolicy } from '../mind/policy.ts'
import type { WorldView } from '../mind/types.ts'
import { Registry } from '../mind/registry.ts'
import { Sensors } from '../mind/sensors.ts'
import { JobTracker } from '../mind/tracker.ts'
import type { TrackerEvent } from '../mind/tracker.ts'
import { evaluateTree, loadTrees } from '../mind/tree.ts'
import { TREE_DEFINITIONS } from '../mind/trees.ts'
import { contentVersion } from '../mind/content-version.ts'
import { verifyBlueprint } from '../mind/verify/blueprint.ts'
import { verifySealedRoom } from '../mind/verify/sealed-room.ts'
import { verifyUsableRoom } from '../mind/verify/usable-room.ts'
import type { VerifyResult } from '../mind/verify/sealed-room.ts'
import type { BodyApi, EntityInfo, Item, Vec3 } from './api.ts'

export type MindOrderView = {
  id: string
  verb: string
  state: string
  /** Job attempts recorded for this order so far. */
  attempts?: number
  lastCode?: string
  blockedKeys?: string[]
  /** Set for a timed hold that is active. */
  expiresAt?: number
}

export type MindRuntime = {
  tick(): void
  status(): MindStatusView
  /** Latest deviation/terminal digest for `p2_report`; null while healthy. */
  report(): JsonValue | null
  enqueueOrder(input: unknown): MindOrderResult
  cancelOrder(id: string): { id: string; state: string }
  /** Cancel every queued/active order (hold barriers included). */
  cancelAll(): { cancelled: number }
  startDuty(input: unknown): MindDutyStartResult
  stopDuty(): DutyStatusView | null
  baseActivity(): BaseActivityView
  setBaseActivity(input: unknown): BaseActivityView
  reactionPolicy(): ReactionPolicyView
  setReactionPolicy(input: unknown): ReactionPolicyView
  resetReactionPolicy(): ReactionPolicyView
  listOrders(): {
    active: MindOrderView | null
    queued: MindOrderView[]
    queueBlockedBy: { id: string; verb: string } | null
  }
  sinceEvents(seq: number, limit?: number): { events: MindEvent[]; seq: number }
  /** Expected block name at a watched plan position, if any. */
  watchedBlock(p: Vec3): string | undefined
  orders: OrderStore
  events: MindEvents
}

export type CreateMindOptions = {
  body: BodyApi
  home?: Vec3
  /** Initial base activity; defaults to idle and is never persisted. */
  baseActivity?: BaseActivitySpec
  /** Recovery identity from the provider; defVersion is computed from plans. */
  identity?: { worldId: string; characterId: string; defVersion?: string }
  /** Live provider state, used to record why a pause was reported. */
  providerStatus?: () => ProviderRuntimeStatus
  plansDir: string
  journalPath: string
  /** Development-only crash injection after the first action.pending write. */
  crashAfterPending?: boolean
  now?: () => number
}

/**
 * Compose the mind: registry, content trees, sensors, tracker, orders and the
 * 50 ms loop. Definition or journal failures abort body start rather than
 * running with half-loaded content.
 */
function worldTimeView(time: { timeOfDay: number; worldAge: number }): NonNullable<MindStatusView['worldTime']> {
  const timeOfDay = ((Math.floor(time.timeOfDay) % 24_000) + 24_000) % 24_000
  const day = Math.floor(Math.max(0, time.worldAge) / 24_000)
  return {
    day,
    timeOfDay,
    isNight: timeOfDay >= 13_000 && timeOfDay < 23_000,
    // 0 once the sun has set; keep it non-negative for planning.
    ticksToSunset: Math.max(0, 13_000 - timeOfDay),
  }
}

export function createMind(options: CreateMindOptions): MindRuntime {
  const now = options.now ?? (() => Date.now())
  const registry = new Registry()
  let activeOrderLookup: (() => ReturnType<OrderStore['active']>) | undefined
  registry.registerDriver({ id: MOVE_DRIVER_ID, driver: createMoveDriver() })
  registry.registerDriver({ id: CLEAR_DRIVER_ID, driver: createClearDriver() })
  registry.registerDriver({ id: CHECK_DRIVER_ID, driver: createCheckDriver() })
  registry.registerDriver({ id: ATTACK_DRIVER_ID, driver: createAttackDriver() })
  registry.registerDriver({ id: DIG_DRIVER_ID, driver: createDigDriver() })
  registry.registerDriver({ id: COLLECT_DRIVER_ID, driver: createCollectDriver() })
  registry.registerDriver({ id: CONTAINER_DRIVER_ID, driver: createContainerDriver() })
  registry.registerDriver({ id: PLACE_DRIVER_ID, driver: createPlaceDriver() })
  registry.registerDriver({ id: EQUIP_DRIVER_ID, driver: createEquipDriver() })
  registry.registerDriver({ id: CRAFT_DRIVER_ID, driver: createCraftDriver() })
  registry.registerDriver({ id: USE_DRIVER_ID, driver: createUseDriver() })
  registry.registerDriver({ id: TRAVERSE_DRIVER_ID, driver: createTraverseDriver() })
  registry.registerDriver({ id: 'prepare', driver: createStepDriver('prepare') })
  registry.registerDriver({ id: 'enter', driver: createStepDriver('enter') })
  registry.registerDriver({ id: FATAL_DRIVER_ID, driver: createFatalDriver() })
  const areaResources = new AreaResourceIndex(options.body, {
    radius: 32,
    vertical: 16,
    chunkBudget: 2,
  })
  options.body.on('blockUpdated', payload => areaResources.onBlockUpdate(payload))
  /**
   * Recent damage attacker for `EvalCtx.attacker`. The adapter reports the
   * source with `damaged`; the giver only needs a short window, and death
   * clears it so the body does not target whoever killed the previous run.
   */
  let lastAttacker: { id: string; name?: string; at: number } | undefined
  options.body.on('damaged', payload => {
    if (!isRecord(payload) || !isRecord(payload.source)) return
    const id = payload.source.id
    if (typeof id !== 'string' || id.length === 0) return
    lastAttacker = {
      id,
      ...(typeof payload.source.name === 'string' ? { name: payload.source.name } : {}),
      at: now(),
    }
  })
  options.body.on('died', () => {
    lastAttacker = undefined
  })
  const freshAttacker = (): { id: string; name?: string } | undefined => {
    if (lastAttacker === undefined) return undefined
    if (now() - lastAttacker.at > ATTACKER_WINDOW_MS) return undefined
    return {
      id: lastAttacker.id,
      ...(lastAttacker.name === undefined ? {} : { name: lastAttacker.name }),
    }
  }
  const planLedger = new PlanItemLedger()
  const duty = new DutyController({
    statePath: join(dirname(options.journalPath), 'duty.json'),
    ...(options.identity === undefined
      ? {}
      : { identity: { worldId: options.identity.worldId, characterId: options.identity.characterId } }),
  })
  const base = new BaseActivityController()
  if (options.baseActivity !== undefined) base.set(options.baseActivity, now())
  const reaction = new ReactionPolicyState()
  const fight = createThreatFightGiver(() => reaction.get())
  const selfEat = createSelfEatGiver(() => reaction.get())
  const selfUnstuck = createSelfUnstuckGiver(() => reaction.get())
  registry.registerGiver({ id: 'escape', factory: () => createEscapeGiver() })
  registry.registerGiver({ id: 'check', factory: () => createCheckGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.go', factory: () => createGoOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.attack', factory: () => createAttackOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.dig', factory: () => createDigOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.collect', factory: () => createCollectOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.container', factory: () => createContainerOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.place', factory: () => createPlaceOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.equip', factory: () => createEquipOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.use', factory: () => createUseOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.craft', factory: () => createCraftOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.traverse', factory: () => createTraverseGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.hold', factory: () => createHoldOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'plan.work', factory: () => createPlanGiver({ ledger: planLedger }) })
  registry.registerGiver({ id: 'duty.work', factory: () => createDutyGiver(duty, areaResources) })
  registry.registerGiver({ id: 'base.work', factory: () => createBaseActivityGiver(base) })
  registry.registerGiver({ id: 'threat.fight', factory: () => fight })
  registry.registerGiver({ id: 'self.eat', factory: () => selfEat })
  registry.registerGiver({ id: 'self.unstuck', factory: () => selfUnstuck })
  registry.registerGiver({ id: 'material.gather', factory: () => createMaterialGiver(areaResources) })

  const loaded = loadTrees(TREE_DEFINITIONS, registry)
  if (!loaded.ok) throw loaded.error

  const planDefinitions = readPlanDefinitions(options.plansDir)
  const loadedPlans = loadPlanTemplates(planDefinitions)
  if (!loadedPlans.ok) throw loadedPlans.error
  const templates = loadedPlans.templates

  const events = new MindEvents()
  const metrics = new MindMetrics()
  for (const event of ['move.started', 'move.progress', 'move.no_path', 'move.stuck', 'move.finished', 'move.door', 'move.unstick-dig'] as const) {
    options.body.on(event, data => events.push(event, now(), data))
  }
  let lastReport: JsonValue | null = null
  let loopRef: MindLoop | undefined

  type OrderDebug = { attempts: number; lastCode?: string; lastLayer?: string; blockedKeys?: string[] }
  const orderDiagnostics = new Map<string, OrderDebug>()
  const metricsPath = join(dirname(options.journalPath), 'metrics.jsonl')
  const appendOrderMetric = (orderId: string, state: string): void => {
    const record = orders.get(orderId)
    if (record === undefined) return
    const debug = orderDiagnostics.get(orderId)
    const params = record.order.params
    const pointOf = (value: JsonValue | undefined): { x: number; y: number; z: number } | null => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      const record = value as Record<string, JsonValue>
      return typeof record.x === 'number' && typeof record.y === 'number' && typeof record.z === 'number'
        ? { x: record.x, y: record.y, z: record.z }
        : null
    }
    const target = pointOf(params) ?? pointOf(params?.from) ?? null
    const line = {
      at: now(),
      orderId,
      verb: record.order.verb,
      state,
      acceptedAt: record.acceptedAt,
      durationMs: Math.max(0, now() - record.acceptedAt),
      attempts: debug?.attempts ?? 0,
      ...(target === null ? {} : { target }),
      ...(debug?.lastCode === undefined ? {} : { lastCode: debug.lastCode }),
      ...(debug?.lastLayer === undefined ? {} : { lastLayer: debug.lastLayer }),
      ...(debug?.blockedKeys === undefined ? {} : { blockedKeys: debug.blockedKeys }),
    }
    try {
      appendFileSync(metricsPath, `${JSON.stringify(line)}\n`)
    } catch {
      // Metrics are a sidecar; a write failure must not fail the order path.
    }
  }

  const orders = new OrderStore({
    journalPath: options.journalPath,
    ...(options.identity === undefined
      ? {}
      : {
          identity: {
            worldId: options.identity.worldId,
            characterId: options.identity.characterId,
            defVersion: options.identity.defVersion ?? contentVersion(planDefinitions),
            defScope: 'plans' as const,
          },
        }),
    now,
    onEvent: event => {
      events.push(event.kind, event.at, event as unknown as JsonValue)
      metrics.record(event.kind, event as unknown as JsonValue, event.at)
      if (event.kind === 'order.accepted') {
        orderDiagnostics.set(event.orderId, { attempts: 0 })
        loopRef?.invalidate()
      } else if (event.kind === 'order.terminal') {
        appendOrderMetric(event.orderId, event.state)
        loopRef?.invalidate()
      }
    },
  })
  orders.restore()
  // A new epoch does not continue the previous queue: restored queued orders
  // and an active hold barrier are abandoned. A restored active non-hold order
  // may still be reconciled from the world by the normal recovery path.
  const restoredOrders = new Map(orders.all().map(record => [
    record.order.id,
    { verb: record.order.verb, state: record.state },
  ]))
  abandonRestoredOrders()
  const restoredDuty = duty.restore(options.body.inventory(), now())
  if (restoredDuty !== undefined) {
    events.push('duty.restored', now(), restoredDuty as unknown as JsonValue)
    if (restoredDuty.state === 'active') {
      loopRef?.invalidate()
    } else {
      const terminal = duty.takeTerminal()
      if (terminal !== undefined) {
        events.push('duty.terminal', now(), terminal as unknown as JsonValue)
      }
    }
  }
  activeOrderLookup = () => orders.active()

  const sensors = new Sensors({ body: options.body, now })
  const home = options.home
  let activePlan: PlanInstance | undefined
  let planStage = 0
  let planStageKey = ''
  let planStageSatisfied = -1
  let planProgressAt = 0
  let planLastJobAt = 0
  let suspended = false
  let suspendedSince = 0
  let pausedMs = 0
  let lastPauseNoticeAt = 0
  let activityView: MindActivityView | undefined
  let lastActivityKey = ''
  let lastBaseWaiting: string | null = null
  let lastStuckAt: number | undefined
  let focusIntent: { name: string; kind: 'escort' | 'attack' } | undefined
  let currentFocus: EntityInfo | undefined
  let lastFocusAt = Number.NEGATIVE_INFINITY
  /** True once the intent has resolved to a player entity; disambiguates offline. */
  let focusWasPlayer = false
  let manualEquipPending = false
  const jobWorkItems = new Map<string, { workItemId: string; stands: Vec3[]; orderId?: string }>()
  let planOrderId: string | undefined
  let planBlockedReported = false
  let planInsufficientReported = false
  let gatherCount = 0
  let pendingReconciled = false
  let crashedOnce = false
  const crashMarker = join(dirname(options.journalPath), 'crash-after-pending.done')
  const crashOnce = options.crashAfterPending === true && !existsSync(crashMarker)
  const tracker = new JobTracker({
    body: options.body,
    driver: id => registry.driver(id),
    world: () => sensors.read(),
    now,
    allowAutoEquip: () => {
      if (!manualEquipPending) return true
      manualEquipPending = false
      return false
    },
    beforeStart: (candidate, job) => {
      if (candidate.keys.startsWith('duty:gather:')) duty.recordJobStart(now())
      if (candidate.workItemId !== undefined) {
        jobWorkItems.set(job.runId, {
          workItemId: candidate.workItemId,
          stands: candidateStances(candidate.params),
          ...(candidate.orderId === undefined ? {} : { orderId: candidate.orderId }),
        })
      }
      if (candidate.driverId !== 'clear' && candidate.driverId !== 'place') return
      const parsed = parseActionKeys(candidate.keys)
      const orderId = candidate.orderId ?? orders.active()?.order.id
      orders.recordActionPending({
        runId: job.runId,
        driverId: candidate.driverId,
        keys: candidate.keys,
        ...(orderId === undefined ? {} : { orderId }),
        ...(parsed === undefined ? {} : parsed),
      })
      if (crashOnce && !crashedOnce) {
        crashedOnce = true
        mkdirSync(dirname(crashMarker), { recursive: true })
        writeFileSync(crashMarker, 'test crash after pending\n')
        process.stderr.write('dsh-minecraft-p2 body: test crash after action.pending\n')
        process.exit(1)
      }
    },
    onEvent: event => {
      if (event.kind === 'job.terminal' && event.driverId === 'equip' && event.state === 'succeeded') {
        const destination = isRecord(event.observed) && event.observed.destination === 'offhand' ? 'offhand' : 'hand'
        if (destination === 'hand') manualEquipPending = true
      }
      if (event.kind === 'job.terminal' && event.orderId !== undefined) {
        const debug = orderDiagnostics.get(event.orderId) ?? { attempts: 0 }
        debug.attempts += 1
        if (event.code !== undefined) debug.lastCode = event.code
        const observed = event.observed
        const failure = isRecord(observed) && isRecord(observed.failure) ? observed.failure : undefined
        if (failure !== undefined && typeof failure.layer === 'string') debug.lastLayer = failure.layer
        if (event.blocked === true) debug.blockedKeys = [...(debug.blockedKeys ?? []), event.keys]
        orderDiagnostics.set(event.orderId, debug)
      }
      const order = event.kind === 'job.terminal' && event.orderId !== undefined
        ? orders.get(event.orderId)
        : undefined
      const retry = shouldRetryOrderJob(event, order?.order.verb)
      const code = event.kind === 'job.terminal' && typeof (event as { code?: unknown }).code === 'string'
        ? (event as { code: string }).code
        : undefined
      const diagnostic = event.kind === 'job.terminal' && code !== undefined
        ? classifyFailure(code)
        : undefined
      const eventObserved = event.kind === 'job.terminal' ? event.observed : undefined
      const observed = event.kind === 'job.terminal' && event.state === 'failed'
        ? ensureFailureObserved(eventObserved, event.code, event.driverId)
        : eventObserved
      const data = {
        ...event,
        ...(event.kind === 'job.terminal' && observed !== eventObserved ? { observed } : {}),
        ...(retry ? { retry: true } : {}),
        ...(diagnostic === undefined ? {} : { diagnostic }),
      } as unknown as JsonValue
      events.push(event.kind, event.at, data)
      metrics.record(event.kind, data, event.at)
      if (event.kind === 'job.terminal' && typeof event.keys === 'string') {
        if (event.code === 'GOTO_STUCK') lastStuckAt = event.at
        if (event.keys.startsWith('threat.fight:')) {
          fight.noteTerminal({
            keys: event.keys,
            at: event.at,
            state: event.state,
            ...(event.code === undefined ? {} : { code: event.code }),
          })
        }
        if (event.keys.startsWith('base:wander:')) {
          base.noteMoveResult('wandering', event.state === 'succeeded', event.at)
        } else if (event.keys.startsWith('base:escort:')) {
          base.noteMoveResult('escort', event.state === 'succeeded', event.at)
        }
      }
      if (event.kind === 'job.terminal' && isRecord(event)
        && typeof event.runId === 'string') {
        orders.recordActionSettled(
          event.runId,
          typeof event.state === 'string' ? event.state : 'unknown',
          typeof event.code === 'string' ? event.code : undefined,
        )
      }
      if (event.kind === 'job.terminal' && event.driverId === 'check') {
        if (order !== undefined && order.order.verb === 'check') {
          const ok = isRecord(observed) && observed.state === 'ok'
          orders.complete(order.order.id, ok ? 'succeeded' : 'failed')
          events.push('check.result', now(), {
            orderId: order.order.id,
            observed: observed ?? null,
          })
        }
      }
      if (event.kind === 'job.terminal' && event.state !== 'interrupted') {
        if (order !== undefined && PRIMITIVE_ORDER_VERBS.has(order.order.verb)) {
          if (retry) {
            // The order stays active; the same giver is offered again on the
            // next tick. Intermediate failures do not wake the Agent.
            loopRef?.invalidate()
          } else {
            const terminal = event.state === 'succeeded'
              ? 'succeeded'
              : event.blocked === true ? 'blocked' : 'failed'
            orders.complete(order.order.id, terminal)
            events.push('order.result', now(), {
              orderId: order.order.id,
              state: terminal,
              ...(event.code === undefined ? {} : { code: event.code }),
              ...(observed === undefined ? {} : { observed }),
            })
          }
        }
      }
      if (event.kind === 'job.preempted' && isRecord(event) && typeof event.runId === 'string') {
        orders.recordActionSettled(event.runId, 'preempted')
      }
      if (event.kind === 'job.terminal' || event.kind === 'tracker.fault' || event.kind === 'job.stale-result') {
        lastReport = data
      }
      if (event.kind === 'job.terminal') recordPlanJob(event)
      if (event.kind === 'job.started') planLastJobAt = event.at
    },
  })
  const loop = new MindLoop({
    world: () => sensors.read(),
    evaluate: (name, ctx, world) => evaluateTree(name, loaded.trees, registry, ctx, world),
    tracker,
    now,
    ...(options.home === undefined ? {} : { home: options.home }),
    plan: () => activePlan,
    dutyActive: () => duty.view()?.state === 'active',
    baseActive: () => base.isActive(),
    orderVerb: () => orders.active()?.order.verb,
    orderParams: () => orders.active()?.order.params,
    hazards: () => currentHazardPolicy(),
    conflictPolicy: () => currentConflictPolicy(),
    materialPolicy: () => currentMaterialPolicy(),
    gatherCount: () => gatherCount,
    observe: box => sensors.observeBox(box),
    focus: () => currentFocus,
    attacker: freshAttacker,
    ...(options.body.canSee === undefined ? {} : { canSee: (id: string) => options.body.canSee!(id) }),
    lastStuckAt: () => lastStuckAt,
    onEvent: event => {
      metrics.record(event.kind, event.data, event.at)
      events.push(event.kind, event.at, event.data)
      if (event.kind === 'job.started' && isRecord(event.data)
        && typeof event.data.keys === 'string' && event.data.keys.startsWith('gather:')) {
        gatherCount += 1
      }
      if (event.kind === 'mind.definition-error' || event.kind === 'mind.error') lastReport = event.data
      if (event.kind === 'mind.hold' && isRecord(event.data) && event.data.notify !== false) {
        lastReport = event.data
      }
      // The giver reports a stage with no advanceable item; this is the formal
      // plan block (the old path left the order active until a watchdog fired).
      if (event.kind === 'mind.hold' && isRecord(event.data) && event.data.reason === 'PLAN_BLOCKED'
        && activePlan !== undefined) {
        const detail = isRecord(event.data.data) ? event.data.data : {}
        try {
          const world = sensors.read()
          blockPlanNow(
            typeof detail.stage === 'number' ? detail.stage : planStage,
            (detail.items ?? []) as JsonValue,
            world,
            observationBasis(world),
          )
        } catch (error) {
          events.push('mind.error', now(), { message: error instanceof Error ? error.message : String(error) })
        }
      }
    },
  })
  loopRef = loop

  const syncPlan = (): void => {
    const active = orders.active()
    if (active !== undefined && active.order.verb === 'check') {
      if (checkPosition(active) === undefined) {
        events.push('check.invalid', now(), {
          orderId: active.order.id,
          message: 'check order requires numeric params.x/y/z',
        })
        orders.complete(active.order.id, 'failed')
      }
      return
    }
    if (active === undefined || active.order.verb !== 'build') {
      if (planOrderId !== undefined) finishPlan()
      return
    }
    if (planOrderId === active.order.id) return

    if (active.order.verb === 'build') {
      if (active.order.blueprint === undefined) {
        events.push('plan.definition-error', now(), {
          orderId: active.order.id,
          message: 'build order requires a blueprint',
        })
        orders.complete(active.order.id, 'failed')
        return
      }
      const parsed = parseBlueprint(active.order.blueprint)
      if (!parsed.ok) {
        events.push('plan.definition-error', now(), {
          orderId: active.order.id,
          errors: parsed.errors,
        })
        orders.complete(active.order.id, 'failed')
        return
      }
      activePlan = blueprintPlan(parsed.blueprint, active.order.id)
      const planWorld = sensors.read()
      const access = planBuildAccess(activePlan, planWorld, planWorld.self.pos)
      const safeExits = planSafeExits(activePlan, planWorld, planWorld.self.pos, access.entrance)
      activePlan = {
        ...activePlan,
        deferredWorkItems: [...access.deferred],
        ...(access.entrance === undefined ? {} : { entranceInside: access.entrance.inside }),
        safeExits,
      }
      sensors.setObservation('plan', planObservationBoxes(activePlan, activePlan.workItems))
      planOrderId = active.order.id
      planStage = 0
      planStageKey = ''
      planStageSatisfied = -1
      planProgressAt = now()
      planLastJobAt = now()
      planBlockedReported = false
      planInsufficientReported = false
      gatherCount = 0
      if (!materialsSufficient(activePlan)) return
      events.push('plan.instantiated', now(), {
        planId: activePlan.planId,
        template: 'blueprint',
        templateVersion: parsed.blueprint.version,
        origin: activePlan.origin,
        blocks: parsed.blueprint.blocks.length,
        deferredWorkItems: [...access.deferred],
        ...(activePlan.verify === undefined ? {} : { verify: activePlan.verify }),
        ...(access.entrance === undefined ? {} : { entrance: access.entrance }),
        ...(access.blocked === undefined ? {} : { accessBlocked: access.blocked }),
      })
      return
    }

    const params = active.order.params ?? {}
    const templateId = typeof params.template === 'string' ? params.template : 'shelter-minimal'
    const template = templates.get(templateId)
    if (template === undefined) {
      events.push('plan.definition-error', now(), {
        orderId: active.order.id,
        template: templateId,
        message: 'plan template is not loaded',
      })
      orders.complete(active.order.id, 'failed')
      return
    }
    const origin = readOrigin(params.origin) ?? defaultOrigin()
    if (origin === undefined) {
      events.push('plan.definition-error', now(), {
        orderId: active.order.id,
        message: 'no origin for the fixed-point plan',
      })
      orders.complete(active.order.id, 'failed')
      return
    }
    activePlan = instantiatePlan(template, active.order.id, origin)
    const templateWorld = sensors.read()
    const templateAccess = planBuildAccess(activePlan, templateWorld, templateWorld.self.pos)
    activePlan = {
      ...activePlan,
      safeExits: planSafeExits(activePlan, templateWorld, templateWorld.self.pos, templateAccess.entrance),
    }
    sensors.setObservation('plan', planObservationBoxes(activePlan, activePlan.workItems))
    planOrderId = active.order.id
    planStage = 0
    planStageKey = ''
    planStageSatisfied = -1
    planProgressAt = now()
    planLastJobAt = now()
    planBlockedReported = false
    planInsufficientReported = false
    gatherCount = 0
    if (!materialsSufficient(activePlan)) return
    events.push('plan.instantiated', now(), {
      planId: activePlan.planId,
      template: template.id,
      templateVersion: template.version,
      origin,
    })
  }

  const defaultOrigin = (): Vec3 | undefined => {
    try {
      const base = home ?? sensors.read().self.pos
      return { x: Math.floor(base.x) + 4, y: Math.floor(base.y), z: Math.floor(base.z) }
    } catch {
      return undefined
    }
  }

  function currentConflictPolicy(): ConflictPolicy | undefined {
    const active = orders.active()
    if (active === undefined) return undefined
    const parsed = parseConflictPolicy(active.order.policy)
    return parsed.ok ? parsed.policy : undefined
  }

  function currentHazardPolicy(): HazardPolicy | undefined {
    const active = orders.active()
    if (active === undefined || !isRecord(active.order.policy)) return undefined
    return parseHazardPolicy(active.order.policy.hazards) ?? undefined
  }

  function currentMaterialPolicy(): MaterialPolicy | undefined {
    const active = orders.active()
    if (active === undefined) return undefined
    const parsed = parseMaterialPolicy(active.order.policy)
    return parsed.ok ? parsed.policy : undefined
  }

  function materialsSufficient(plan: PlanInstance): boolean {
    const policy = currentMaterialPolicy() ?? { mode: 'require-all' as const }
    try {
      const world = sensors.read()
      const shortage = planShortage(plan, world)
      if (Object.keys(shortage.missing).length === 0) return true
      const unsupported = Object.keys(shortage.missing).filter(name => materialSources(name).length === 0)
      if (policy.mode === 'require-all' || unsupported.length > 0) {
        const data = {
          planId: plan.planId,
          required: shortage.required,
          needed: shortage.needed,
          missing: shortage.missing,
          ...(unsupported.length === 0 ? {} : { unsupported }),
          basis: observationBasis(world),
        }
        events.push('plan.material-short', now(), data)
        orders.complete(plan.orderId, 'blocked')
        lastReport = data
        finishPlan()
        return false
      }
      return true
    } catch {
      return false
    }
  }

  function reconcilePending(): boolean {
    const pending = orders.pendingActions()
    if (pending.length === 0) return true
    let world: WorldView
    try {
      world = sensors.read()
    } catch {
      return true
    }
    const active = orders.active()
    const unresolved: typeof pending = []
    const reconciled: Array<{ runId: string; driverId: string; state: string }> = []

    for (const action of pending) {
      // Movement has no persistent effect; only clear/place are recorded.
      if (action.driverId !== 'clear' && action.driverId !== 'place') {
        orders.recordActionSettled(action.runId, 'no-effect')
        reconciled.push({ runId: action.runId, driverId: action.driverId, state: 'no-effect' })
        continue
      }
      if (active === undefined || (action.orderId !== undefined && action.orderId !== active.order.id)) {
        orders.recordActionSettled(action.runId, 'orphan')
        reconciled.push({ runId: action.runId, driverId: action.driverId, state: 'orphan' })
        continue
      }
      const position = actionPosition(action)
      if (position === undefined || activePlan === undefined) {
        unresolved.push(action)
        continue
      }
      const block = world.blockAt(position)
      if (block === null || !block.loaded) {
        unresolved.push(action)
        continue
      }
      if (action.driverId === 'clear') {
        if (isAirName(block.name)) {
          orders.recordActionSettled(action.runId, 'settled-by-world')
          reconciled.push({ runId: action.runId, driverId: action.driverId, state: 'settled-by-world' })
        } else {
          unresolved.push(action)
        }
        continue
      }
      const item = action.workItemId === undefined
        ? undefined
        : activePlan.workItems.find(candidate => candidate.id === action.workItemId)
      if (item?.expected !== undefined && matchesExpected(block, item.expected)) {
        orders.recordActionSettled(action.runId, 'settled-by-world')
        reconciled.push({ runId: action.runId, driverId: action.driverId, state: 'settled-by-world' })
      } else {
        unresolved.push(action)
      }
    }

    if (reconciled.length > 0) {
      events.push('action.reconciled', now(), { actions: reconciled, basis: observationBasis(world) })
    }
    if (unresolved.length === 0) return true

    const data = {
      actions: unresolved.map(action => ({
        runId: action.runId,
        driverId: action.driverId,
        keys: action.keys,
        ...(action.orderId === undefined ? {} : { orderId: action.orderId }),
        ...(action.workItemId === undefined ? {} : { workItemId: action.workItemId }),
      })),
      basis: observationBasis(world),
    }
    events.push('action.unreconciled', now(), data)
    lastReport = data
    for (const action of unresolved) {
      orders.recordActionSettled(action.runId, 'unreconciled')
    }
    if (active !== undefined && !isTerminalState(orders.get(active.order.id)?.state)) {
      orders.complete(active.order.id, 'blocked')
    }
    finishPlan()
    return false
  }

  function actionPosition(action: { keys: string; workItemId?: string }): Vec3 | undefined {
    if (action.workItemId !== undefined && activePlan !== undefined) {
      const item = activePlan.workItems.find(candidate => candidate.id === action.workItemId)
      if (item !== undefined) return itemPosition(activePlan, item)
    }
    const gather = /^gather:[^:]+:(-?\d+),(-?\d+),(-?\d+)$/u.exec(action.keys)
    if (gather !== null) {
      return { x: Number(gather[1]), y: Number(gather[2]), z: Number(gather[3]) }
    }
    return undefined
  }

  /**
   * Attribute a finished job to its work item. A stance that produced no world
   * change is counted here; placement success is world-proven, never inferred
   * from `moveTo arrived`.
   */
  function recordPlanJob(event: Extract<TrackerEvent, { kind: 'job.terminal' }>): void {
    const info = jobWorkItems.get(event.runId)
    jobWorkItems.delete(event.runId)
    if (info === undefined || activePlan === undefined) return
    if (info.orderId !== undefined && info.orderId !== activePlan.orderId) return
    if (event.state === 'interrupted') return
    const item = activePlan.workItems.find(candidate => candidate.id === info.workItemId)
    if (item === undefined) return
    let world: WorldView
    try {
      world = sensors.read()
    } catch {
      return
    }
    const attempts = readAttempts(event.observed)
    if (attempts.length > 0) {
      for (const attempt of attempts) {
        if (attempt.ok && event.state === 'succeeded') {
          planLedger.record(activePlan, item, attempt.stance, { ok: true }, world)
          continue
        }
        const code = attempt.code ?? event.code
        planLedger.record(
          activePlan,
          item,
          attempt.stance,
          { ok: false, ...(code === undefined ? {} : { code }) },
          world,
        )
      }
      return
    }
    const stance = info.stands[0]
    if (stance === undefined) return
    planLedger.record(
      activePlan,
      item,
      stance,
      event.state === 'succeeded'
        ? { ok: true }
        : { ok: false, ...(event.code === undefined ? {} : { code: event.code }) },
      world,
    )
  }

  function observationBasis(world: WorldView): JsonValue {
    return {
      at: now(),
      self: {
        x: world.self.pos.x,
        y: world.self.pos.y,
        z: world.self.pos.z,
      },
      time: {
        timeOfDay: world.time.timeOfDay,
        worldAge: world.time.worldAge,
      },
      ...(world.stale === true ? { stale: true } : {}),
    }
  }

  function setPlanObservation(plan: PlanInstance): void {
    const world = sensors.read()
    const deferred = new Set(plan.deferredWorkItems ?? [])
    const evaluation = evaluatePlan(plan, world, currentConflictPolicy())
    const stage = currentStage(plan, deferred, evaluation.states)
    sensors.setObservation('plan', planObservationBoxes(plan, stageItems(plan, deferred, stage)))
    planStage = stage
    planStageKey = ''
    planProgressAt = now()
  }

  function finishPlan(): void {
    sensors.clearObservation('plan')
    activePlan = undefined
    planOrderId = undefined
    planStage = 0
    planStageKey = ''
    planStageSatisfied = -1
    planBlockedReported = false
    planInsufficientReported = false
    jobWorkItems.clear()
  }

  function updateStageEvents(
    stage: number,
    summaries: ReturnType<typeof stageSummaries>,
    basis: JsonValue,
  ): void {
    const key = stageKey(summaries, stage)
    if (key === planStageKey) return
    const previous = planStage
    planStageKey = key
    planProgressAt = now()
    const summary = summaries[stage - 1]
    if (stage !== previous) {
      const completed = previous > 0 ? summaries[previous - 1] : undefined
      if (completed?.done === true) {
        events.push('stage.completed', now(), { stage: previous, total: completed.total, basis })
      }
      planStage = stage
      planStageSatisfied = summary?.satisfied ?? 0
      events.push('stage.started', now(), {
        ...(summary ?? { stage }),
        basis,
      } as unknown as JsonValue)
      return
    }
    // Reachability flickers as the body moves; only a real satisfied/blocked
    // change is progress worth an event.
    if (summary !== undefined && summary.satisfied !== planStageSatisfied) {
      planStageSatisfied = summary.satisfied
      events.push('stage.progress', now(), {
        ...summary,
        basis,
      } as unknown as JsonValue)
    }
  }

  function materialReport(plan: PlanInstance, world: WorldView): JsonValue {
    const inventory: Record<string, number> = {}
    for (const item of world.inventory) inventory[item.name] = (inventory[item.name] ?? 0) + item.count
    try {
      return { inventory, shortage: planShortage(plan, world) as unknown as JsonValue }
    } catch {
      return { inventory }
    }
  }

  /**
   * Formal plan block: stage/item payload first, then the terminal state. This
   * replaces the old silent `PLAN_ITEMS_BLOCKED` hold and the global 45 s
   * watchdog, which could only report "something stalled".
   */
  function blockPlanNow(stage: number, items: JsonValue, world: WorldView, basis: JsonValue): void {
    const plan = activePlan
    if (plan === undefined) return
    const summaries = stageSummaries(
      plan,
      new Set(plan.deferredWorkItems ?? []),
      evaluatePlan(plan, world, currentConflictPolicy()).states,
    )
    const data = {
      planId: plan.planId,
      orderId: plan.orderId,
      stage,
      items,
      stages: summaries as unknown as JsonValue,
      material: materialReport(plan, world),
      basis,
    }
    events.push('stage.blocked', now(), { planId: plan.planId, stage, items, basis })
    events.push('plan.blocked', now(), data)
    lastReport = data
    orders.complete(plan.orderId, 'blocked')
    finishPlan()
  }

  function enterSuspend(state: SuspensionState): void {
    suspended = true
    suspendedSince = state.at > 0 ? state.at : now()
    lastPauseNoticeAt = now()
    tracker.suspend('SUSPENDED', now())
    events.push('mind.suspended', now(), {
      since: suspendedSince,
      idleMs: state.idleMs,
      serverAge: state.serverAge,
      diagnostics: state.diagnostics as unknown as JsonValue,
      ...(options.providerStatus === undefined
        ? {}
        : { provider: options.providerStatus() as unknown as JsonValue }),
    })
  }

  function leaveSuspend(): void {
    const at = now()
    pausedMs = Math.max(0, at - suspendedSince)
    suspended = false
    suspendedSince = 0
    tracker.resume(at)
    planProgressAt = at
    planLastJobAt = at
    // Re-observe before deciding again: the world may have changed while the
    // server was frozen, and the interrupted job is not resumed mid-step.
    if (activePlan !== undefined) {
      try {
        setPlanObservation(activePlan)
      } catch {
        // The next tick retries; a stale snapshot is still reported as stale.
      }
    }
    loopRef?.invalidate()
    events.push('mind.resumed', at, { pausedMs })
  }

  /** Abandon restored queue entries and barriers; keep active work for recovery. */
  function abandonRestoredOrders(): void {
    for (const record of [...orders.all()]) {
      const restored = restoredOrders.get(record.order.id)
      if (restored === undefined) continue
      const drop = restored.state === 'queued'
        || (restored.state === 'active' && restored.verb === 'hold')
      if (!drop) continue
      if (record.state !== 'active' && record.state !== 'queued') continue
      try {
        orders.complete(record.order.id, 'abandoned', { reason: 'RESTART' })
      } catch {
        // Another path made it terminal during recovery.
      }
    }
  }

  /**
   * Timed holds expire from the active slot, not from acceptance: a hold that
   * waited behind another order starts its clock when it becomes active.
   */
  function expireTimedHold(): void {
    const active = orders.active()
    if (active === undefined || active.order.verb !== 'hold') return
    const expiresAt = holdExpiresAt(active)
    if (expiresAt === undefined || now() < expiresAt) return
    const durationMs = active.order.params?.durationMs
    try {
      orders.complete(active.order.id, 'succeeded', {
        expired: true,
        ...(typeof durationMs === 'number' ? { durationMs } : {}),
        expiresAt,
      })
    } catch {
      // Another path made the order terminal between the snapshot and expiry.
    }
  }

  /** Quota/deadline are checked every tick, even while a duty job is running. */
  function refreshDuty(): void {
    const view = duty.view(now())
    if (view === undefined || view.state !== 'active') return
    let inventory
    try {
      inventory = sensors.read().inventory
    } catch {
      return
    }
    const next = duty.refresh(inventory, now())
    if (next === undefined) return
    if (next.state === 'blocked' || next.state === 'failed') {
      const current = tracker.current()
      if (current !== null && current.keys.startsWith('duty:')) {
        tracker.abort(`DUTY_${next.state.toUpperCase()}`)
        tracker.cancelPending()
      }
    }
  }

  function emitDutyTerminal(): void {
    const terminal = duty.takeTerminal()
    if (terminal === undefined) return
    events.push('duty.terminal', now(), terminal as unknown as JsonValue)
    loopRef?.invalidate()
  }

  /**
   * Recompute the effective activity layer once per tick. Base activation is
   * the only place a wandering anchor is recorded, so every takeover starts a
   * fresh fixed anchor.
   */
  function updateActivity(): void {
    const at = now()
    const current = tracker.current()
    const keys = current?.keys
    const threat = keys !== undefined
      && (keys.startsWith('escape:') || keys.startsWith('threat.') || keys.startsWith('self.'))
    const threatKind = keys?.startsWith('threat.fight:')
      ? 'fight'
      : keys?.startsWith('self.')
        ? 'selfCare'
        : keys?.startsWith('escape:')
          ? 'escape'
          : undefined
    const active = orders.active()
    const dutyView = duty.view(at)
    const input = {
      threat,
      ...(threatKind === undefined ? {} : { threatKind }),
      ...(active === undefined ? {} : { orderVerb: active.order.verb }),
      planActive: activePlan !== undefined,
      ...(dutyView === undefined ? {} : { dutyState: dutyView.state, dutyKind: dutyView.kind }),
      base: base.view(),
    }
    const layer = resolveActivityLayer(input)
    if (layer === 'base') {
      let feet: Vec3 | undefined
      try {
        feet = sensors.read().self.pos
      } catch {
        feet = undefined
      }
      if (feet !== undefined && base.activate(at, feet)) {
        events.push('base.active', at, base.view() as unknown as JsonValue)
      }
    } else if (base.deactivate(layer)) {
      const current = tracker.current()
      if (current !== null && current.keys.startsWith('base:')) {
        tracker.abort('BASE_PREEMPTED')
        tracker.cancelPending()
      }
      events.push('base.inactive', at, { reason: layer })
    }
    duty.setPaused(layer !== 'duty', at)
    const next = buildActivityView({ ...input, base: base.view() })
    const key = JSON.stringify(next)
    activityView = next
    if (key !== lastActivityKey) {
      lastActivityKey = key
      events.push('activity.changed', at, next as unknown as JsonValue)
    }
    if (layer !== 'base') {
      lastBaseWaiting = null
      return
    }
    const waiting = base.view().waitingReason
    if (waiting === lastBaseWaiting) return
    lastBaseWaiting = waiting
    const target = base.escortTarget()
    events.push(waiting === null ? 'base.recovered' : 'base.waiting', at, {
      ...(waiting === null ? {} : { reason: waiting }),
      ...(target === undefined ? {} : { target }),
    })
  }

  /**
   * Resolve the one known target for this tick. Intent comes from the current
   * activity layer (escort target or an explicit attack order); the adapter's
   * identity index is O(1) for players and never range-limited. A missing
   * resolution does not clear the intent: the status view needs to distinguish
   * "online but not sent" from "offline".
   */
  function resolveFocus(): EntityInfo | undefined {
    const active = orders.active()
    const view = base.view()
    let intent: { name: string; kind: 'escort' | 'attack' } | undefined
    if (active !== undefined && active.order.verb === 'attack') {
      const entityId = active.order.params?.entityId
      if (typeof entityId === 'string' && entityId.length > 0) intent = { name: entityId, kind: 'attack' }
    } else if (base.isActive() && view.kind === 'escort'
      && typeof view.params.target === 'string' && view.params.target.length > 0) {
      intent = { name: view.params.target, kind: 'escort' }
    }
    if (intent === undefined) {
      focusIntent = undefined
      currentFocus = undefined
      return undefined
    }
    if (focusIntent?.name !== intent.name || focusIntent.kind !== intent.kind) {
      lastFocusAt = Number.NEGATIVE_INFINITY
      focusWasPlayer = false
    }
    focusIntent = intent
    const entity = intent.kind === 'attack'
      ? options.body.entityById?.(intent.name)
      : options.body.entityByName?.(intent.name)
    if (entity !== undefined) {
      lastFocusAt = now()
      if (entity.type === 'player' || entity.username !== undefined) focusWasPlayer = true
    }
    currentFocus = entity
    return entity
  }

  /** Diagnostics view of the resolved focus; never part of the decision snapshot. */
  function focusView(): MindFocusView | null {
    if (focusIntent === undefined) return null
    if (currentFocus !== undefined) {
      let self: Vec3 | undefined
      try {
        self = sensors.read().self.pos
      } catch {
        self = undefined
      }
      return {
        name: currentFocus.name,
        state: 'tracked',
        ...(self === undefined
          ? {}
          : { distance: round2(Math.hypot(currentFocus.position.x - self.x, currentFocus.position.z - self.z)) }),
        ...(Number.isFinite(lastFocusAt) ? { lastSeenAt: lastFocusAt } : {}),
        ageMs: 0,
      }
    }
    const online = focusIntent.kind === 'escort' ? options.body.playerOnline?.(focusIntent.name) : undefined
    return {
      name: focusIntent.name,
      state: focusIntent.kind === 'attack'
        ? 'unknown'
        : online === true
          ? 'online-out-of-range'
          : online === false && focusWasPlayer ? 'offline' : 'unknown',
      ...(Number.isFinite(lastFocusAt) ? { lastSeenAt: lastFocusAt, ageMs: now() - lastFocusAt } : {}),
    }
  }

  /**
   * The 2 s escort loss window must also end an in-flight chase. Without this
   * the move job (up to 25 s) keeps the main tree cold, so `TARGET_LOST` would
   * be delayed until the job times out instead of the promised 2 s.
   */
  function enforceEscortLoss(): void {
    if (!base.isActive() || base.view().kind !== 'escort') return
    if (currentFocus !== undefined) return
    if (!Number.isFinite(lastFocusAt)) return
    if (now() - lastFocusAt < ESCORT_LOST_GRACE_MS) return
    const current = tracker.current()
    if (current !== null && current.keys.startsWith('base:escort:')) tracker.abort('ESCORT_TARGET_LOST')
  }

  const tick = (): void => {
    const suspension = options.body.suspension?.()
    if (suspension?.suspended === true) {
      if (!suspended) enterSuspend(suspension)
      else if (now() - suspendedSince >= 60_000 && now() - lastPauseNoticeAt >= 60_000) {
        // Long pauses are reported, never turned into a blocked plan.
        lastPauseNoticeAt = now()
        events.push('plan.paused-long', now(), {
          since: suspendedSince,
          elapsedMs: now() - suspendedSince,
        })
      }
      return
    }
    if (suspended) leaveSuspend()
    expireTimedHold()
    syncPlan()
    if (!pendingReconciled) {
      pendingReconciled = true
      if (!reconcilePending()) return
    }
    refreshDuty()
    emitDutyTerminal()
    updateActivity()
    resolveFocus()
    enforceEscortLoss()
    loop.tick()
    if (activePlan === undefined) return
    try {
      const world = sensors.read()
      const basis = observationBasis(world)
      const deferred = new Set(activePlan.deferredWorkItems ?? [])
      const evaluation = evaluatePlan(activePlan, world, currentConflictPolicy())
      const stage = currentStage(activePlan, deferred, evaluation.states)
      const summaries = stageSummaries(activePlan, deferred, evaluation.states)
      updateStageEvents(stage, summaries, basis)
      if (stage !== planStage) {
        planStage = stage
        sensors.setObservation('plan', planObservationBoxes(activePlan, stageItems(activePlan, deferred, stage)))
      }
      // Any started job is progress; only a genuinely silent plan can time out.
      if (planLastJobAt > planProgressAt) planProgressAt = planLastJobAt
      if (now() - planProgressAt >= 60_000 && tracker.state() === 'idle' && !evaluation.satisfied) {
        const data = {
          planId: activePlan.planId,
          orderId: activePlan.orderId,
          elapsedMs: now() - planProgressAt,
          stage,
          stages: summaries as unknown as JsonValue,
          items: planLedger.entries(activePlan).map(entry => ({
            workItemId: entry.itemId,
            stage: entry.stage,
            target: entry.target,
            ...(entry.blocked === undefined
              ? {}
              : { reason: entry.blocked.reason, detail: entry.blocked.detail }),
            ...(entry.lastCode === undefined ? {} : { lastCode: entry.lastCode }),
          })) as unknown as JsonValue,
          basis,
        }
        events.push('plan.stalled', now(), data)
        blockPlanNow(stage, data.items, world, basis)
        return
      }
      if (tracker.state() !== 'idle') return
      const policy = currentConflictPolicy()
      if (policy?.mode === 'abort'
        && [...evaluation.states.values()].some(state => state.kind === 'blocked' && state.reason === 'CONFLICT')) {
        const data = { planId: activePlan.planId, state: 'aborted', basis }
        events.push('plan.abort', now(), data)
        orders.complete(activePlan.orderId, 'failed')
        lastReport = data
        finishPlan()
        return
      }
      if (!evaluation.satisfied) return
      // Final geometry is verified against one fresh, fully observed snapshot.
      const verifyWorld = sensors.setObservation('plan', verifyObservationBoxes(activePlan))
      const verifyBasis = observationBasis(verifyWorld)

      let terminal: 'succeeded' | 'failed' | undefined
      let verify: VerifyResult | undefined
      if (activePlan.template === 'blueprint') {
        // Final geometry is the authority; a place accepted then destroyed is
        // refuted here instead of being accepted as a permanent success.
        verify = verifyBlueprint(activePlan, verifyWorld)
        if (verify.state === 'confirmed' && activePlan.verify !== undefined) {
          verify = verifyRoom(activePlan, activePlan.verify, verifyWorld)
        }
      } else if (activePlan.verify !== undefined) {
        verify = verifyRoom(activePlan, activePlan.verify, verifyWorld)
      }
      if (verify !== undefined) {
        if (verify.state === 'confirmed') {
          terminal = 'succeeded'
        } else if (verify.state === 'refuted') {
          terminal = 'failed'
          const data = { ...verify, basis: verifyBasis }
          events.push('plan.verify', now(), data)
          lastReport = data
        } else if (!planInsufficientReported) {
          planInsufficientReported = true
          const data = { ...verify, basis: verifyBasis }
          events.push('plan.insufficient', now(), data)
          lastReport = data
        }
      } else {
        terminal = 'succeeded'
      }
      if (terminal === undefined) return
      orders.complete(activePlan.orderId, terminal)
      const data = { planId: activePlan.planId, state: terminal, basis: verifyBasis }
      events.push('plan.terminal', now(), data)
      lastReport = data
      finishPlan()
    } catch (error) {
      events.push('mind.error', now(), { message: error instanceof Error ? error.message : String(error) })
    }
  }

  let orderSeq = 0
  return {
    tick,
    status(): MindStatusView {
      const current = tracker.current()
      const fault = tracker.fault()
      const active = orders.active()
      let planView: MindStatusView['plan']
      if (activePlan !== undefined) {
        try {
          const evaluation = evaluatePlan(activePlan, sensors.read(), currentConflictPolicy())
          const deferred = new Set(activePlan.deferredWorkItems ?? [])
          const summaries = stageSummaries(activePlan, deferred, evaluation.states)
          const stage = currentStage(activePlan, deferred, evaluation.states)
          planView = {
            id: activePlan.planId,
            template: activePlan.template,
            satisfied: evaluation.satisfied,
            blocked: evaluation.blocked,
            stage,
            total: summaries.reduce((total, summary) => total + summary.total, 0),
            done: summaries.reduce((total, summary) => total + summary.satisfied, 0),
          }
        } catch {
          planView = { id: activePlan.planId, template: activePlan.template, satisfied: false, blocked: false }
        }
      } else {
        planView = null
      }
      return {
        ...(options.identity === undefined
          ? {}
          : { identity: { worldId: options.identity.worldId, characterId: options.identity.characterId } }),
        worldTime: worldTimeView(sensors.read().time),
        tracker: tracker.state(),
        job: current === null ? null : { runId: current.job.runId, driverId: current.job.driverId },
        fault: fault === null ? null : { code: fault.code, since: fault.since },
        home: home === undefined ? null : { x: home.x, y: home.y, z: home.z },
        activeOrder: active === undefined ? null : { id: active.order.id, verb: active.order.verb },
        queuedOrders: orders.queued().length,
        eventsSeq: events.lastSeq(),
        ...(suspended ? { suspended: true } : {}),
        plan: planView,
        duty: duty.view(now()) ?? null,
        baseActivity: base.view(),
        focus: focusView(),
        activity: activityView ?? null,
        reaction: reaction.view(),
        metrics: metrics.view(),
      }
    },
    report(): JsonValue | null {
      return lastReport
    },
    enqueueOrder(input: unknown): MindOrderResult {
      const id = isRecord(input) && typeof input.id === 'string'
        ? input.id
        : `ord-${Date.now().toString(36)}-${++orderSeq}`
      const record = orders.enqueue(isRecord(input) ? { ...input, id } : input)
      const active = orders.active()
      const queued = orders.queued().length
      const blocked = active !== undefined && active.order.id !== record.order.id
        ? { id: active.order.id, verb: active.order.verb }
        : undefined
      const queue: MindQueueSummary = {
        active: active === undefined ? null : { id: active.order.id, verb: active.order.verb },
        queued,
        ...(blocked === undefined ? {} : { blockedBy: blocked }),
        ...(blocked?.verb === 'hold'
          ? { release: `p2_cancel {id:"${blocked.id}"} or {all:true}` }
          : {}),
        ...(record.order.verb === 'hold' && active?.order.id === record.order.id
          ? {
              holdsActiveSlot: true,
              queuedBehind: queued,
              release: `p2_cancel {id:"${record.order.id}"} or {all:true}`,
              ...(holdExpiresAt(record) === undefined ? {} : { expiresAt: holdExpiresAt(record) as number }),
            }
          : {}),
      }
      return { id: record.order.id, state: record.state, queue }
    },
    cancelOrder(id: string): { id: string; state: string } {
      const activeBefore = orders.active()
      const record = orders.cancel(id)
      if (planOrderId === id || activeBefore?.order.id === id) {
        tracker.abort()
        finishPlan()
      }
      return { id: record.order.id, state: record.state }
    },
    startDuty(input: unknown): MindDutyStartResult {
      const spec = duty.prepare(input)
      const at = now()
      let inventory: Item[]
      try {
        inventory = sensors.read().inventory
      } catch {
        inventory = []
      }
      const previous = duty.view(at) ?? null
      let previousDuty: DutyStatusView | null = previous
      if (previous?.state === 'active') {
        const cancelled = duty.cancel(at, 'REPLACED_BY_NEW_DUTY')
        if (cancelled !== undefined) {
          previousDuty = cancelled
          const terminal = duty.takeTerminal()
          if (terminal !== undefined) {
            events.push('duty.terminal', at, terminal as unknown as JsonValue)
          }
        }
      }
      const current = tracker.current()
      if (current !== null && current.keys.startsWith('duty:')) {
        tracker.abort('DUTY_REPLACED')
        tracker.cancelPending()
      }
      const started = duty.begin(spec, at, inventory)
      events.push('duty.started', at, started as unknown as JsonValue)
      loopRef?.invalidate()
      return { previousDuty, started }
    },
    stopDuty(): DutyStatusView | null {
      const at = now()
      const current = tracker.current()
      if (current !== null && current.keys.startsWith('duty:')) {
        tracker.abort('DUTY_CANCELLED')
        tracker.cancelPending()
      }
      const view = duty.stop(at)
      if (view !== undefined) {
        const terminal = duty.takeTerminal()
        if (terminal !== undefined) {
          events.push('duty.terminal', at, terminal as unknown as JsonValue)
          loopRef?.invalidate()
        }
      }
      return view ?? null
    },
    baseActivity(): BaseActivityView {
      return base.view()
    },
    setBaseActivity(input: unknown): BaseActivityView {
      let feet: Vec3 | undefined
      try {
        feet = sensors.read().self.pos
      } catch {
        feet = undefined
      }
      const view = base.set(input, now(), feet)
      const current = tracker.current()
      if (current !== null && current.keys.startsWith('base:')) {
        tracker.abort('BASE_ACTIVITY_CHANGED')
        tracker.cancelPending()
      }
      events.push('base.activity', now(), view as unknown as JsonValue)
      loopRef?.invalidate()
      return view
    },
    reactionPolicy(): ReactionPolicyView {
      return reaction.view()
    },
    setReactionPolicy(input: unknown): ReactionPolicyView {
      const view = reaction.set(input, now())
      fight.reset()
      const current = tracker.current()
      if (current !== null && current.keys.startsWith('threat.fight:')) {
        tracker.abort('POLICY_CHANGED')
        tracker.cancelPending()
      }
      events.push('policy.changed', now(), view as unknown as JsonValue)
      loopRef?.invalidate()
      return view
    },
    resetReactionPolicy(): ReactionPolicyView {
      const view = reaction.reset(now())
      fight.reset()
      const current = tracker.current()
      if (current !== null && current.keys.startsWith('threat.fight:')) {
        tracker.abort('POLICY_CHANGED')
        tracker.cancelPending()
      }
      events.push('policy.changed', now(), view as unknown as JsonValue)
      loopRef?.invalidate()
      return view
    },
    listOrders(): { active: MindOrderView | null; queued: MindOrderView[]; queueBlockedBy: { id: string; verb: string } | null } {
      const active = orders.active()
      return {
        active: active === undefined ? null : viewOf(active, orderDiagnostics.get(active.order.id)),
        queued: orders.queued().map(record => viewOf(record, orderDiagnostics.get(record.order.id))),
        queueBlockedBy: active !== undefined && active.order.verb === 'hold'
          ? { id: active.order.id, verb: active.order.verb }
          : null,
      }
    },
    cancelAll(): { cancelled: number } {
      const targets = orders.all().filter(record => record.state === 'queued' || record.state === 'active')
      let cancelled = 0
      for (const record of targets) {
        try {
          orders.cancel(record.order.id)
          cancelled += 1
        } catch {
          // A record that became terminal between the snapshot and the cancel is
          // already what the caller asked for.
        }
      }
      tracker.abort()
      finishPlan()
      return { cancelled }
    },
    sinceEvents(seq: number, limit?: number): { events: MindEvent[]; seq: number } {
      return {
        events: events.since(seq, limit),
        seq: events.lastSeq(),
      }
    },
    watchedBlock(p: Vec3): string | undefined {
      if (activePlan === undefined) return undefined
      const item = activePlan.workItems.find(candidate => {
        const at = itemPosition(activePlan as PlanInstance, candidate)
        return at.x === p.x && at.y === p.y && at.z === p.z
      })
      return item?.expected?.name
    },
    orders,
    events,
  }
}

function holdExpiresAt(record: {
  order: { verb: string; params?: Record<string, JsonValue> }
  activeAt?: number
  acceptedAt: number
}): number | undefined {
  if (record.order.verb !== 'hold') return undefined
  const duration = record.order.params?.durationMs
  if (typeof duration !== 'number' || !Number.isFinite(duration)) return undefined
  const startedAt = record.activeAt ?? record.acceptedAt
  return startedAt + duration
}

function viewOf(
  record: {
    order: { id: string; verb: string; params?: Record<string, JsonValue> }
    state: string
    acceptedAt: number
    activeAt?: number
  },
  debug?: { attempts: number; lastCode?: string; blockedKeys?: string[] },
): MindOrderView {
  const expiresAt = holdExpiresAt(record)
  return {
    id: record.order.id,
    verb: record.order.verb,
    state: record.state,
    ...(debug === undefined ? {} : { attempts: debug.attempts }),
    ...(debug?.lastCode === undefined ? {} : { lastCode: debug.lastCode }),
    ...(debug?.blockedKeys === undefined ? {} : { blockedKeys: debug.blockedKeys }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/** How long a reported damage source stays usable as `EvalCtx.attacker`. */
const ATTACKER_WINDOW_MS = 5_000

const PRIMITIVE_ORDER_VERBS = new Set([
  'go', 'attack', 'dig', 'collect', 'traverse', 'place', 'equip', 'use', 'craft', 'container',
])

/** Verbs that may be retried inside the same order before it becomes blocked. */
const RETRYABLE_ORDER_VERBS = new Set([
  'go', 'attack', 'dig', 'place', 'use', 'craft', 'container',
])

/** Failures that retrying the same target cannot fix. */
const NON_RETRYABLE_CODES = new Set([
  'BUDGET_EXCEEDED', 'BAD_ARGS', 'STALE_WRITE', 'DEFINITION_ERROR',
  'ERR_ASSERTION',
  'TOOL_INSUFFICIENT', 'BLOCK_UNBREAKABLE', 'DIG_NO_BLOCK', 'APPROACH_NO_STAND',
  'EQUIP_NO_ITEM',
  // A timeout after the request may have reached the server is not safe to
  // replay; the agent must re-observe and decide.
  'ACT_UNCONFIRMED', 'ACTION_DENIED',
  'DIG_PARTIAL', 'DIG_VOLUME_TOO_LARGE',
  'BODY_OVERLAP', 'GOAL_NOT_STANDABLE', 'PLACE_BLOCKED_BY_SELF',
  'PLACE_TARGET_OCCUPIED', 'PLACE_OFF_TARGET', 'PLACE_ITEM_CONSUMED',
  'PLACE_READBACK_MISMATCH', 'PLACE_NO_ITEM', 'PLACE_UNSUPPORTED', 'NO_SUPPORT',
  'PICKUP_UNREACHABLE', 'PICKUP_NOT_COLLECTED', 'PICKUP_ENTITY_GONE',
  'PICKUP_INVENTORY_FULL', 'PICKUP_MERGED', 'PICKUP_NO_RETURN',
  'CRAFT_NO_TABLE', 'CRAFT_NO_INGREDIENTS', 'CRAFT_UNKNOWN_RECIPE', 'CRAFT_INCOMPLETE',
  'ATTACK_TARGET_LOST', 'ATTACK_TARGET_PROTECTED', 'ATTACK_TARGET_CHANGED',
  'ATTACK_CHASE_LIMIT', 'ATTACK_NO_HIT', 'ATTACK_NOT_KILLED',
  // Risky motion is explicitly opt-in: retrying an unvalidated path is the
  // Agent's call, not the order loop's.
  'VANILLA_NO_PATH', 'VANILLA_STUCK', 'VANILLA_TIMEOUT',
])

function shouldRetryOrderJob(event: TrackerEvent, verb: string | undefined): boolean {
  if (event.kind !== 'job.terminal') return false
  if (event.state !== 'failed' || event.blocked === true) return false
  if (verb === undefined || !RETRYABLE_ORDER_VERBS.has(verb)) return false
  return !(event.code !== undefined && NON_RETRYABLE_CODES.has(event.code))
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseActionKeys(keys: string): { planId?: string; workItemId?: string } | undefined {
  const match = /^plan:([^:]+):(.+)$/u.exec(keys)
  if (match === null) return undefined
  const planId = match[1]
  const workItemId = match[2]
  return planId === undefined || workItemId === undefined ? undefined : { planId, workItemId }
}

function isTerminalState(state: string | undefined): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'blocked'
    || state === 'cancelled' || state === 'abandoned'
}

function readOrigin(value: unknown): Vec3 | undefined {
  if (!isRecord(value)) return undefined
  const { x, y, z } = value
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return undefined
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
}

function readPlanDefinitions(dir: string): Record<string, unknown> {
  const definitions: Record<string, unknown> = {}
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const name = file.slice(0, -'.json'.length)
    try {
      definitions[name] = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch (error) {
      throw p2Error(
        ErrorCodes.DEFINITION_ERROR,
        'validation',
        `plan template ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { module: 'body.mind' },
      )
    }
  }
  return definitions
}

function verifyRoom(plan: PlanInstance, spec: VerifySpec, world: WorldView): VerifyResult {
  return spec.kind === 'usable-room'
    ? verifyUsableRoom(plan, spec, world)
    : verifySealedRoom(plan, spec, world)
}

/** Read the stance list a started job will try, for item-level accounting. */
function candidateStances(params: Record<string, JsonValue>): Vec3[] {
  const stands = params.stands
  if (Array.isArray(stands)) {
    const result: Vec3[] = []
    for (const entry of stands) {
      if (!isRecord(entry)) continue
      const { x, y, z } = entry
      if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') result.push({ x, y, z })
    }
    if (result.length > 0) return result
  }
  const { x, y, z } = params
  if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
    return [{ x, y, z }]
  }
  return []
}

function readAttempts(observed: JsonValue | undefined): Array<{ stance: Vec3; ok: boolean; code?: string }> {
  if (!isRecord(observed)) return []
  const attempts = observed.attempts
  if (!Array.isArray(attempts)) return []
  const result: Array<{ stance: Vec3; ok: boolean; code?: string }> = []
  for (const entry of attempts) {
    if (!isRecord(entry)) continue
    const stance = entry.stance
    if (!isRecord(stance)) continue
    const { x, y, z } = stance
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') continue
    result.push({
      stance: { x, y, z },
      ok: entry.ok === true,
      ...(typeof entry.code === 'string' ? { code: entry.code } : {}),
    })
  }
  return result
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

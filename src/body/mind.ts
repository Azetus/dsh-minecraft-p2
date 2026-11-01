import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { p2Error } from '../contracts/protocol.ts'
import type { MindStatusView } from '../contracts/protocol.ts'
import type { JsonValue } from '../contracts/types.ts'
import { ErrorCodes } from '../contracts/types.ts'
import { createMoveDriver, MOVE_DRIVER_ID } from '../mind/drivers/move.ts'
import { createClearDriver, CLEAR_DRIVER_ID } from '../mind/drivers/clear.ts'
import { createCheckDriver, CHECK_DRIVER_ID } from '../mind/drivers/check.ts'
import { createAttackDriver, ATTACK_DRIVER_ID } from '../mind/drivers/attack.ts'
import { createDigDriver, DIG_DRIVER_ID } from '../mind/drivers/dig.ts'
import { createContainerDriver, CONTAINER_DRIVER_ID } from '../mind/drivers/container.ts'
import { createPlaceDriver, PLACE_DRIVER_ID } from '../mind/drivers/place.ts'
import { createEquipDriver, EQUIP_DRIVER_ID } from '../mind/drivers/equip.ts'
import { createCraftDriver, CRAFT_DRIVER_ID } from '../mind/drivers/craft.ts'
import { createUseDriver, USE_DRIVER_ID } from '../mind/drivers/use.ts'
import { createTraverseDriver, TRAVERSE_DRIVER_ID } from '../mind/drivers/traverse.ts'
import { createStepDriver } from '../mind/drivers/step.ts'
import { MindEvents } from '../mind/events.ts'
import type { MindEvent } from '../mind/events.ts'
import { createEscapeGiver } from '../mind/givers/escape.ts'
import { createCheckGiver, checkPosition } from '../mind/givers/check.ts'
import { createGoOrderGiver, createHoldOrderGiver, createTraverseGiver } from '../mind/givers/orders.ts'
import { createAttackOrderGiver } from '../mind/givers/combat.ts'
import { createDigOrderGiver } from '../mind/givers/dig.ts'
import { createContainerOrderGiver } from '../mind/givers/container.ts'
import {
  createCraftOrderGiver,
  createEquipOrderGiver,
  createPlaceOrderGiver,
  createUseOrderGiver,
} from '../mind/givers/primitives.ts'
import { createPlanGiver } from '../mind/givers/plan.ts'
import { createMaterialGiver } from '../mind/givers/material.ts'
import { MindLoop } from '../mind/loop.ts'
import { OrderStore } from '../mind/orders.ts'
import { planShortage, materialSources } from '../mind/materials.ts'
import { blueprintPlan, parseBlueprint } from '../mind/blueprint.ts'
import {
  evaluatePlan,
  instantiatePlan,
  isAirName,
  itemPosition,
  loadPlanTemplates,
  matchesExpected,
} from '../mind/plan.ts'
import type { PlanInstance } from '../mind/plan.ts'
import { parseConflictPolicy, parseMaterialPolicy } from '../mind/policy.ts'
import type { ConflictPolicy, MaterialPolicy } from '../mind/policy.ts'
import { parseHazardPolicy } from '../port/terrain.ts'
import type { HazardPolicy } from '../port/terrain.ts'
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
import type { VerifyResult } from '../mind/verify/sealed-room.ts'
import type { ClientPort, Vec3 } from '../port/index.ts'

export type MindOrderView = { id: string; verb: string; state: string }

export type MindRuntime = {
  tick(): void
  status(): MindStatusView
  /** Latest deviation/terminal digest for `p2_report`; null while healthy. */
  report(): JsonValue | null
  enqueueOrder(input: unknown): { id: string; state: string }
  cancelOrder(id: string): { id: string; state: string }
  listOrders(): { active: MindOrderView | null; queued: MindOrderView[] }
  sinceEvents(seq: number, limit?: number): { events: MindEvent[]; seq: number }
  /** Expected block name at a watched plan position, if any. */
  watchedBlock(p: Vec3): string | undefined
  orders: OrderStore
  events: MindEvents
}

export type CreateMindOptions = {
  port: ClientPort
  home?: Vec3
  /** Recovery identity from the provider; defVersion is computed from plans. */
  identity?: { worldId: string; characterId: string; defVersion?: string }
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
export function createMind(options: CreateMindOptions): MindRuntime {
  const now = options.now ?? (() => Date.now())
  const registry = new Registry()
  let activeOrderLookup: (() => ReturnType<OrderStore['active']>) | undefined
  registry.registerDriver({ id: MOVE_DRIVER_ID, driver: createMoveDriver() })
  registry.registerDriver({ id: CLEAR_DRIVER_ID, driver: createClearDriver() })
  registry.registerDriver({ id: CHECK_DRIVER_ID, driver: createCheckDriver() })
  registry.registerDriver({ id: ATTACK_DRIVER_ID, driver: createAttackDriver() })
  registry.registerDriver({ id: DIG_DRIVER_ID, driver: createDigDriver() })
  registry.registerDriver({ id: CONTAINER_DRIVER_ID, driver: createContainerDriver() })
  registry.registerDriver({ id: PLACE_DRIVER_ID, driver: createPlaceDriver() })
  registry.registerDriver({ id: EQUIP_DRIVER_ID, driver: createEquipDriver() })
  registry.registerDriver({ id: CRAFT_DRIVER_ID, driver: createCraftDriver() })
  registry.registerDriver({ id: USE_DRIVER_ID, driver: createUseDriver() })
  registry.registerDriver({ id: TRAVERSE_DRIVER_ID, driver: createTraverseDriver() })
  registry.registerDriver({ id: 'prepare', driver: createStepDriver('prepare') })
  registry.registerDriver({ id: 'enter', driver: createStepDriver('enter') })
  registry.registerGiver({ id: 'escape', factory: () => createEscapeGiver() })
  registry.registerGiver({ id: 'check', factory: () => createCheckGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.go', factory: () => createGoOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.attack', factory: () => createAttackOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.dig', factory: () => createDigOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.container', factory: () => createContainerOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.place', factory: () => createPlaceOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.equip', factory: () => createEquipOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.use', factory: () => createUseOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.craft', factory: () => createCraftOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.traverse', factory: () => createTraverseGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'order.hold', factory: () => createHoldOrderGiver(() => activeOrderLookup?.()) })
  registry.registerGiver({ id: 'plan.work', factory: () => createPlanGiver() })
  registry.registerGiver({ id: 'material.gather', factory: () => createMaterialGiver() })

  const loaded = loadTrees(TREE_DEFINITIONS, registry)
  if (!loaded.ok) throw loaded.error

  const planDefinitions = readPlanDefinitions(options.plansDir)
  const loadedPlans = loadPlanTemplates(planDefinitions)
  if (!loadedPlans.ok) throw loadedPlans.error
  const templates = loadedPlans.templates

  const events = new MindEvents()
  for (const event of ['move.started', 'move.progress', 'move.no_path', 'move.stuck', 'move.finished', 'move.door', 'move.unstick-dig'] as const) {
    options.port.on(event, data => events.push(event, now(), data))
  }
  let lastReport: JsonValue | null = null
  let loopRef: MindLoop | undefined

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
      if (event.kind === 'order.accepted' || event.kind === 'order.terminal') {
        loopRef?.invalidate()
      }
    },
  })
  orders.restore()
  activeOrderLookup = () => orders.active()

  const sensors = new Sensors({ port: options.port, now })
  const home = options.home
  let activePlan: PlanInstance | undefined
  let planOrderId: string | undefined
  let planBlockedReported = false
  let planInsufficientReported = false
  let gatherCount = 0
  let pendingReconciled = false
  let crashedOnce = false
  const crashMarker = join(dirname(options.journalPath), 'crash-after-pending.done')
  const crashOnce = options.crashAfterPending === true && !existsSync(crashMarker)
  const tracker = new JobTracker({
    port: options.port,
    driver: id => registry.driver(id),
    world: () => sensors.read(),
    now,
    beforeStart: (candidate, job) => {
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
      const order = event.kind === 'job.terminal' && event.orderId !== undefined
        ? orders.get(event.orderId)
        : undefined
      const retry = shouldRetryOrderJob(event, order?.order.verb)
      const data = (retry ? { ...event, retry: true } : event) as unknown as JsonValue
      events.push(event.kind, event.at, data)
      if (event.kind === 'job.terminal' && isRecord(event)
        && typeof event.runId === 'string') {
        orders.recordActionSettled(
          event.runId,
          typeof event.state === 'string' ? event.state : 'unknown',
          typeof event.code === 'string' ? event.code : undefined,
        )
      }
      if (event.kind === 'job.terminal' && event.driverId === 'check') {
        const observed = event.observed
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
              ...(event.observed === undefined ? {} : { observed: event.observed }),
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
    },
  })
  const loop = new MindLoop({
    world: () => sensors.read(),
    evaluate: (name, ctx, world) => evaluateTree(name, loaded.trees, registry, ctx, world),
    tracker,
    now,
    ...(options.home === undefined ? {} : { home: options.home }),
    plan: () => activePlan,
    orderVerb: () => orders.active()?.order.verb,
    orderParams: () => orders.active()?.order.params,
    hazards: () => currentHazardPolicy(),
    conflictPolicy: () => currentConflictPolicy(),
    materialPolicy: () => currentMaterialPolicy(),
    gatherCount: () => gatherCount,
    onEvent: event => {
      events.push(event.kind, event.at, event.data)
      if (event.kind === 'job.started' && isRecord(event.data)
        && typeof event.data.keys === 'string' && event.data.keys.startsWith('gather:')) {
        gatherCount += 1
      }
      if (event.kind === 'mind.definition-error' || event.kind === 'mind.error') lastReport = event.data
      if (event.kind === 'mind.hold' && isRecord(event.data) && event.data.notify !== false) {
        lastReport = event.data
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
      if (planOrderId !== undefined) {
        activePlan = undefined
        planOrderId = undefined
        planBlockedReported = false
        planInsufficientReported = false
      }
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
      planOrderId = active.order.id
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
    planOrderId = active.order.id
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
        activePlan = undefined
        planOrderId = undefined
        planBlockedReported = false
        planInsufficientReported = false
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
    activePlan = undefined
    planOrderId = undefined
    planBlockedReported = false
    planInsufficientReported = false
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

  const tick = (): void => {
    syncPlan()
    if (!pendingReconciled) {
      pendingReconciled = true
      if (!reconcilePending()) return
    }
    loop.tick()
    if (activePlan === undefined || tracker.state() !== 'idle') return
    try {
      const world = sensors.read()
      const basis = observationBasis(world)
      const evaluation = evaluatePlan(activePlan, world, currentConflictPolicy())
      const policy = currentConflictPolicy()
      if (policy?.mode === 'abort'
        && [...evaluation.states.values()].some(state => state.kind === 'blocked' && state.reason === 'CONFLICT')) {
        const data = { planId: activePlan.planId, state: 'aborted', basis }
        events.push('plan.abort', now(), data)
        orders.complete(activePlan.orderId, 'failed')
        lastReport = data
        activePlan = undefined
        planOrderId = undefined
        planBlockedReported = false
        planInsufficientReported = false
        return
      }
      if (!planBlockedReported && evaluation.blocked) {
        planBlockedReported = true
        const blocked = [...evaluation.states.entries()]
          .filter(([, state]) => state.kind === 'blocked')
          .map(([id, state]) => {
            const item = activePlan?.workItems.find(candidate => candidate.id === id)
            const position = item === undefined ? undefined : itemPosition(activePlan as PlanInstance, item)
            const current = position === undefined ? null : world.blockAt(position)
            return {
              id,
              reason: (state as { reason: string }).reason,
              ...(item?.expected === undefined ? {} : { expected: item.expected.name }),
              ...(current === null ? {} : { current: current.name }),
            }
          })
        const data = { planId: activePlan.planId, blocked, basis }
        events.push('plan.blocked', now(), data)
        lastReport = data
      }
      if (!evaluation.satisfied) return

      let terminal: 'succeeded' | 'failed' | undefined
      let verify: VerifyResult | undefined
      if (activePlan.template === 'blueprint') {
        // Final geometry is the authority; a place accepted then destroyed is
        // refuted here instead of being accepted as a permanent success.
        verify = verifyBlueprint(activePlan, world)
        if (verify.state === 'confirmed' && activePlan.verify !== undefined) {
          verify = verifySealedRoom(activePlan, activePlan.verify, world)
        }
      } else if (activePlan.verify !== undefined) {
        verify = verifySealedRoom(activePlan, activePlan.verify, world)
      }
      if (verify !== undefined) {
        if (verify.state === 'confirmed') {
          terminal = 'succeeded'
        } else if (verify.state === 'refuted') {
          terminal = 'failed'
          const data = { ...verify, basis }
          events.push('plan.verify', now(), data)
          lastReport = data
        } else if (!planInsufficientReported) {
          planInsufficientReported = true
          const data = { ...verify, basis }
          events.push('plan.insufficient', now(), data)
          lastReport = data
        }
      } else {
        terminal = 'succeeded'
      }
      if (terminal === undefined) return
      orders.complete(activePlan.orderId, terminal)
      const data = { planId: activePlan.planId, state: terminal, basis }
      events.push('plan.terminal', now(), data)
      lastReport = data
      activePlan = undefined
      planOrderId = undefined
      planBlockedReported = false
      planInsufficientReported = false
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
          planView = {
            id: activePlan.planId,
            template: activePlan.template,
            satisfied: evaluation.satisfied,
            blocked: evaluation.blocked,
          }
        } catch {
          planView = { id: activePlan.planId, template: activePlan.template, satisfied: false, blocked: false }
        }
      } else {
        planView = null
      }
      return {
        tracker: tracker.state(),
        job: current === null ? null : { runId: current.job.runId, driverId: current.job.driverId },
        fault: fault === null ? null : { code: fault.code, since: fault.since },
        home: home === undefined ? null : { x: home.x, y: home.y, z: home.z },
        activeOrder: active === undefined ? null : { id: active.order.id, verb: active.order.verb },
        queuedOrders: orders.queued().length,
        eventsSeq: events.lastSeq(),
        plan: planView,
      }
    },
    report(): JsonValue | null {
      return lastReport
    },
    enqueueOrder(input: unknown): { id: string; state: string } {
      const id = isRecord(input) && typeof input.id === 'string'
        ? input.id
        : `ord-${Date.now().toString(36)}-${++orderSeq}`
      const record = orders.enqueue(isRecord(input) ? { ...input, id } : input)
      return { id: record.order.id, state: record.state }
    },
    cancelOrder(id: string): { id: string; state: string } {
      const activeBefore = orders.active()
      const record = orders.cancel(id)
      if (planOrderId === id || activeBefore?.order.id === id) {
        tracker.abort()
        activePlan = undefined
        planOrderId = undefined
        planBlockedReported = false
        planInsufficientReported = false
      }
      return { id: record.order.id, state: record.state }
    },
    listOrders(): { active: MindOrderView | null; queued: MindOrderView[] } {
      const active = orders.active()
      return {
        active: active === undefined ? null : viewOf(active),
        queued: orders.queued().map(viewOf),
      }
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

function viewOf(record: { order: { id: string; verb: string }; state: string }): MindOrderView {
  return { id: record.order.id, verb: record.order.verb, state: record.state }
}

const PRIMITIVE_ORDER_VERBS = new Set([
  'go', 'attack', 'dig', 'traverse', 'place', 'equip', 'use', 'craft', 'container',
])

/** Verbs that may be retried inside the same order before it becomes blocked. */
const RETRYABLE_ORDER_VERBS = new Set([
  'go', 'attack', 'dig', 'place', 'use', 'craft', 'container',
])

/** Failures that retrying the same target cannot fix. */
const NON_RETRYABLE_CODES = new Set([
  'BUDGET_EXCEEDED', 'BAD_ARGS', 'STALE_WRITE', 'CAPABILITY_MISSING', 'DEFINITION_ERROR',
  'TOOL_INSUFFICIENT', 'BLOCK_UNBREAKABLE', 'DIG_NO_BLOCK', 'HARVEST_NO_DROP',
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

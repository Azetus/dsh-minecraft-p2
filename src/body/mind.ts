import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { p2Error } from '../contracts/protocol.ts'
import type { MindStatusView } from '../contracts/protocol.ts'
import type { JsonValue } from '../contracts/types.ts'
import { ErrorCodes } from '../contracts/types.ts'
import { createMoveDriver, MOVE_DRIVER_ID } from '../mind/drivers/move.ts'
import { MindEvents } from '../mind/events.ts'
import type { MindEvent } from '../mind/events.ts'
import { createEscapeGiver } from '../mind/givers/escape.ts'
import { createGoHomeGiver, createWanderGiver } from '../mind/givers/home.ts'
import { createPlanGiver } from '../mind/givers/plan.ts'
import { MindLoop } from '../mind/loop.ts'
import { OrderStore } from '../mind/orders.ts'
import { Registry } from '../mind/registry.ts'
import { Sensors } from '../mind/sensors.ts'
import { JobTracker } from '../mind/tracker.ts'
import { evaluateTree, loadTrees } from '../mind/tree.ts'
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
  orders: OrderStore
  events: MindEvents
}

export type CreateMindOptions = {
  port: ClientPort
  home?: Vec3
  contentDir: string
  journalPath: string
  now?: () => number
}

/**
 * Compose the M1 mind: registry, content trees, sensors, tracker, orders and
 * the 50 ms loop. Definition or journal failures abort body start rather than
 * running with half-loaded content.
 */
export function createMind(options: CreateMindOptions): MindRuntime {
  const now = options.now ?? (() => Date.now())
  const registry = new Registry()
  registry.registerDriver({ id: MOVE_DRIVER_ID, driver: createMoveDriver() })
  registry.registerGiver({ id: 'escape', factory: () => createEscapeGiver() })
  registry.registerGiver({ id: 'goHome', factory: () => createGoHomeGiver() })
  registry.registerGiver({ id: 'wander', factory: () => createWanderGiver() })
  registry.registerGiver({ id: 'plan.work', factory: () => createPlanGiver() })

  const definitions = readTreeDefinitions(options.contentDir)
  if (definitions.constant === undefined || definitions.main === undefined) {
    throw p2Error(
      ErrorCodes.DEFINITION_ERROR,
      'validation',
      'content/trees must define both "constant" and "main"',
      { module: 'body.mind' },
    )
  }
  const loaded = loadTrees(definitions, registry)
  if (!loaded.ok) throw loaded.error

  const events = new MindEvents()
  let lastReport: JsonValue | null = null

  const orders = new OrderStore({
    journalPath: options.journalPath,
    now,
    onEvent: event => {
      events.push(event.kind, event.at, event as unknown as JsonValue)
    },
  })
  orders.restore()

  const sensors = new Sensors({ port: options.port, now })
  const tracker = new JobTracker({
    port: options.port,
    driver: id => registry.driver(id),
    world: () => sensors.read(),
    now,
    onEvent: event => {
      const data = event as unknown as JsonValue
      events.push(event.kind, event.at, data)
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
    onEvent: event => {
      events.push(event.kind, event.at, event.data)
      if (event.kind === 'mind.definition-error' || event.kind === 'mind.error') lastReport = event.data
    },
  })

  const home = options.home
  let orderSeq = 0
  return {
    tick(): void {
      loop.tick()
    },
    status(): MindStatusView {
      const current = tracker.current()
      const fault = tracker.fault()
      const active = orders.active()
      return {
        tracker: tracker.state(),
        job: current === null ? null : { runId: current.job.runId, driverId: current.job.driverId },
        fault: fault === null ? null : { code: fault.code, since: fault.since },
        home: home === undefined ? null : { x: home.x, y: home.y, z: home.z },
        activeOrder: active === undefined ? null : { id: active.order.id, verb: active.order.verb },
        queuedOrders: orders.queued().length,
        eventsSeq: events.lastSeq(),
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
      const record = orders.cancel(id)
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
    orders,
    events,
  }
}

function viewOf(record: { order: { id: string; verb: string }; state: string }): MindOrderView {
  return { id: record.order.id, verb: record.order.verb, state: record.state }
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readTreeDefinitions(dir: string): Record<string, unknown> {
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
        `tree ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { module: 'body.mind' },
      )
    }
  }
  return definitions
}

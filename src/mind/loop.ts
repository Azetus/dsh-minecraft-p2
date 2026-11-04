import type { JsonValue } from '../contracts/types.ts'
import type { Box, Vec3 } from '../port/index.ts'
import type { HazardPolicy } from '../port/policy.ts'
import type { PlanInstance } from './plan.ts'
import type { ConflictPolicy, MaterialPolicy } from './policy.ts'
import type { JobTracker } from './tracker.ts'
import type { TreeResult } from './tree.ts'
import type { EvalCtx, WorldView } from './types.ts'

export type LoopEvent = {
  kind: string
  at: number
  data: JsonValue
}

export type MindLoopOptions = {
  world: () => WorldView
  evaluate: (tree: 'constant' | 'main', ctx: EvalCtx, world: WorldView) => TreeResult
  tracker: JobTracker
  now?: () => number
  home?: Vec3
  /** Active plan, if any. A plan keeps the main tree hot instead of idling. */
  plan?: () => PlanInstance | undefined
  /** A standing duty keeps the main tree hot too. */
  dutyActive?: () => boolean
  /** The default base activity keeps the main tree hot while it is active. */
  baseActive?: () => boolean
  /** Active order verb, if any. */
  orderVerb?: () => string | undefined
  /** Active order params, if any; the safety reflex reads explicit targets. */
  orderParams?: () => Record<string, JsonValue> | undefined
  /** Explicit hazard permission from the active order. */
  hazards?: () => HazardPolicy | undefined
  /** Conflict policy for the active order. */
  conflictPolicy?: () => ConflictPolicy | undefined
  /** Material policy for the active order. */
  materialPolicy?: () => MaterialPolicy | undefined
  /** Gather jobs already started for the active plan. */
  gatherCount?: () => number
  /** Bounded internal re-read for unknown plan cells; never an Agent payload. */
  observe?: (box: Box) => void
  /** Bounded internal entity re-read for escort; never an Agent payload. */
  observeEntities?: (box: Box) => void
  /** Idle time between main-tree work offers (standing/fidgeting is allowed). */
  mainIdleDelayMs?: number
  /** Re-evaluate the main tree at least this often while idle. */
  mainFallbackMs?: number
  onEvent?: (event: LoopEvent) => void
}

/**
 * The 50 ms mind loop: cheap constant tree every tick, main tree only while
 * idle and past the idle delay. It never executes; it only offers candidates.
 */
export class MindLoop {
  private readonly world: () => WorldView
  private readonly evaluate: MindLoopOptions['evaluate']
  private readonly tracker: JobTracker
  private readonly now: () => number
  private readonly home: Vec3 | undefined
  private readonly plan: (() => PlanInstance | undefined) | undefined
  private readonly dutyActive: (() => boolean) | undefined
  private readonly baseActive: (() => boolean) | undefined
  private readonly orderVerb: (() => string | undefined) | undefined
  private readonly orderParams: (() => Record<string, JsonValue> | undefined) | undefined
  private readonly hazards: (() => HazardPolicy | undefined) | undefined
  private readonly conflictPolicy: (() => ConflictPolicy | undefined) | undefined
  private readonly materialPolicy: (() => MaterialPolicy | undefined) | undefined
  private readonly gatherCount: (() => number) | undefined
  private readonly observe: ((box: Box) => void) | undefined
  private readonly observeEntities: ((box: Box) => void) | undefined
  private readonly mainIdleDelayMs: number
  private readonly mainFallbackMs: number
  private readonly onEvent: ((event: LoopEvent) => void) | undefined
  private lastMainOfferAt = Number.NEGATIVE_INFINITY
  private lastMainEvalAt = Number.NEGATIVE_INFINITY
  private lastHoldKey: string | undefined
  private lastHoldAt = Number.NEGATIVE_INFINITY
  private mainDirty = true

  constructor(options: MindLoopOptions) {
    this.world = options.world
    this.evaluate = options.evaluate
    this.tracker = options.tracker
    this.now = options.now ?? (() => Date.now())
    this.home = options.home
    this.plan = options.plan
    this.dutyActive = options.dutyActive
    this.baseActive = options.baseActive
    this.orderVerb = options.orderVerb
    this.orderParams = options.orderParams
    this.hazards = options.hazards
    this.conflictPolicy = options.conflictPolicy
    this.materialPolicy = options.materialPolicy
    this.gatherCount = options.gatherCount
    this.observe = options.observe
    this.observeEntities = options.observeEntities
    this.mainIdleDelayMs = options.mainIdleDelayMs ?? 20_000
    this.mainFallbackMs = options.mainFallbackMs ?? 3_000
    this.onEvent = options.onEvent
  }

  tick(): void {
    const now = this.now()
    let world: WorldView
    try {
      world = this.world()
    } catch (error) {
      this.emit('mind.world-error', now, { message: messageOf(error) })
      return
    }
    const activePlan = this.plan?.()
    const orderVerb = this.orderVerb?.()
    const orderParams = this.orderParams?.()
    const hazards = this.hazards?.()
    const conflictPolicy = this.conflictPolicy?.()
    const materialPolicy = this.materialPolicy?.()
    const gatherCount = this.gatherCount?.()
    const ctx: EvalCtx = {
      now,
      ...(this.home === undefined ? {} : { home: this.home }),
      ...(activePlan === undefined ? {} : { plan: activePlan }),
      ...(orderVerb === undefined ? {} : { orderVerb }),
      ...(orderParams === undefined ? {} : { orderParams }),
      ...(hazards === undefined ? {} : { hazards }),
      ...(conflictPolicy === undefined ? {} : { conflictPolicy }),
      ...(materialPolicy === undefined ? {} : { materialPolicy }),
      ...(gatherCount === undefined ? {} : { gatherCount }),
      isBlocked: key => this.tracker.isBlocked(key),
      ...(this.observe === undefined ? {} : { observe: this.observe }),
      ...(this.observeEntities === undefined ? {} : { observeEntities: this.observeEntities }),
    }

    try {
      const constant = this.evaluate('constant', ctx, world)
      // A constant-tree decision wins this tick. The main tree is not asked
      // for a competing candidate, and cannot clear the pending one with a
      // `nowork` offer. This gate is what makes the emergency reaction real.
      let constantHandled = false
      if (constant.kind === 'job') {
        constantHandled = true
        this.lastHoldKey = undefined
        this.tracker.offer(constant.candidate)
      } else if (constant.kind === 'hold') {
        constantHandled = true
        // A constant hold means the body cannot safely continue the current
        // work. Stop the running job; the order/plan stays active.
        if (this.tracker.state() === 'running') this.tracker.abort('CONSTANT_HOLD')
        this.emitHold('constant', constant, now)
      } else if (constant.kind === 'need-observation') {
        constantHandled = true
      } else if (constant.kind === 'definition-error') {
        constantHandled = true
        this.emit('mind.definition-error', now, { tree: 'constant', message: constant.error.message })
      }
      // need-observation: keep the current job, just do not offer this tick.

      if (!constantHandled && this.tracker.state() === 'idle') {
        const hasPlan = ctx.plan !== undefined
        const hasDuty = this.dutyActive?.() === true
        const hasBase = this.baseActive?.() === true
        const hot = hasPlan || hasDuty || hasBase
        const forced = this.mainDirty
        const due = hot || forced || now - this.lastMainEvalAt >= this.mainFallbackMs
        if (due && (hot || forced || now - this.lastMainOfferAt >= this.mainIdleDelayMs)) {
          this.lastMainEvalAt = now
          this.mainDirty = false
          const main = this.evaluate('main', ctx, world)
          if (main.kind === 'job') {
            this.lastMainOfferAt = now
            this.lastHoldKey = undefined
            this.tracker.offer(main.candidate)
          } else if (main.kind === 'hold') {
            this.tracker.offer(null)
            this.emitHold('main', main, now)
          } else if (main.kind === 'nowork') {
            this.tracker.offer(null)
          } else if (main.kind === 'definition-error') {
            this.emit('mind.definition-error', now, { tree: 'main', message: main.error.message })
          }
        }
      }

      this.tracker.tick(now, world.time.worldAge)
    } catch (error) {
      this.emit('mind.error', now, { message: messageOf(error) })
    }
  }

  /** Mark the main tree for re-evaluation on the next idle tick. */
  invalidate(): void {
    this.mainDirty = true
    // A new order/terminal is a new task context; a hold for it should be
    // reported even if the same reason was emitted within the window.
    this.lastHoldKey = undefined
  }

  /** Emit one hold per reason per window; a persistent hold is not silent. */
  private emitHold(
    tree: 'constant' | 'main',
    hold: { reason: string; notify?: boolean; data?: JsonValue },
    now: number,
  ): void {
    const key = `${tree}:${hold.reason}`
    if (this.lastHoldKey === key && now - this.lastHoldAt < 10_000) return
    this.lastHoldKey = key
    this.lastHoldAt = now
    this.emit('mind.hold', now, {
      tree,
      reason: hold.reason,
      notify: hold.notify !== false,
      ...(hold.data === undefined ? {} : { data: hold.data }),
    })
  }

  private emit(kind: string, at: number, data: JsonValue): void {
    this.onEvent?.({ kind, at, data })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

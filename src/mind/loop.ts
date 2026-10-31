import type { JsonValue } from '../contracts/types.ts'
import type { Vec3 } from '../port/index.ts'
import type { PlanInstance } from './plan.ts'
import type { ConflictPolicy } from './policy.ts'
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
  /** Conflict policy for the active order. */
  conflictPolicy?: () => ConflictPolicy | undefined
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
  private readonly conflictPolicy: (() => ConflictPolicy | undefined) | undefined
  private readonly mainIdleDelayMs: number
  private readonly mainFallbackMs: number
  private readonly onEvent: ((event: LoopEvent) => void) | undefined
  private lastMainOfferAt = Number.NEGATIVE_INFINITY
  private lastMainEvalAt = Number.NEGATIVE_INFINITY
  private mainDirty = true

  constructor(options: MindLoopOptions) {
    this.world = options.world
    this.evaluate = options.evaluate
    this.tracker = options.tracker
    this.now = options.now ?? (() => Date.now())
    this.home = options.home
    this.plan = options.plan
    this.conflictPolicy = options.conflictPolicy
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
    const conflictPolicy = this.conflictPolicy?.()
    const ctx: EvalCtx = {
      now,
      ...(this.home === undefined ? {} : { home: this.home }),
      ...(activePlan === undefined ? {} : { plan: activePlan }),
      ...(conflictPolicy === undefined ? {} : { conflictPolicy }),
      isBlocked: key => this.tracker.isBlocked(key),
    }

    try {
      const constant = this.evaluate('constant', ctx, world)
      if (constant.kind === 'job') this.tracker.offer(constant.candidate)
      else if (constant.kind === 'definition-error') {
        this.emit('mind.definition-error', now, { tree: 'constant', message: constant.error.message })
      }
      // need-observation: keep the current job, just do not offer this tick.

      if (this.tracker.state() === 'idle') {
        const hasPlan = ctx.plan !== undefined
        const due = hasPlan || this.mainDirty || now - this.lastMainEvalAt >= this.mainFallbackMs
        if (due && (hasPlan || now - this.lastMainOfferAt >= this.mainIdleDelayMs)) {
          this.lastMainEvalAt = now
          this.mainDirty = false
          const main = this.evaluate('main', ctx, world)
          if (main.kind === 'job') {
            this.lastMainOfferAt = now
            this.tracker.offer(main.candidate)
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
  }

  private emit(kind: string, at: number, data: JsonValue): void {
    this.onEvent?.({ kind, at, data })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

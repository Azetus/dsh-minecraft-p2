import type { Bot } from 'mineflayer'

import type { JsonValue } from '../../contracts/types.ts'
import { cellOf, sameCell } from '../model/block.ts'
import type { Cell } from '../model/types.ts'
import { VanillaNodeReader } from '../vanilla/classify.ts'
import { WaypointFollower } from '../vanilla/follow.ts'
import { planVanillaPath, type VanillaPlan } from '../vanilla/search.ts'
import { MineflayerMotionWorld } from './world.ts'

export type VanillaRunState = 'running' | 'succeeded' | 'failed' | 'canceled'

export type VanillaRunResult = {
  state: VanillaRunState
  code?: string
  observed?: JsonValue
}

export type VanillaRunOptions = {
  maxNodes?: number
  maxDistance?: number
  planTimeoutMs?: number
}

/**
 * One unvalidated, vanilla-shaped run: plan over 1-cell nodes, then follow the
 * waypoints greedily. It never breaks, never places, never re-plans, and never
 * refuses because an edge looks risky; the caller is told
 * `unvalidated: true` instead.
 */
export class VanillaRun {
  private readonly world: MineflayerMotionWorld
  private readonly reader: VanillaNodeReader
  private readonly target: Cell
  private readonly startedAt = Date.now()
  private plan: VanillaPlan | undefined
  private follower: WaypointFollower | undefined
  private result: VanillaRunResult = { state: 'running' }

  constructor(
    private readonly bot: Bot,
    target: Cell,
    private readonly options: VanillaRunOptions = {},
    private readonly timeoutMs = 30_000,
  ) {
    this.world = new MineflayerMotionWorld(bot)
    this.reader = new VanillaNodeReader(this.world)
    this.target = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) }
  }

  start(): void {
    const self = this.world.self()
    this.plan = planVanillaPath(this.reader, cellOf(self.pos), this.target, {
      ...(this.options.maxNodes === undefined ? {} : { maxNodes: this.options.maxNodes }),
      ...(this.options.maxDistance === undefined ? {} : { maxDistance: this.options.maxDistance }),
      ...(this.options.planTimeoutMs === undefined ? {} : { timeoutMs: this.options.planTimeoutMs }),
    })
    if (this.plan.waypoints.length === 0 && !this.plan.reached) {
      this.result = { state: 'failed', code: 'VANILLA_NO_PATH', observed: this.report() }
      return
    }
    this.follower = new WaypointFollower(this.world, this.reader, this.plan.waypoints)
  }

  tick(now: number): VanillaRunResult {
    if (this.result.state !== 'running') return this.result
    if (this.plan === undefined || this.follower === undefined) {
      this.result = { state: 'failed', code: 'VANILLA_NO_PATH', observed: this.report() }
      return this.result
    }
    if (now - this.startedAt > this.timeoutMs) {
      this.follower.cancel()
      this.result = { state: 'failed', code: 'VANILLA_TIMEOUT', observed: this.report() }
      return this.result
    }
    // Doors open, water flows: re-read the world every tick.
    this.reader.invalidate()
    const step = this.follower.tick(now)
    if (step.status === 'succeeded') {
      if (this.plan.reached) {
        this.result = {
          state: 'succeeded',
          observed: this.report({ reachedExact: sameCell(cellOf(this.world.self().pos), this.target) }),
        }
      } else {
        // Vanilla walks as close as it got, then stops; report that honestly
        // instead of pretending the goal was reached.
        this.result = { state: 'failed', code: 'VANILLA_NO_PATH', observed: this.report({ reachedExact: false }) }
      }
    } else if (step.status === 'failed') {
      this.result = { state: 'failed', code: step.code, observed: this.report({ reachedExact: false }) }
    } else if (step.status === 'canceled') {
      this.result = { state: 'canceled' }
    }
    return this.result
  }

  stop(): boolean {
    this.follower?.cancel()
    try {
      this.bot.clearControlStates()
    } catch {
      return false
    }
    this.result = { state: 'canceled' }
    return this.controlsReleased()
  }

  report(extra: { reachedExact?: boolean } = {}): JsonValue {
    let self: ReturnType<MineflayerMotionWorld['self']> | undefined
    try {
      self = this.world.self()
    } catch {
      self = undefined
    }
    const plan = this.plan
    return {
      kind: 'motion',
      planner: 'vanilla',
      unvalidated: true,
      waypoints: plan?.waypoints.length ?? 0,
      reachedPlan: plan?.reached ?? false,
      closest: plan !== undefined && Number.isFinite(plan.closest) ? plan.closest : null,
      ...(plan?.goalAdjustedTo === undefined ? {} : { goalAdjustedTo: { ...plan.goalAdjustedTo } }),
      ...(extra.reachedExact === undefined ? {} : { reachedExact: extra.reachedExact }),
      ...(self === undefined ? {} : { at: { ...self.pos }, health: self.health }),
      note: 'unvalidated path: may drown or fall',
    }
  }

  private controlsReleased(): boolean {
    const getControl = (this.bot as unknown as { getControlState?: (name: string) => boolean }).getControlState
    if (typeof getControl !== 'function') return true
    for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'] as const) {
      if (getControl.call(this.bot, control) === true) return false
    }
    return true
  }
}

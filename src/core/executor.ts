import type { BehaviorDefinition } from '../contracts/ir.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import { LocalFrame, frameFrom } from './frame.ts'
import {
  createNodeRuntime,
  evaluateCondition,
} from './node-runtime.ts'
import type {
  ActPort,
  NodeContext,
  NodeRuntime,
  NodeStatus,
  QueryPort,
} from './node-runtime.ts'

export type ExecutorStatus = 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled'

export type ExecutorOptions = {
  definition: BehaviorDefinition
  params: Record<string, JsonValue>
  query: QueryPort
  act: ActPort
}

/** One behavior instance; one tick advances at most one bounded scheduling pass. */
export class BehaviorExecutor {
  readonly definition: BehaviorDefinition
  readonly frame: LocalFrame
  private readonly root: NodeRuntime
  private readonly params: Record<string, JsonValue>
  private readonly query: QueryPort
  private readonly act: ActPort
  private status: ExecutorStatus = 'running'
  private error: P2Error | undefined
  private lastFailureValue: P2Error | undefined
  private cancelRequested = false

  constructor(options: ExecutorOptions) {
    this.definition = options.definition
    this.params = options.params
    this.query = options.query
    this.act = options.act
    this.frame = frameFrom(options.definition.locals)
    this.root = createNodeRuntime(options.definition.root)
  }

  get currentStatus(): ExecutorStatus {
    return this.status
  }

  get currentError(): P2Error | undefined {
    return this.error
  }

  get lastFailure(): P2Error | undefined {
    return this.lastFailureValue
  }

  tick(now = Date.now()): ExecutorStatus {
    if (this.status !== 'running') return this.status
    if (this.cancelRequested) {
      try {
        this.root.cancel(this.context(now))
      } catch (error) {
        this.fail(p2Error(
          'ACT_STOP_FAILED',
          'runtime',
          error instanceof Error ? error.message : String(error),
          { module: 'core.executor' },
        ))
        return this.status
      }
      this.status = 'cancelled'
      return this.status
    }

    const result = this.root.tick(this.context(now))
    if (result.status === 'running') return this.status
    if (result.status === 'cancelled') {
      this.status = 'cancelled'
      return this.status
    }
    if (result.status === 'failed') {
      const failure = result.error ?? p2Error(
        'NODE_FAILED',
        'runtime',
        'root node failed',
        { module: 'core.executor' },
      )
      this.lastFailureValue = failure
      if (this.canCompleteAfterEnvironmentFailure(failure, now)) {
        this.status = 'succeeded'
        return this.status
      }
      this.fail(failure)
      return this.status
    }

    this.finalize(now)
    return this.status
  }

  stop(): void {
    if (this.status === 'running') this.cancelRequested = true
  }

  private canCompleteAfterEnvironmentFailure(failure: P2Error, now: number): boolean {
    if (this.definition.mode !== 'finite') return false
    if (failure.category !== 'environment') return false
    const completion = this.definition.completion
    if (completion?.kind !== 'predicate') return false
    const condition = evaluateCondition(completion.condition, this.context(now))
    return condition.status === 'true'
  }

  private finalize(now: number): void {    if (this.definition.mode === 'continuous') {
      this.fail(p2Error(
        'CONTINUOUS_TREE_ENDED',
        'runtime',
        'continuous behavior tree ended',
        { module: 'core.executor' },
      ))
      return
    }

    const completion = this.definition.completion
    if (completion === undefined) {
      this.fail(p2Error(
        'COMPLETION_REQUIRED',
        'runtime',
        'finite behavior has no completion rule',
        { module: 'core.executor' },
      ))
      return
    }
    if (completion.kind === 'externalConfirmation') {
      this.status = 'blocked'
      return
    }

    const condition = evaluateCondition(completion.condition, this.context(now))
    if (condition.status === 'true') {
      this.status = 'succeeded'
      return
    }
    if (condition.status === 'failed') {
      this.fail(condition.error)
      return
    }
    this.fail(p2Error(
      condition.status === 'unknown' ? 'GOAL_UNKNOWN' : 'GOAL_NOT_MET',
      'runtime',
      'finite behavior tree ended without a satisfied completion rule',
      { module: 'core.executor' },
    ))
  }

  private context(now: number): NodeContext {
    return {
      params: this.params,
      frame: this.frame,
      query: this.query,
      act: this.act,
      now,
    }
  }

  private fail(error: P2Error): void {
    this.error = error
    this.status = 'failed'
  }
}

export type { NodeStatus }

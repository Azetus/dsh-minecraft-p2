import type {
  Condition,
  Node,
  QueryRef,
  ValueExpr,
} from '../contracts/ir.ts'
import type { JsonValue, LocalSlot, P2Error, ValueMeta } from '../contracts/types.ts'
import { canonicalJson } from '../contracts/digest.ts'
import { p2Error } from '../contracts/protocol.ts'
import { EvalError, evaluate } from './expression.ts'
import type { EvalContext } from './expression.ts'
import { LocalFrame } from './frame.ts'

export type NodeStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

export type NodeResult = {
  status: NodeStatus
  error?: P2Error
}

export type QueryOutcome =
  | { status: 'ok'; value: JsonValue; meta?: ValueMeta }
  | { status: 'failed'; error: P2Error }
  | { status: 'pending'; poll(): QueryOutcome }

export type QueryPort = (ref: QueryRef, args: Record<string, JsonValue>) => QueryOutcome

export type ActPoll =
  | { status: 'running' }
  | { status: 'succeeded'; result?: JsonValue; meta?: ValueMeta }
  | { status: 'failed'; error: P2Error }
  | { status: 'cancelled'; error?: P2Error }

export type ActHandle = {
  poll(): ActPoll
  stop(): void
  cleanup?(): ActPoll
}

export type ActPort = {
  start(name: string, args: Record<string, JsonValue>): ActHandle
}

export type NodeContext = {
  params: Record<string, JsonValue>
  frame: LocalFrame
  query: QueryPort
  act: ActPort
  now: number
}

export type ConditionOutcome =
  | { status: 'true' }
  | { status: 'false' }
  | { status: 'unknown' }
  | { status: 'failed'; error: P2Error }

export interface NodeRuntime {
  readonly status: NodeStatus
  tick(context: NodeContext): NodeResult
  cancel(context: NodeContext): NodeResult
}

export function createNodeRuntime(node: Node): NodeRuntime {
  switch (node.kind) {
    case 'sequence': return new SequenceRuntime(node)
    case 'assign': return new AssignRuntime(node)
    case 'wait': return new WaitRuntime(node.durationMs)
    case 'if': return new IfRuntime(node)
    case 'repeat': return new RepeatRuntime(node)
    case 'subtree': return new SubtreeRuntime(node)
    case 'reactivePriority': return new ReactiveRuntime(node)
    case 'query': return new QueryRuntime(node)
    case 'act': return new ActRuntime(node)
    case 'recover': return new RecoverRuntime(node)
    default: throw new Error('unknown node kind')
  }
}

abstract class BaseRuntime implements NodeRuntime {
  status: NodeStatus = 'running'

  abstract tick(context: NodeContext): NodeResult
  abstract cancel(context: NodeContext): NodeResult

  protected success(): NodeResult {
    this.status = 'succeeded'
    return { status: 'succeeded' }
  }

  protected failure(error: P2Error): NodeResult {
    this.status = 'failed'
    return { status: 'failed', error }
  }

  protected cancelled(): NodeResult {
    this.status = 'cancelled'
    return { status: 'cancelled' }
  }
}

class SequenceRuntime extends BaseRuntime {
  private index = 0
  private child: NodeRuntime | undefined
  private transitions = 0

  constructor(private readonly node: Extract<Node, { kind: 'sequence' }>) {
    super()
  }

  tick(context: NodeContext): NodeResult {
    while (this.transitions < 200) {
      if (this.index >= this.node.children.length) return this.success()
      this.child ??= createNodeRuntime(this.node.children[this.index] as Node)
      const result = this.child.tick(context)
      if (result.status === 'running') return result
      this.transitions += 1
      if (result.status === 'failed') return this.failure(requireError(result))
      if (result.status === 'cancelled') return this.cancelled()
      this.index += 1
      this.child = undefined
    }
    return { status: 'running' }
  }

  cancel(context: NodeContext): NodeResult {
    const result = this.child?.cancel(context)
    if (result?.status === 'running') return result
    if (result?.status === 'failed') return this.failure(requireError(result))
    return this.cancelled()
  }
}

class AssignRuntime extends BaseRuntime {
  private started = false

  constructor(private readonly node: Extract<Node, { kind: 'assign' }>) {
    super()
  }

  tick(context: NodeContext): NodeResult {
    if (this.started) return this.status === 'running' ? { status: 'running' } : { status: this.status }
    this.started = true
    try {
      const value = evaluate(this.node.value, evalContext(context))
      context.frame.set(this.node.target, value, {
        source: 'assign',
        scope: this.node.id,
        sampledAt: context.now,
      })
      return this.success()
    } catch (error) {
      return this.failure(expressionError(error, this.node.id))
    }
  }

  cancel(): NodeResult {
    return this.cancelled()
  }
}

class WaitRuntime extends BaseRuntime {
  private endAt: number | undefined

  constructor(private readonly durationMs: number) {
    super()
  }

  tick(context: NodeContext): NodeResult {
    this.endAt ??= context.now + this.durationMs
    if (context.now >= this.endAt) return this.success()
    return { status: 'running' }
  }

  cancel(): NodeResult {
    return this.cancelled()
  }
}

class IfRuntime extends BaseRuntime {
  private selected: NodeRuntime | undefined
  private readonly condition: ConditionEvaluator

  constructor(private readonly node: Extract<Node, { kind: 'if' }>) {
    super()
    this.condition = new ConditionEvaluator(node.when)
  }

  tick(context: NodeContext): NodeResult {
    if (this.selected === undefined) {
      const condition = this.condition.evaluate(context)
      if (condition.status === 'failed') return this.failure(condition.error)
      if (condition.status === 'unknown') return { status: 'running' }
      if (condition.status === 'false' && this.node.else === undefined) return this.success()
      this.selected = createNodeRuntime(
        condition.status === 'true' ? this.node.then : this.node.else as Node,
      )
    }
    const result = this.selected.tick(context)
    if (result.status === 'failed') return this.failure(requireError(result))
    if (result.status === 'cancelled') return this.cancelled()
    return result
  }

  cancel(context: NodeContext): NodeResult {
    const result = this.selected?.cancel(context)
    if (result?.status === 'running') return result
    if (result?.status === 'failed') return this.failure(requireError(result))
    return this.cancelled()
  }
}

class RepeatRuntime extends BaseRuntime {
  private iteration = 0
  private child: NodeRuntime | undefined
  private waitForNextTick = false

  constructor(private readonly node: Extract<Node, { kind: 'repeat' }>) {
    super()
  }

  tick(context: NodeContext): NodeResult {
    if (this.node.count !== undefined && this.iteration >= this.node.count) return this.success()
    if (this.waitForNextTick) {
      this.waitForNextTick = false
      return { status: 'running' }
    }
    this.child ??= createNodeRuntime(this.node.child)
    const result = this.child.tick(context)
    if (result.status === 'running') return result
    if (result.status === 'failed') return this.failure(requireError(result))
    if (result.status === 'cancelled') return this.cancelled()

    this.iteration += 1
    this.child = undefined
    if (this.node.count !== undefined && this.iteration >= this.node.count) return this.success()
    if (this.node.count === undefined) this.waitForNextTick = true
    return { status: 'running' }
  }

  cancel(context: NodeContext): NodeResult {
    const result = this.child?.cancel(context)
    if (result?.status === 'running') return result
    if (result?.status === 'failed') return this.failure(requireError(result))
    return this.cancelled()
  }
}

class SubtreeRuntime extends BaseRuntime {
  private child: NodeRuntime | undefined
  private childFrame: LocalFrame | undefined

  constructor(private readonly node: Extract<Node, { kind: 'subtree' }>) {
    super()
  }

  tick(context: NodeContext): NodeResult {
    if (this.child === undefined) {
      const inputs = new Map<string, LocalSlot>()
      try {
        for (const [name, expr] of Object.entries(this.node.inputs)) {
          const value = evaluate(expr, evalContext(context))
          const source = expr.kind === 'local' ? context.frame.getSlot(expr.name) : undefined
          inputs.set(name, source ?? {
            value,
            meta: { source: 'initial', scope: this.node.id, sampledAt: context.now },
          })
        }
      } catch (error) {
        return this.failure(expressionError(error, this.node.id))
      }
      this.childFrame = new LocalFrame()
      for (const [name, slot] of inputs) this.childFrame.setSlot(name, slot)
      this.child = createNodeRuntime(this.node.tree)
    }
    const result = this.child.tick({ ...context, frame: this.childFrame as LocalFrame })
    if (result.status === 'failed') return this.failure(requireError(result))
    if (result.status === 'cancelled') return this.cancelled()
    if (result.status === 'running') return result

    for (const [output, localName] of Object.entries(this.node.outputs)) {
      const slot = this.childFrame?.getSlot(localName)
      if (slot === undefined) {
        return this.failure(p2Error(
          'SUBTREE_OUTPUT_MISSING',
          'runtime',
          `subtree output ${output} is not initialized`,
          { module: 'core.subtree', nodePath: this.node.id },
        ))
      }
      context.frame.setSlot(output, slot)
    }
    return this.success()
  }

  cancel(context: NodeContext): NodeResult {
    const result = this.child?.cancel({ ...context, frame: this.childFrame ?? context.frame })
    if (result?.status === 'running') return result
    if (result?.status === 'failed') return this.failure(requireError(result))
    return this.cancelled()
  }
}

class ReactiveRuntime extends BaseRuntime {
  private branchIndex: number | undefined
  private child: NodeRuntime | undefined
  private readonly conditions: ConditionEvaluator[]

  constructor(private readonly node: Extract<Node, { kind: 'reactivePriority' }>) {
    super()
    this.conditions = node.branches.map(branch => new ConditionEvaluator(branch.when))
  }

  tick(context: NodeContext): NodeResult {
    let selected: number | undefined
    let unknown = false
    for (const [index, condition] of this.conditions.entries()) {
      const outcome = condition.evaluate(context)
      if (outcome.status === 'failed') return this.failure(outcome.error)
      if (outcome.status === 'true') {
        selected = index
        break
      }
      if (outcome.status === 'unknown') {
        unknown = true
        break
      }
    }

    if (selected === undefined) {
      if (unknown) return { status: 'running' }
      return this.failure(p2Error(
        'NO_BRANCH',
        'runtime',
        'reactivePriority has no applicable branch',
        { module: 'core.reactive', nodePath: this.node.id },
      ))
    }

    if (this.branchIndex !== selected) {
      this.child?.cancel(context)
      this.child = createNodeRuntime(this.node.branches[selected]?.child as Node)
      this.branchIndex = selected
    }

    const child = this.child
    if (child === undefined) return { status: 'running' }
    const result = child.tick(context)
    if (result.status === 'failed') return this.failure(requireError(result))
    if (result.status === 'cancelled') return this.cancelled()
    return result
  }

  cancel(context: NodeContext): NodeResult {
    const result = this.child?.cancel(context)
    if (result?.status === 'running') return result
    if (result?.status === 'failed') return this.failure(requireError(result))
    return this.cancelled()
  }
}

class QueryRuntime extends BaseRuntime {
  private started = false
  private pending: (() => QueryOutcome) | undefined
  private startedAt: number | undefined
  private timeoutMs = 5000

  constructor(private readonly node: Extract<Node, { kind: 'query' }>) {
    super()
  }

  tick(context: NodeContext): NodeResult {
    if (this.pending !== undefined) {
      if (this.startedAt !== undefined && context.now - this.startedAt > this.timeoutMs) {
        this.pending = undefined
        return this.failure(p2Error(
          'QUERY_TIMEOUT',
          'timeout',
          `query ${this.node.query.op} exceeded its deadline`,
          { module: 'core.query', nodePath: this.node.id },
        ))
      }
      const outcome = this.pending()
      if (outcome.status === 'pending') {
        this.pending = outcome.poll
        return { status: 'running' }
      }
      this.pending = undefined
      return this.finish(outcome, context)
    }
    if (this.started) return { status: 'running' }
    this.started = true
    const args: Record<string, JsonValue> = {}
    try {
      for (const [name, expr] of Object.entries(this.node.query.args)) {
        args[name] = evaluate(expr, evalContext(context))
      }
    } catch (error) {
      return this.failure(expressionError(error, this.node.id))
    }
    const outcome = context.query(this.node.query, args)
    if (outcome.status === 'pending') {
      this.pending = outcome.poll
      this.startedAt = context.now
      this.timeoutMs = this.node.query.timeoutMs ?? 5000
      return { status: 'running' }
    }
    return this.finish(outcome, context)
  }

  private finish(outcome: Exclude<QueryOutcome, { status: 'pending' }>, context: NodeContext): NodeResult {
    if (outcome.status === 'failed') return this.failure(outcome.error)
    context.frame.set(this.node.output, outcome.value, outcome.meta ?? {
      source: 'query',
      scope: this.node.query.op,
      sampledAt: context.now,
    })
    return this.success()
  }

  cancel(): NodeResult {
    this.pending = undefined
    this.startedAt = undefined
    return this.cancelled()
  }
}

class ActRuntime extends BaseRuntime {
  private handle: ActHandle | undefined
  private outputPending = false

  constructor(private readonly node: Extract<Node, { kind: 'act' }>) {
    super()
  }

  tick(context: NodeContext): NodeResult {
    if (this.handle === undefined) {
      const args: Record<string, JsonValue> = {}
      try {
        for (const [name, expr] of Object.entries(this.node.args)) {
          args[name] = evaluate(expr, evalContext(context))
        }
      } catch (error) {
        return this.failure(expressionError(error, this.node.id))
      }
      try {
        this.handle = context.act.start(this.node.act, args)
      } catch (error) {
        return this.failure(p2Error(
          'ACT_START_FAILED',
          'runtime',
          error instanceof Error ? error.message : String(error),
          { module: 'core.act', nodePath: this.node.id },
        ))
      }
      this.outputPending = this.node.output !== undefined
    }

    const result = this.handle.poll()
    if (result.status === 'running') return { status: 'running' }
    if (result.status === 'failed') return this.failure(result.error)
    if (result.status === 'cancelled') return this.cancelled()

    if (this.outputPending) {
      if (result.result === undefined) {
        return this.failure(p2Error(
          'ACT_OUTPUT_MISSING',
          'runtime',
          `act ${this.node.act} completed without a result`,
          { module: 'core.act', nodePath: this.node.id },
        ))
      }
      if (this.node.output !== undefined) {
        context.frame.set(this.node.output, result.result, result.meta ?? {
          source: 'act',
          scope: this.node.act,
          sampledAt: context.now,
        })
      }
      this.outputPending = false
    }
    return this.success()
  }

  cancel(): NodeResult {
    if (this.handle === undefined) return this.cancelled()
    const hasCleanup = this.handle.cleanup !== undefined
    try {
      this.handle.stop()
    } catch (error) {
      return this.failure(p2Error(
        'ACT_STOP_FAILED',
        'runtime',
        error instanceof Error ? error.message : String(error),
        { module: 'core.act', nodePath: this.node.id },
      ))
    }
    if (!hasCleanup) return this.cancelled()
    const result = this.handle.poll()
    if (result.status === 'running') return { status: 'running' }
    if (result.status === 'failed') return this.failure(result.error)
    return this.cancelled()
  }
}

class RecoverRuntime extends BaseRuntime {
  private child: NodeRuntime | undefined
  private fallback: NodeRuntime | undefined
  private attempts = 0
  private retryAt: number | undefined
  private deadline: number | undefined
  private lastError: P2Error | undefined
  private branch: 'child' | 'fallback' | 'done' = 'child'

  constructor(private readonly node: Extract<Node, { kind: 'recover' }>) {
    super()
  }

  tick(context: NodeContext): NodeResult {
    if (this.branch === 'done') return this.success()
    if (this.branch === 'fallback') {
      this.fallback ??= createNodeRuntime(this.node.rules[0]?.fallback as Node)
      const result = this.fallback.tick(context)
      if (result.status === 'failed') return this.failure(requireError(result))
      if (result.status === 'cancelled') return this.cancelled()
      if (result.status === 'running') return result
      return this.success()
    }

    if (this.child === undefined) {
      if (this.retryAt !== undefined && context.now < this.retryAt) return { status: 'running' }
      this.child = createNodeRuntime(this.lastError === undefined ? this.node.child : this.node.child)
      this.retryAt = undefined
    }

    const result = this.child.tick(context)
    if (result.status === 'running') return result
    if (result.status === 'cancelled') return this.cancelled()
    if (result.status === 'succeeded') return this.success()

    const failure = requireError(result)
    this.lastError = failure
    const rule = this.node.rules.find(candidate => candidate.codes.includes(failure.code))
    if (rule === undefined) return this.failure(failure)
    if (rule.blocked === true && rule.fallback === undefined) {
      return this.failure(p2Error(
        'RECOVERY_BLOCKED',
        'runtime',
        `recovery for ${failure.code} requires external input`,
        { module: 'core.recover', nodePath: this.node.id },
      ))
    }
    this.deadline ??= context.now + rule.deadlineMs
    if (rule.fallback !== undefined) {
      this.branch = 'fallback'
      this.fallback = createNodeRuntime(rule.fallback)
      return { status: 'running' }
    }
    if (this.attempts >= rule.retries || context.now >= this.deadline) {
      return this.failure(p2Error(
        'RECOVERY_EXHAUSTED',
        'runtime',
        `recovery exhausted for ${failure.code}`,
        { module: 'core.recover', nodePath: this.node.id },
      ))
    }
    this.attempts += 1
    this.child = undefined
    this.retryAt = context.now + rule.intervalMs
    return { status: 'running' }
  }

  cancel(context: NodeContext): NodeResult {
    const child = this.child?.cancel(context)
    if (child?.status === 'running') return child
    if (child?.status === 'failed') return this.failure(requireError(child))
    const fallback = this.fallback?.cancel(context)
    if (fallback?.status === 'running') return fallback
    if (fallback?.status === 'failed') return this.failure(requireError(fallback))
    return this.cancelled()
  }
}

export class ConditionEvaluator {
  private pending: (() => QueryOutcome) | undefined
  private pendingArgs: string | undefined
  private evaluation = 0

  constructor(private readonly condition: Condition) {}

  get evaluationId(): number {
    return this.evaluation
  }

  evaluate(context: NodeContext): ConditionOutcome {
    if (this.condition.kind === 'expr') return evaluateCondition(this.condition, context)

    const args: Record<string, JsonValue> = {}
    try {
      for (const [name, expr] of Object.entries(this.condition.query.args)) {
        args[name] = evaluate(expr, evalContext(context))
      }
    } catch (error) {
      return { status: 'failed', error: expressionError(error, 'condition') }
    }
    const argsKey = canonicalJson(args)
    if (this.pending !== undefined && this.pendingArgs !== argsKey) {
      this.pending = undefined
      this.pendingArgs = undefined
    }
    if (this.pending !== undefined) return this.consume(this.pending(), context)

    this.evaluation += 1
    this.pendingArgs = argsKey
    return this.consume(context.query(this.condition.query, args), context)
  }

  private consume(outcome: QueryOutcome, context: NodeContext): ConditionOutcome {
    if (outcome.status === 'pending') {
      this.pending = outcome.poll
      return { status: 'unknown' }
    }
    this.pending = undefined
    this.pendingArgs = undefined
    if (outcome.status === 'failed') return { status: 'failed', error: outcome.error }
    return evaluateQueryTest(this.condition as Extract<Condition, { kind: 'query' }>, outcome.value, context)
  }
}

export function evaluateCondition(condition: Condition, context: NodeContext): ConditionOutcome {
  try {
    if (condition.kind === 'expr') {
      const value = evaluate(condition.expr, evalContext(context))
      if (typeof value !== 'boolean') {
        throw new EvalError('EXPRESSION_ERROR', 'condition must evaluate to a boolean')
      }
      return value ? { status: 'true' } : { status: 'false' }
    }

    const args: Record<string, JsonValue> = {}
    for (const [name, expr] of Object.entries(condition.query.args)) {
      args[name] = evaluate(expr, evalContext(context))
    }
    const outcome = context.query(condition.query, args)
    if (outcome.status === 'failed') return { status: 'failed', error: outcome.error }
    if (outcome.status === 'pending') return { status: 'unknown' }
    return evaluateQueryTest(condition, outcome.value, context)
  } catch (error) {
    return { status: 'failed', error: expressionError(error, 'condition') }
  }
}

function evaluateQueryTest(
  condition: Extract<Condition, { kind: 'query' }>,
  value: JsonValue,
  context: NodeContext,
): ConditionOutcome {
  try {
    const frame = context.frame.clone()
    frame.set('result', value)
    const tested = evaluate(condition.test, {
      params: context.params,
      locals: new Map(frame.entries()),
    })
    if (typeof tested !== 'boolean') {
      throw new EvalError('EXPRESSION_ERROR', 'query condition must evaluate to a boolean')
    }
    return tested ? { status: 'true' } : { status: 'false' }
  } catch (error) {
    return { status: 'failed', error: expressionError(error, 'condition') }
  }
}

export function evalContext(context: NodeContext): EvalContext {
  return {
    params: context.params,
    locals: new Map(context.frame.entries()),
  }
}

export function expressionError(error: unknown, nodePath: string): P2Error {
  if (error instanceof EvalError) {
    return p2Error(
      error.code,
      'runtime',
      error.message,
      { module: 'core.expression', nodePath },
    )
  }
  return p2Error(
    'EXPRESSION_ERROR',
    'runtime',
    error instanceof Error ? error.message : String(error),
    { module: 'core.expression', nodePath },
  )
}

function requireError(result: NodeResult): P2Error {
  return result.error ?? p2Error(
    'NODE_FAILED',
    'runtime',
    'node failed without a structured error',
    { module: 'core.node' },
  )
}

import type {
  Condition,
  Node,
  QueryRef,
  ValueExpr,
} from '../contracts/ir.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
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
  | { status: 'ok'; value: JsonValue }
  | { status: 'failed'; error: P2Error }

export type QueryPort = (ref: QueryRef, args: Record<string, JsonValue>) => QueryOutcome

export type ActPoll =
  | { status: 'running' }
  | { status: 'succeeded'; result?: JsonValue }
  | { status: 'failed'; error: P2Error }
  | { status: 'cancelled'; error?: P2Error }

export type ActHandle = {
  poll(): ActPoll
  stop(): void
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
  cancel(context: NodeContext): void
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
  abstract cancel(context: NodeContext): void

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

  cancel(context: NodeContext): void {
    this.child?.cancel(context)
    this.cancelled()
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
      context.frame.set(this.node.target, value)
      return this.success()
    } catch (error) {
      return this.failure(expressionError(error, this.node.id))
    }
  }

  cancel(): void {
    this.cancelled()
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

  cancel(): void {
    this.cancelled()
  }
}

class IfRuntime extends BaseRuntime {
  private selected: NodeRuntime | undefined

  constructor(private readonly node: Extract<Node, { kind: 'if' }>) {
    super()
  }

  tick(context: NodeContext): NodeResult {
    if (this.selected === undefined) {
      const condition = evaluateCondition(this.node.when, context)
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

  cancel(context: NodeContext): void {
    this.selected?.cancel(context)
    this.cancelled()
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

  cancel(context: NodeContext): void {
    this.child?.cancel(context)
    this.cancelled()
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
      const inputs = new Map<string, JsonValue>()
      try {
        for (const [name, expr] of Object.entries(this.node.inputs)) {
          inputs.set(name, evaluate(expr, evalContext(context)))
        }
      } catch (error) {
        return this.failure(expressionError(error, this.node.id))
      }
      this.childFrame = new LocalFrame(inputs)
      this.child = createNodeRuntime(this.node.tree)
    }
    const result = this.child.tick({ ...context, frame: this.childFrame as LocalFrame })
    if (result.status === 'failed') return this.failure(requireError(result))
    if (result.status === 'cancelled') return this.cancelled()
    if (result.status === 'running') return result

    for (const [output, localName] of Object.entries(this.node.outputs)) {
      const value = this.childFrame?.get(localName)
      if (value === undefined) {
        return this.failure(p2Error(
          'SUBTREE_OUTPUT_MISSING',
          'runtime',
          `subtree output ${output} is not initialized`,
          { module: 'core.subtree', nodePath: this.node.id },
        ))
      }
      context.frame.set(output, value)
    }
    return this.success()
  }

  cancel(context: NodeContext): void {
    this.child?.cancel({ ...context, frame: this.childFrame ?? context.frame })
    this.cancelled()
  }
}

class ReactiveRuntime extends BaseRuntime {
  private branchIndex: number | undefined
  private child: NodeRuntime | undefined

  constructor(private readonly node: Extract<Node, { kind: 'reactivePriority' }>) {
    super()
  }

  tick(context: NodeContext): NodeResult {
    let selected: number | undefined
    let unknown = false
    for (const [index, branch] of this.node.branches.entries()) {
      const condition = evaluateCondition(branch.when, context)
      if (condition.status === 'failed') return this.failure(condition.error)
      if (condition.status === 'true') {
        selected = index
        break
      }
      if (condition.status === 'unknown') {
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

  cancel(context: NodeContext): void {
    this.child?.cancel(context)
    this.cancelled()
  }
}

class QueryRuntime extends BaseRuntime {
  private started = false

  constructor(private readonly node: Extract<Node, { kind: 'query' }>) {
    super()
  }

  tick(context: NodeContext): NodeResult {
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
    if (outcome.status === 'failed') return this.failure(outcome.error)
    context.frame.set(this.node.output, outcome.value)
    return this.success()
  }

  cancel(): void {
    this.cancelled()
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
      if (this.node.output !== undefined) context.frame.set(this.node.output, result.result)
      this.outputPending = false
    }
    return this.success()
  }

  cancel(): void {
    this.handle?.stop()
    this.cancelled()
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

  cancel(context: NodeContext): void {
    this.child?.cancel(context)
    this.fallback?.cancel(context)
    this.cancelled()
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
    const frame = context.frame.clone()
    frame.set('result', outcome.value)
    const value = evaluate(condition.test, {
      params: context.params,
      locals: new Map(frame.entries()),
    })
    if (typeof value !== 'boolean') {
      throw new EvalError('EXPRESSION_ERROR', 'query condition must evaluate to a boolean')
    }
    return value ? { status: 'true' } : { status: 'false' }
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

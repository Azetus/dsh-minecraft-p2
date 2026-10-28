import type {
  BehaviorDefinition,
  Condition,
  Node,
  ValueExpr,
} from '../contracts/ir.ts'

export class BehaviorValidationError extends Error {
  readonly code: string
  readonly path: string

  constructor(code: string, path: string, message: string) {
    super(message)
    this.name = 'BehaviorValidationError'
    this.code = code
    this.path = path
  }
}

const MAX_NODES = 10_000
const MAX_DEPTH = 64

export function validateBehavior(definition: BehaviorDefinition): void {
  if (typeof definition.id !== 'string' || definition.id.length === 0) {
    throw new BehaviorValidationError('INVALID_DEFINITION', 'id', 'behavior id is required')
  }
  if (definition.mode !== 'finite' && definition.mode !== 'continuous') {
    throw new BehaviorValidationError('INVALID_DEFINITION', 'mode', 'mode must be finite or continuous')
  }
  if (definition.mode === 'finite' && definition.completion === undefined) {
    throw new BehaviorValidationError(
      'COMPLETION_REQUIRED',
      'completion',
      'finite behavior requires a completion rule',
    )
  }
  if (definition.mode === 'continuous' && definition.completion?.kind === 'predicate') {
    throw new BehaviorValidationError(
      'CONTINUOUS_COMPLETION',
      'completion',
      'continuous behavior cannot declare a predicate completion',
    )
  }
  if (definition.completion?.kind === 'externalConfirmation' && definition.mode !== 'finite') {
    throw new BehaviorValidationError(
      'CONTINUOUS_COMPLETION',
      'completion',
      'external confirmation requires a finite behavior',
    )
  }

  const ids = new Set<string>()
  const seen = new Set<object>()
  let count = 0

  const visitNode = (node: Node, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw new BehaviorValidationError('DEPTH_LIMIT', path, 'node depth exceeds 64')
    count += 1
    if (count > MAX_NODES) throw new BehaviorValidationError('NODE_LIMIT', path, 'node count exceeds 10000')
    if (seen.has(node)) throw new BehaviorValidationError('NODE_CYCLE', path, 'shared or cyclic node object')
    seen.add(node)
    if (typeof node.id !== 'string' || node.id.length === 0) {
      throw new BehaviorValidationError('INVALID_NODE', path, 'node id is required')
    }
    if (ids.has(node.id)) throw new BehaviorValidationError('DUPLICATE_NODE_ID', path, `duplicate node id: ${node.id}`)
    ids.add(node.id)

    switch (node.kind) {
      case 'sequence':
        node.children.forEach((child, index) => visitNode(child, `${path}.children[${index}]`, depth + 1))
        break
      case 'if':
        visitCondition(node.when, `${path}.when`)
        visitNode(node.then, `${path}.then`, depth + 1)
        if (node.else !== undefined) visitNode(node.else, `${path}.else`, depth + 1)
        break
      case 'reactivePriority':
        if (node.branches.length === 0) {
          throw new BehaviorValidationError('EMPTY_BRANCHES', path, 'reactivePriority requires branches')
        }
        node.branches.forEach((branch, index) => {
          visitCondition(branch.when, `${path}.branches[${index}].when`)
          visitNode(branch.child, `${path}.branches[${index}].child`, depth + 1)
        })
        break
      case 'repeat':
        if (node.count !== undefined && (!Number.isInteger(node.count) || node.count < 0)) {
          throw new BehaviorValidationError('INVALID_REPEAT', path, 'repeat count must be a non-negative integer')
        }
        visitNode(node.child, `${path}.child`, depth + 1)
        break
      case 'subtree':
        visitNode(node.tree, `${path}.tree`, depth + 1)
        for (const [name, value] of Object.entries(node.inputs)) visitExpr(value, `${path}.inputs.${name}`)
        for (const [name, target] of Object.entries(node.outputs)) {
          if (typeof target !== 'string') {
            throw new BehaviorValidationError('INVALID_SUBTREE', path, `subtree output ${name} is invalid`)
          }
        }
        break
      case 'assign':
        if (typeof node.target !== 'string' || node.target.length === 0) {
          throw new BehaviorValidationError('INVALID_ASSIGN', path, 'assign target is required')
        }
        visitExpr(node.value, `${path}.value`)
        break
      case 'query':
        visitQuery(node.query, `${path}.query`)
        if (typeof node.output !== 'string' || node.output.length === 0) {
          throw new BehaviorValidationError('INVALID_QUERY', path, 'query output is required')
        }
        break
      case 'act':
        if (node.act === null
          || typeof node.act !== 'object'
          || typeof node.act.definitionId !== 'string'
          || node.act.definitionId.length === 0) {
          throw new BehaviorValidationError('INVALID_ACT', path, 'act reference requires a definitionId')
        }
        if (node.act.artifactId !== undefined && (typeof node.act.artifactId !== 'string' || node.act.artifactId.length === 0)) {
          throw new BehaviorValidationError('INVALID_ACT', path, 'act artifactId must be a non-empty string when present')
        }
        for (const [name, value] of Object.entries(node.args)) visitExpr(value, `${path}.args.${name}`)
        break
      case 'wait':
        if (!Number.isFinite(node.durationMs) || node.durationMs < 0) {
          throw new BehaviorValidationError('INVALID_WAIT', path, 'wait duration must be non-negative')
        }
        break
      case 'recover':
        if (node.rules.length === 0) {
          throw new BehaviorValidationError('INVALID_RECOVER', path, 'recover requires rules')
        }
        node.rules.forEach((rule, index) => {
          if (rule.codes.length === 0) {
            throw new BehaviorValidationError('INVALID_RECOVER', path, `recover rule ${index} has no codes`)
          }
          if (!Number.isInteger(rule.retries) || rule.retries < 0) {
            throw new BehaviorValidationError('INVALID_RECOVER', path, `recover rule ${index} retries is invalid`)
          }
          if (!Number.isFinite(rule.intervalMs) || rule.intervalMs < 0
            || !Number.isFinite(rule.deadlineMs) || rule.deadlineMs < 0) {
            throw new BehaviorValidationError('INVALID_RECOVER', path, `recover rule ${index} budget is invalid`)
          }
          if (rule.fallback !== undefined) visitNode(rule.fallback, `${path}.rules[${index}].fallback`, depth + 1)
        })
        visitNode(node.child, `${path}.child`, depth + 1)
        break
      default:
        throw new BehaviorValidationError('UNKNOWN_NODE', path, 'unknown node kind')
    }
  }

  const visitCondition = (condition: Condition, path: string): void => {
    if (condition.kind === 'expr') visitExpr(condition.expr, `${path}.expr`)
    else if (condition.kind === 'query') {
      visitQuery(condition.query, `${path}.query`)
      visitExpr(condition.test, `${path}.test`)
    } else {
      throw new BehaviorValidationError('INVALID_CONDITION', path, 'unknown condition kind')
    }
  }

  const visitQuery = (query: { op: string; args: Record<string, ValueExpr>; freshnessMs?: number; timeoutMs?: number }, path: string): void => {
    if (typeof query.op !== 'string' || query.op.length === 0) {
      throw new BehaviorValidationError('INVALID_QUERY', path, 'query op is required')
    }
    for (const [name, value] of Object.entries(query.args)) visitExpr(value, `${path}.args.${name}`)
    if (query.freshnessMs !== undefined && (!Number.isFinite(query.freshnessMs) || query.freshnessMs < 0)) {
      throw new BehaviorValidationError('INVALID_QUERY', path, 'freshness must be non-negative')
    }
    if (query.timeoutMs !== undefined && (!Number.isFinite(query.timeoutMs) || query.timeoutMs < 0)) {
      throw new BehaviorValidationError('INVALID_QUERY', path, 'timeout must be non-negative')
    }
  }

  const visitExpr = (expr: ValueExpr, path: string): void => {
    if (seen.has(expr)) {
      throw new BehaviorValidationError('EXPR_CYCLE', path, 'shared or cyclic expression object')
    }
    seen.add(expr)
    switch (expr.kind) {
      case 'literal':
        return
      case 'param':
      case 'local':
        if (typeof expr.name !== 'string' || expr.name.length === 0) {
          throw new BehaviorValidationError('INVALID_EXPR', path, 'name is required')
        }
        return
      case 'member':
        visitExpr(expr.object, `${path}.object`)
        visitExpr(expr.key, `${path}.key`)
        return
      case 'record':
        for (const [name, value] of Object.entries(expr.fields)) visitExpr(value, `${path}.${name}`)
        return
      case 'array':
        expr.items.forEach((item, index) => visitExpr(item, `${path}[${index}]`))
        return
      case 'not':
        visitExpr(expr.value, `${path}.value`)
        return
      case 'binary':
        visitExpr(expr.left, `${path}.left`)
        visitExpr(expr.right, `${path}.right`)
        return
      default:
        throw new BehaviorValidationError('UNKNOWN_EXPR', path, 'unknown expression kind')
    }
  }

  visitNode(definition.root, 'root', 0)
  if (definition.completion?.kind === 'predicate') visitCondition(definition.completion.condition, 'completion')
  for (const [name, expr] of Object.entries(definition.progress ?? {})) visitExpr(expr, `progress.${name}`)
}

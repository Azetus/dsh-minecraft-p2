import { p2Error } from '../contracts/protocol.ts'
import type { P2Error } from '../contracts/types.ts'
import { ErrorCodes } from '../contracts/types.ts'
import type { Registry } from './registry.ts'
import type { Candidate, EvalCtx, Handoff, Hold, WorldView } from './types.ts'
import { isHold } from './types.ts'

export type TreeNode =
  | { type: 'priority'; children: TreeNode[] }
  | { type: 'sorter'; children: TreeNode[] }
  | {
      type: 'when'
      predicate: string
      onUnknown: 'skip' | 'noCandidate'
      then: TreeNode
      else?: TreeNode
    }
  | { type: 'subtree'; ref: string }
  | { type: 'sequence'; children: TreeNode[] }
  | { type: 'giver'; ref: string }

export type TreeResult =
  | { kind: 'job'; candidate: Candidate }
  | { kind: 'nowork' }
  | { kind: 'hold'; reason: string; notify?: boolean }
  | { kind: 'need-observation'; reason: string }
  | { kind: 'definition-error'; error: P2Error }

export type TreeMap = Map<string, TreeNode>

export type LoadTreesResult =
  | { ok: true; trees: TreeMap }
  | { ok: false; error: P2Error }

const MAX_NODES = 500
const MAX_DEPTH = 8

/**
 * Validate a named tree set supplied by code (or a test fixture). Unknown node
 * types, predicates, givers or subtrees, cycles, depth > 8 and more than 500
 * expanded nodes are all definition errors; the runtime refuses to start with
 * a broken set rather than half-loading it.
 */
export function loadTrees(definitions: Record<string, unknown>, registry: Registry): LoadTreesResult {
  const names = new Set(Object.keys(definitions))
  if (names.size === 0) return { ok: false, error: definitionError('no trees defined') }
  const trees: TreeMap = new Map()
  for (const [name, value] of Object.entries(definitions)) {
    const parsed = parseNode(value, `trees.${name}`, registry, names, 1, { count: 0 })
    if (!parsed.ok) return { ok: false, error: parsed.error }
    trees.set(name, parsed.node)
  }
  for (const name of names) {
    const expanded = checkExpanded(name, trees, new Set(), 0)
    if (!expanded.ok) return { ok: false, error: expanded.error }
  }
  return { ok: true, trees }
}

export function evaluateTree(
  name: string,
  trees: TreeMap,
  registry: Registry,
  ctx: EvalCtx,
  world: WorldView,
): TreeResult {
  if (world.stale === true) return { kind: 'need-observation', reason: 'stale-snapshot' }
  const root = trees.get(name)
  if (root === undefined) return { kind: 'definition-error', error: definitionError(`unknown tree: ${name}`) }
  try {
    return toPublic(evalNode(root, { ctx, world, registry, trees, stack: new Set([name]) }))
  } catch (error) {
    return { kind: 'definition-error', error: toDefinitionError(error) }
  }
}

type NodeOutcome =
  | { kind: 'job'; candidate: Candidate }
  | { kind: 'nowork' }
  | { kind: 'skip' }
  | { kind: 'hold'; reason: string; notify?: boolean }
  | { kind: 'need-observation'; reason: string }
  | { kind: 'definition-error'; error: P2Error }

type EvalEnv = {
  ctx: EvalCtx
  world: WorldView
  registry: Registry
  trees: TreeMap
  /** Guards against a cycle the loader should already have rejected. */
  stack: Set<string>
}

function evalNode(node: TreeNode, env: EvalEnv): NodeOutcome {
  switch (node.type) {
    case 'priority': {
      for (const child of node.children) {
        const outcome = evalNode(child, env)
        if (outcome.kind === 'skip' || outcome.kind === 'nowork') continue
        return outcome
      }
      return { kind: 'nowork' }
    }
    case 'sequence': {
      for (const child of node.children) {
        const outcome = evalNode(child, env)
        if (outcome.kind === 'skip') continue
        return outcome
      }
      return { kind: 'nowork' }
    }
    case 'sorter': {
      let best: { score: number; candidate: Candidate } | undefined
      for (const child of node.children) {
        const outcome = evalNode(child, env)
        if (outcome.kind === 'need-observation' || outcome.kind === 'definition-error') return outcome
        if (outcome.kind === 'hold') return outcome
        if (outcome.kind === 'skip' || outcome.kind === 'nowork') continue
        const score = scoreOf(child, env)
        if (best === undefined || score > best.score) best = { score, candidate: outcome.candidate }
      }
      return best === undefined ? { kind: 'nowork' } : { kind: 'job', candidate: best.candidate }
    }
    case 'when': {
      const predicate = env.registry.predicate(node.predicate)
      let value: boolean | 'unknown'
      try {
        value = predicate.fn(env.ctx, env.world)
      } catch (error) {
        return { kind: 'definition-error', error: toDefinitionError(error, `predicate ${node.predicate} failed`) }
      }
      if (value === 'unknown') {
        return node.onUnknown === 'skip' ? { kind: 'skip' } : { kind: 'nowork' }
      }
      if (value === true) return evalNode(node.then, env)
      return node.else === undefined ? { kind: 'nowork' } : evalNode(node.else, env)
    }
    case 'subtree': {
      if (env.stack.has(node.ref)) {
        return { kind: 'definition-error', error: definitionError(`subtree cycle at ${node.ref}`) }
      }
      const child = env.trees.get(node.ref)
      if (child === undefined) {
        return { kind: 'definition-error', error: definitionError(`unknown subtree: ${node.ref}`) }
      }
      env.stack.add(node.ref)
      try {
        return evalNode(child, env)
      } finally {
        env.stack.delete(node.ref)
      }
    }
    case 'giver': {
      const giver = env.registry.giver(node.ref)
      const found = giver.find(env.ctx, env.world)
      if (found === null) return { kind: 'nowork' }
      if (isHold(found)) {
        return {
          kind: 'hold',
          reason: found.reason,
          ...(found.notify === false ? { notify: false } : {}),
        }
      }
      return { kind: 'job', candidate: isHandoff(found) ? handoffCandidate(found) : found }
    }
  }
}

function scoreOf(node: TreeNode, env: EvalEnv): number {
  if (node.type !== 'giver') return 0
  return env.registry.giver(node.ref).score?.(env.ctx, env.world) ?? 0
}

function isHandoff(value: Candidate | Handoff | Hold): value is Handoff {
  return !('kind' in value) && 'reason' in value
}

function handoffCandidate(handoff: Handoff): Candidate {
  const { x, y, z } = handoff.target.pos
  return {
    driverId: handoff.driverId,
    target: handoff.target,
    params: handoff.params,
    keys: `handoff:${handoff.driverId}:${x},${y},${z}`,
    ...(handoff.orderId === undefined ? {} : { orderId: handoff.orderId }),
  }
}

function toPublic(outcome: NodeOutcome): TreeResult {
  if (outcome.kind === 'skip') return { kind: 'nowork' }
  return outcome
}

type ParseResult = { ok: true; node: TreeNode } | { ok: false; error: P2Error }

function parseNode(
  value: unknown,
  path: string,
  registry: Registry,
  treeNames: Set<string>,
  depth: number,
  counter: { count: number },
): ParseResult {
  counter.count += 1
  if (counter.count > MAX_NODES) return fail(path, `tree exceeds ${MAX_NODES} nodes`)
  if (depth > MAX_DEPTH) return fail(path, `tree exceeds depth ${MAX_DEPTH}`)
  if (!isRecord(value)) return fail(path, 'node must be an object')
  const type = value.type
  switch (type) {
    case 'priority':
    case 'sorter':
    case 'sequence': {
      const fields = onlyKeys(value, ['type', 'children'], path)
      if (fields !== undefined) return { ok: false, error: fields }
      const children = value.children
      if (!Array.isArray(children) || children.length === 0) return fail(`${path}.children`, 'children must be a non-empty array')
      const parsed: TreeNode[] = []
      for (let index = 0; index < children.length; index += 1) {
        const child = parseNode(children[index], `${path}.children[${index}]`, registry, treeNames, depth + 1, counter)
        if (!child.ok) return child
        parsed.push(child.node)
      }
      return { ok: true, node: { type, children: parsed } }
    }
    case 'when': {
      const fields = onlyKeys(value, ['type', 'predicate', 'onUnknown', 'then', 'else'], path)
      if (fields !== undefined) return { ok: false, error: fields }
      if (typeof value.predicate !== 'string' || !registry.hasPredicate(value.predicate)) {
        return fail(`${path}.predicate`, `unknown predicate: ${String(value.predicate)}`)
      }
      if (value.onUnknown !== 'skip' && value.onUnknown !== 'noCandidate') {
        return fail(`${path}.onUnknown`, 'onUnknown must be "skip" or "noCandidate"')
      }
      if (value.then === undefined) return fail(`${path}.then`, 'then is required')
      const thenNode = parseNode(value.then, `${path}.then`, registry, treeNames, depth + 1, counter)
      if (!thenNode.ok) return thenNode
      let elseNode: TreeNode | undefined
      if (value.else !== undefined) {
        const parsedElse = parseNode(value.else, `${path}.else`, registry, treeNames, depth + 1, counter)
        if (!parsedElse.ok) return parsedElse
        elseNode = parsedElse.node
      }
      return {
        ok: true,
        node: {
          type: 'when',
          predicate: value.predicate,
          onUnknown: value.onUnknown,
          then: thenNode.node,
          ...(elseNode === undefined ? {} : { else: elseNode }),
        },
      }
    }
    case 'subtree': {
      const fields = onlyKeys(value, ['type', 'ref'], path)
      if (fields !== undefined) return { ok: false, error: fields }
      if (typeof value.ref !== 'string' || !treeNames.has(value.ref)) {
        return fail(`${path}.ref`, `unknown subtree: ${String(value.ref)}`)
      }
      return { ok: true, node: { type: 'subtree', ref: value.ref } }
    }
    case 'giver': {
      const fields = onlyKeys(value, ['type', 'ref'], path)
      if (fields !== undefined) return { ok: false, error: fields }
      if (typeof value.ref !== 'string' || !registry.hasGiver(value.ref)) {
        return fail(`${path}.ref`, `unknown work giver: ${String(value.ref)}`)
      }
      return { ok: true, node: { type: 'giver', ref: value.ref } }
    }
    default:
      return fail(`${path}.type`, `unknown node type: ${String(type)}`)
  }
}

type ExpandedResult = { ok: true } | { ok: false; error: P2Error }

/** Count expanded nodes and depth so repeated subtrees cannot hide a blow-up. */
function checkExpanded(
  name: string,
  trees: TreeMap,
  stack: Set<string>,
  depth: number,
  counter: { count: number } = { count: 0 },
): ExpandedResult {
  if (stack.has(name)) return { ok: false, error: definitionError(`subtree cycle at ${name}`) }
  if (depth > MAX_DEPTH) return { ok: false, error: definitionError(`tree ${name} exceeds depth ${MAX_DEPTH}`) }
  const root = trees.get(name)
  if (root === undefined) return { ok: false, error: definitionError(`unknown tree: ${name}`) }
  return walkExpanded(root, name, trees, new Set([...stack, name]), depth + 1, counter)
}

function walkExpanded(
  node: TreeNode,
  treeName: string,
  trees: TreeMap,
  stack: Set<string>,
  depth: number,
  counter: { count: number },
): ExpandedResult {
  counter.count += 1
  if (counter.count > MAX_NODES) {
    return { ok: false, error: definitionError(`tree ${treeName} exceeds ${MAX_NODES} expanded nodes`) }
  }
  if (depth > MAX_DEPTH) {
    return { ok: false, error: definitionError(`tree ${treeName} exceeds depth ${MAX_DEPTH}`) }
  }
  switch (node.type) {
    case 'priority':
    case 'sorter':
    case 'sequence': {
      for (const child of node.children) {
        const result = walkExpanded(child, treeName, trees, stack, depth + 1, counter)
        if (!result.ok) return result
      }
      return { ok: true }
    }
    case 'when': {
      const thenResult = walkExpanded(node.then, treeName, trees, stack, depth + 1, counter)
      if (!thenResult.ok) return thenResult
      return node.else === undefined
        ? { ok: true }
        : walkExpanded(node.else, treeName, trees, stack, depth + 1, counter)
    }
    case 'subtree': {
      if (stack.has(node.ref)) return { ok: false, error: definitionError(`subtree cycle at ${node.ref}`) }
      const child = trees.get(node.ref)
      if (child === undefined) return { ok: false, error: definitionError(`unknown subtree: ${node.ref}`) }
      return walkExpanded(child, treeName, trees, new Set([...stack, node.ref]), depth + 1, counter)
    }
    case 'giver':
      return { ok: true }
  }
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], path: string): P2Error | undefined {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return definitionError(`unknown field at ${path}.${key}`)
    }
  }
  return undefined
}

function fail(path: string, message: string): ParseResult {
  return { ok: false, error: definitionError(`${path}: ${message}`) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function definitionError(message: string): P2Error {
  return p2Error(ErrorCodes.DEFINITION_ERROR, 'validation', message, { module: 'mind.tree' })
}

function toDefinitionError(error: unknown, context?: string): P2Error {
  const suffix = context === undefined ? '' : `${context}: `
  const message = error instanceof Error ? error.message : String(error)
  return definitionError(`${suffix}${message}`)
}

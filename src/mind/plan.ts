import { asP2Error, p2Error } from '../contracts/protocol.ts'
import type { P2Error } from '../contracts/types.ts'
import { ErrorCodes } from '../contracts/types.ts'
import type { BlockInfo, Item, Vec3 } from '../port/index.ts'
import type { ConflictPolicy } from './policy.ts'
import { isStandable } from './standing.ts'
import type { WorldView } from './types.ts'

export const WORK_ITEM_KINDS = ['clear', 'prepare', 'place', 'enter', 'hold'] as const
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number]

export type ExpectedBlock = {
  name: string
  state?: Record<string, string>
}

export type WorkItem = {
  id: string
  kind: WorkItemKind
  /** Relative to the plan origin (interior minimum corner, floor layer). */
  at: [number, number, number]
  expected?: ExpectedBlock
  after?: string[]
}

export type VerifySpec = {
  kind: 'sealed-room'
  min: [number, number, number]
  max: [number, number, number]
}

export type MaterialPolicy = Record<string, { auto: boolean; maxBudgetTicks?: number }>

export type PlanTemplate = {
  id: string
  version: number
  size: [number, number, number]
  materialPolicy: MaterialPolicy
  workItems: WorkItem[]
  verify?: VerifySpec
}

export type PlanInstance = {
  planId: string
  orderId: string
  template: string
  templateVersion: number
  origin: Vec3
  size: [number, number, number]
  materialPolicy: MaterialPolicy
  workItems: WorkItem[]
  verify?: VerifySpec
}

export type BlockReason = 'NO_SUPPORT' | 'NO_STAND' | 'NO_MATERIAL' | 'UNREACHABLE' | 'CONFLICT'

export type WorkState =
  | { kind: 'satisfied' }
  | { kind: 'executable'; driverId: string }
  | { kind: 'blocked'; reason: BlockReason }
  | { kind: 'unknown' }

export type PlanEvaluation = {
  states: Map<string, WorkState>
  next: { item: WorkItem; state: WorkState } | undefined
  satisfied: boolean
  /** True when no item is executable or unknown and at least one is blocked. */
  blocked: boolean
}

export type LoadPlansResult =
  | { ok: true; templates: Map<string, PlanTemplate> }
  | { ok: false; error: P2Error }

const DRIVER_BY_KIND: Record<WorkItemKind, string> = {
  clear: 'clear',
  prepare: 'prepare',
  place: 'place',
  enter: 'enter',
  hold: 'hold',
}

/**
 * Parse and validate plan templates. Work-item ids are unique, `after` is a
 * DAG, and expected state matching is a string subset of the observed block.
 */
export function loadPlanTemplates(definitions: Record<string, unknown>): LoadPlansResult {
  const templates = new Map<string, PlanTemplate>()
  for (const [name, value] of Object.entries(definitions)) {
    try {
      const parsed = parseTemplate(value, name)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      templates.set(parsed.template.id, parsed.template)
    } catch (error) {
      const known = asP2Error(error)
      if (known !== undefined) return { ok: false, error: known }
      throw error
    }
  }
  return { ok: true, templates }
}

export function instantiatePlan(
  template: PlanTemplate,
  orderId: string,
  origin: Vec3,
): PlanInstance {
  return {
    planId: `plan-${orderId}-${template.id}`,
    orderId,
    template: template.id,
    templateVersion: template.version,
    origin: { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) },
    size: [...template.size],
    materialPolicy: structuredClone(template.materialPolicy),
    workItems: template.workItems.map(item => structuredClone(item)),
    ...(template.verify === undefined ? {} : { verify: structuredClone(template.verify) }),
  }
}

export function itemPosition(plan: PlanInstance, item: WorkItem): Vec3 {
  return {
    x: plan.origin.x + item.at[0],
    y: plan.origin.y + item.at[1],
    z: plan.origin.z + item.at[2],
  }
}

export function evaluatePlan(
  plan: PlanInstance,
  world: WorldView,
  conflictPolicy?: ConflictPolicy,
): PlanEvaluation {
  const states = new Map<string, WorkState>()
  const stateOf = (item: WorkItem): WorkState => {
    const known = states.get(item.id)
    if (known !== undefined) return known
    const state = evaluateItem(plan, item, world, stateOf, conflictPolicy)
    states.set(item.id, state)
    return state
  }

  let next: { item: WorkItem; state: WorkState } | undefined
  let satisfied = true
  let blocked = false
  let unknown = false
  for (const item of plan.workItems) {
    const state = stateOf(item)
    if (state.kind !== 'satisfied') satisfied = false
    if (state.kind === 'executable' && next === undefined) next = { item, state }
    if (state.kind === 'blocked') blocked = true
    if (state.kind === 'unknown') unknown = true
  }
  return {
    states,
    next,
    satisfied,
    // "All blocked" means every item is known and blocked; an unknown cell
    // must not turn into a blocked report.
    blocked: next === undefined && blocked && !unknown,
  }
}

function evaluateItem(
  plan: PlanInstance,
  item: WorkItem,
  world: WorldView,
  stateOf: (item: WorkItem) => WorkState,
  conflictPolicy: ConflictPolicy | undefined,
): WorkState {
  if (world.stale === true) return { kind: 'unknown' }
  for (const dependency of item.after ?? []) {
    const dependencyItem = plan.workItems.find(candidate => candidate.id === dependency)
    if (dependencyItem === undefined) return { kind: 'blocked', reason: 'CONFLICT' }
    if (stateOf(dependencyItem).kind !== 'satisfied') return { kind: 'blocked', reason: 'CONFLICT' }
  }

  const position = itemPosition(plan, item)
  switch (item.kind) {
    case 'clear': {
      const block = world.blockAt(position)
      if (block === null || !block.loaded) return { kind: 'unknown' }
      if (isAirName(block.name)) return { kind: 'satisfied' }
      if (!withinReach(world, position)) return { kind: 'blocked', reason: 'UNREACHABLE' }
      return { kind: 'executable', driverId: DRIVER_BY_KIND.clear }
    }
    case 'prepare':
    case 'enter': {
      const block = world.blockAt(position)
      if (block === null || !block.loaded) return { kind: 'unknown' }
      if (!isStandable(world, position)) return { kind: 'blocked', reason: 'NO_STAND' }
      const self = world.self.pos
      // "Being at" a stand cell allows the normal position tolerance of a
      // walk; requiring the exact integer cell makes enter jobs loop forever.
      const horizontal = Math.hypot(self.x - (position.x + 0.5), self.z - (position.z + 0.5))
      if (horizontal <= 1.5 && Math.abs(Math.floor(self.y) - position.y) <= 1) {
        return { kind: 'satisfied' }
      }
      return { kind: 'executable', driverId: DRIVER_BY_KIND[item.kind] }
    }
    case 'place':
    case 'hold': {
      const expected = item.expected
      if (expected === undefined) return { kind: 'blocked', reason: 'CONFLICT' }
      const block = world.blockAt(position)
      if (block === null || !block.loaded) return { kind: 'unknown' }
      if (matchesExpected(block, expected)) return { kind: 'satisfied' }
      if (item.kind === 'hold') return { kind: 'blocked', reason: 'CONFLICT' }
      // Fluids are always an attempt: the server decides whether the block
      // replaces them. A solid foreign block obeys the Agent's conflict policy.
      if (!isAirName(block.name) && !isFluidName(block.name)
        && conflictPolicy?.mode !== undefined && conflictPolicy.mode !== 'skip') {
        return { kind: 'blocked', reason: 'CONFLICT' }
      }
      if (!hasSupport(world, position)) return { kind: 'blocked', reason: 'NO_SUPPORT' }
      if (countItem(world.inventory, expected.name) < 1) return { kind: 'blocked', reason: 'NO_MATERIAL' }
      if (!withinReach(world, position)) return { kind: 'blocked', reason: 'UNREACHABLE' }
      return { kind: 'executable', driverId: DRIVER_BY_KIND.place }
    }
  }
}

export function isAirName(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

export function isFluidName(name: string): boolean {
  return name === 'water' || name === 'lava'
}

export function isSolidBlock(block: BlockInfo | null): boolean {
  return block !== null && block.loaded && !isAirName(block.name) && !isFluidName(block.name)
}

export function matchesExpected(block: BlockInfo, expected: ExpectedBlock): boolean {
  if (!block.loaded) return false
  const actual = normalizeName(block.name)
  const wanted = normalizeName(expected.name)
  // A torch placed on a side face is reported by the server as wall_torch.
  // Treat it as the same semantic block when the blueprint asks for a torch.
  if (actual !== wanted && !(wanted === 'torch' && actual === 'wall_torch')) return false
  for (const [key, value] of Object.entries(expected.state ?? {})) {
    if (block.state?.[key] !== value) return false
  }
  return true
}

export function countItem(inventory: Item[], name: string): number {
  const normalized = normalizeName(name)
  return inventory
    .filter(item => normalizeName(item.name) === normalized)
    .reduce((total, item) => total + item.count, 0)
}

function hasSupport(world: WorldView, position: Vec3): boolean {
  const neighbors: Vec3[] = [
    { x: position.x, y: position.y - 1, z: position.z },
    { x: position.x, y: position.y + 1, z: position.z },
    { x: position.x + 1, y: position.y, z: position.z },
    { x: position.x - 1, y: position.y, z: position.z },
    { x: position.x, y: position.y, z: position.z + 1 },
    { x: position.x, y: position.y, z: position.z - 1 },
  ]
  return neighbors.some(neighbor => isSolidBlock(world.blockAt(neighbor)))
}

function withinReach(world: WorldView, position: Vec3): boolean {
  const eye = { x: world.self.pos.x, y: world.self.pos.y + 1.5, z: world.self.pos.z }
  return Math.hypot(
    position.x + 0.5 - eye.x,
    position.y + 0.5 - eye.y,
    position.z + 0.5 - eye.z,
  ) <= 4.5
}

function normalizeName(name: string): string {
  return name.replace(/^minecraft:/u, '')
}

type ParseResult =
  | { ok: true; template: PlanTemplate }
  | { ok: false; error: P2Error }

function parseTemplate(value: unknown, name: string): ParseResult {
  if (!isRecord(value)) return fail(name, 'template must be an object')
  onlyKeys(value, ['id', 'version', 'size', 'materialPolicy', 'workItems', 'verify'], name)
  if (typeof value.id !== 'string' || value.id.length === 0) return fail(`${name}.id`, 'id is required')
  if (!Number.isInteger(value.version) || (value.version as number) <= 0) {
    return fail(`${name}.version`, 'version must be a positive integer')
  }
  if (!isTriple(value.size) || value.size.some(entry => entry <= 0)) {
    return fail(`${name}.size`, 'size must be three positive integers')
  }

  const materialPolicy: MaterialPolicy = {}
  if (value.materialPolicy !== undefined) {
    if (!isRecord(value.materialPolicy)) return fail(`${name}.materialPolicy`, 'must be an object')
    for (const [material, policy] of Object.entries(value.materialPolicy)) {
      if (!isRecord(policy)) return fail(`${name}.materialPolicy.${material}`, 'must be an object')
      onlyKeys(policy, ['auto', 'maxBudgetTicks'], `${name}.materialPolicy.${material}`)
      if (typeof policy.auto !== 'boolean') return fail(`${name}.materialPolicy.${material}.auto`, 'auto must be boolean')
      if (policy.maxBudgetTicks !== undefined
        && (!Number.isInteger(policy.maxBudgetTicks) || (policy.maxBudgetTicks as number) < 0)) {
        return fail(`${name}.materialPolicy.${material}.maxBudgetTicks`, 'must be a non-negative integer')
      }
      materialPolicy[material] = {
        auto: policy.auto,
        ...(policy.maxBudgetTicks === undefined ? {} : { maxBudgetTicks: policy.maxBudgetTicks as number }),
      }
    }
  }

  if (!Array.isArray(value.workItems) || value.workItems.length === 0) {
    return fail(`${name}.workItems`, 'workItems must be a non-empty array')
  }
  const workItems: WorkItem[] = []
  const ids = new Set<string>()
  for (let index = 0; index < value.workItems.length; index += 1) {
    const parsed = parseWorkItem(value.workItems[index], `${name}.workItems[${index}]`)
    if (!parsed.ok) return parsed
    if (ids.has(parsed.item.id)) return fail(`${name}.workItems[${index}].id`, `duplicate work item id: ${parsed.item.id}`)
    ids.add(parsed.item.id)
    workItems.push(parsed.item)
  }
  for (const item of workItems) {
    for (const dependency of item.after ?? []) {
      if (!ids.has(dependency)) return fail(`${name}.${item.id}.after`, `unknown dependency: ${dependency}`)
    }
  }
  if (hasCycle(workItems)) return fail(name, 'work item dependencies contain a cycle')

  let verify: VerifySpec | undefined
  if (value.verify !== undefined) {
    if (!isRecord(value.verify)) return fail(`${name}.verify`, 'must be an object')
    onlyKeys(value.verify, ['kind', 'min', 'max'], `${name}.verify`)
    if (value.verify.kind !== 'sealed-room') return fail(`${name}.verify.kind`, 'only sealed-room is supported')
    if (!isTriple(value.verify.min) || !isTriple(value.verify.max)) {
      return fail(`${name}.verify`, 'min/max must be three integers')
    }
    for (let axis = 0; axis < 3; axis += 1) {
      if ((value.verify.min[axis] as number) > (value.verify.max[axis] as number)) {
        return fail(`${name}.verify`, 'min must not exceed max')
      }
    }
    verify = {
      kind: 'sealed-room',
      min: [...value.verify.min] as [number, number, number],
      max: [...value.verify.max] as [number, number, number],
    }
  }

  return {
    ok: true,
    template: {
      id: value.id,
      version: value.version as number,
      size: [...value.size] as [number, number, number],
      materialPolicy,
      workItems,
      ...(verify === undefined ? {} : { verify }),
    },
  }
}

function parseWorkItem(value: unknown, path: string): { ok: true; item: WorkItem } | { ok: false; error: P2Error } {
  if (!isRecord(value)) return fail(path, 'work item must be an object')
  onlyKeys(value, ['id', 'kind', 'at', 'expected', 'after'], path)
  if (typeof value.id !== 'string' || value.id.length === 0) return fail(`${path}.id`, 'id is required')
  if (typeof value.kind !== 'string' || !(WORK_ITEM_KINDS as readonly string[]).includes(value.kind)) {
    return fail(`${path}.kind`, `unsupported kind: ${String(value.kind)}`)
  }
  const kind = value.kind as WorkItemKind
  if (!isTriple(value.at)) return fail(`${path}.at`, 'at must be three integers')

  let expected: ExpectedBlock | undefined
  if (value.expected !== undefined) {
    if (!isRecord(value.expected)) return fail(`${path}.expected`, 'must be an object')
    onlyKeys(value.expected, ['name', 'state'], `${path}.expected`)
    if (typeof value.expected.name !== 'string' || value.expected.name.length === 0) {
      return fail(`${path}.expected.name`, 'name is required')
    }
    let state: Record<string, string> | undefined
    if (value.expected.state !== undefined) {
      if (!isRecord(value.expected.state)) return fail(`${path}.expected.state`, 'must be an object')
      state = {}
      for (const [key, entry] of Object.entries(value.expected.state)) {
        if (typeof entry !== 'string') return fail(`${path}.expected.state.${key}`, 'state values must be strings')
        state[key] = entry
      }
    }
    expected = { name: value.expected.name, ...(state === undefined ? {} : { state }) }
  }
  if ((kind === 'place' || kind === 'hold') && expected === undefined) {
    return fail(`${path}.expected`, `${kind} requires an expected block`)
  }

  let after: string[] | undefined
  if (value.after !== undefined) {
    if (!Array.isArray(value.after) || value.after.some(entry => typeof entry !== 'string')) {
      return fail(`${path}.after`, 'after must be an array of work item ids')
    }
    after = [...value.after] as string[]
  }

  return {
    ok: true,
    item: {
      id: value.id,
      kind,
      at: [...value.at] as [number, number, number],
      ...(expected === undefined ? {} : { expected }),
      ...(after === undefined ? {} : { after }),
    },
  }
}

function hasCycle(items: WorkItem[]): boolean {
  const byId = new Map(items.map(item => [item.id, item]))
  const visiting = new Set<string>()
  const done = new Set<string>()
  const visit = (id: string): boolean => {
    if (done.has(id)) return false
    if (visiting.has(id)) return true
    visiting.add(id)
    for (const dependency of byId.get(id)?.after ?? []) {
      if (visit(dependency)) return true
    }
    visiting.delete(id)
    done.add(id)
    return false
  }
  return items.some(item => visit(item.id))
}

function isTriple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(entry => Number.isInteger(entry))
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw definitionError(`${path}.${key}: unknown field`)
  }
}

function fail(path: string, message: string): { ok: false; error: P2Error } {
  return { ok: false, error: definitionError(`${path}: ${message}`) }
}

function definitionError(message: string): P2Error {
  return p2Error(ErrorCodes.DEFINITION_ERROR, 'validation', message, { module: 'mind.plan' })
}

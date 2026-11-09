import { isRecord } from '../contracts/protocol.ts'
import type { Vec3 } from '../body/api.ts'
import { instantiatePlan } from './plan.ts'
import type { PlanInstance, PlanTemplate, WorkItem } from './plan.ts'

export const BLUEPRINT_MAX_BLOCKS = 4096

export type BlueprintBlock = {
  x: number
  y: number
  z: number
  name: string
  state?: Record<string, string>
}

export type BlueprintVerify =
  | {
      kind: 'sealed-room'
      min: Vec3
      max: Vec3
    }
  | {
      kind: 'usable-room'
      min: Vec3
      max: Vec3
      door?: Vec3
      bed?: Vec3
    }

export type Blueprint = {
  /** Final-geometry schema version; only 1 is accepted now. */
  version: number
  blocks: BlueprintBlock[]
  verify?: BlueprintVerify
}

export type BlueprintParse =
  | { ok: true; blueprint: Blueprint }
  | { ok: false; errors: string[] }

/**
 * A blueprint is final geometry only: absolute block cells plus an optional
 * verifier. It carries no step order, paths, clear/prepare items or scripts;
 * P2Mind derives those from the world.
 */
export function parseBlueprint(value: unknown): BlueprintParse {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ['blueprint must be an object'] }
  for (const key of Object.keys(value)) {
    if (key !== 'blocks' && key !== 'verify' && key !== 'version') {
      errors.push(`blueprint.${key}: unknown field`)
    }
  }
  const version = value.version ?? 1
  if (version !== 1) errors.push('blueprint.version must be 1')
  if (!Array.isArray(value.blocks)) {
    return { ok: false, errors: [...errors, 'blueprint.blocks must be an array'] }
  }
  if (value.blocks.length === 0) errors.push('blueprint.blocks must not be empty')
  if (value.blocks.length > BLUEPRINT_MAX_BLOCKS) {
    errors.push(`blueprint.blocks exceeds ${BLUEPRINT_MAX_BLOCKS}`)
  }

  const blocks: BlueprintBlock[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.blocks.length; index += 1) {
    const parsed = parseBlock(value.blocks[index], `blueprint.blocks[${index}]`)
    if (!parsed.ok) {
      errors.push(...parsed.errors)
      continue
    }
    const key = `${parsed.block.x},${parsed.block.y},${parsed.block.z}`
    if (seen.has(key)) {
      errors.push(`blueprint.blocks[${index}]: duplicate position ${key}`)
      continue
    }
    seen.add(key)
    blocks.push(parsed.block)
  }

  let verify: BlueprintVerify | undefined
  if (value.verify !== undefined) {
    if (!isRecord(value.verify)) {
      errors.push('blueprint.verify must be an object')
    } else {
      const kind = value.verify.kind
      if (kind !== 'sealed-room' && kind !== 'usable-room') {
        errors.push('blueprint.verify.kind must be sealed-room or usable-room')
      } else {
        const allowed = kind === 'usable-room'
          ? ['kind', 'min', 'max', 'door', 'bed']
          : ['kind', 'min', 'max']
        for (const key of Object.keys(value.verify)) {
          if (!allowed.includes(key)) errors.push(`blueprint.verify.${key}: unknown field`)
        }
        const min = parseVec(value.verify.min, 'blueprint.verify.min', errors)
        const max = parseVec(value.verify.max, 'blueprint.verify.max', errors)
        if (min !== undefined && max !== undefined) {
          if (min.x > max.x || min.y > max.y || min.z > max.z) {
            errors.push('blueprint.verify min must not exceed max')
          } else if (kind === 'sealed-room') {
            verify = { kind: 'sealed-room', min, max }
          } else {
            const door = value.verify.door === undefined
              ? undefined
              : parseVec(value.verify.door, 'blueprint.verify.door', errors)
            const bed = value.verify.bed === undefined
              ? undefined
              : parseVec(value.verify.bed, 'blueprint.verify.bed', errors)
            if (value.verify.door !== undefined && door === undefined) {
              errors.push('blueprint.verify.door must be [x,y,z]')
            }
            if (value.verify.bed !== undefined && bed === undefined) {
              errors.push('blueprint.verify.bed must be [x,y,z]')
            }
            if ((value.verify.door === undefined || door !== undefined)
              && (value.verify.bed === undefined || bed !== undefined)) {
              verify = {
                kind: 'usable-room',
                min,
                max,
                ...(door === undefined ? {} : { door }),
                ...(bed === undefined ? {} : { bed }),
              }
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  const blueprint: Blueprint = { version: version as number, blocks, ...(verify === undefined ? {} : { verify }) }
  validatePlacementGroups(blueprint, errors)
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, blueprint }
}

/**
 * A usable-room door and bed are two-cell placements. The blueprint is final
 * geometry, so both cells must be declared; a missing second cell would either
 * place a half block or make the verifier's state check unreachable.
 */
function validatePlacementGroups(blueprint: Blueprint, errors: string[]): void {
  const verify = blueprint.verify
  if (verify === undefined || verify.kind !== 'usable-room') return
  const byPosition = new Map(blueprint.blocks.map(block => [`${block.x},${block.y},${block.z}`, block]))
  if (verify.door !== undefined) {
    const lower = byPosition.get(`${verify.door.x},${verify.door.y},${verify.door.z}`)
    const upper = byPosition.get(`${verify.door.x},${verify.door.y + 1},${verify.door.z}`)
    if (lower === undefined) {
      errors.push('blueprint.verify.door has no block at the door cell')
    } else if (lower.state?.half !== undefined && lower.state.half !== 'lower') {
      errors.push('blueprint.verify.door block state.half must be "lower"')
    }
    if (upper === undefined) {
      errors.push('blueprint.verify.door requires the upper cell as a blueprint block (a door is one two-cell placement)')
    } else if (upper.state?.half !== undefined && upper.state.half !== 'upper') {
      errors.push('blueprint.verify.door upper block state.half must be "upper"')
    }
  }
  if (verify.bed !== undefined) {
    const foot = byPosition.get(`${verify.bed.x},${verify.bed.y},${verify.bed.z}`)
    if (foot === undefined) {
      errors.push('blueprint.verify.bed has no block at the bed cell')
      return
    }
    // The head must be declared explicitly: a single bed cell cannot describe
    // which direction the second half occupies, and guessing it would place a
    // half block that the verifier can never accept.
    const head = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dz]) => byPosition.get(`${foot.x + (dx as number)},${foot.y},${foot.z + (dz as number)}`))
      .find(block => block !== undefined && block.name === foot.name)
    if (head === undefined) {
      errors.push('blueprint.verify.bed requires the head cell as an adjacent blueprint block (a bed is one two-cell placement)')
      return
    }
    if (foot.state?.part !== 'foot') {
      errors.push('blueprint.verify.bed block state.part must be "foot"')
    }
    if (head.state?.part !== 'head') {
      errors.push('blueprint.verify.bed head block state.part must be "head"')
    }
  }
}

/**
 * Translate final geometry to place work items. The support order is not
 * encoded: plan evaluation derives it from the live world.
 *
 * A door (lower/upper) or a bed (foot/head) is **one** work item: the server
 * produces both cells from one placement, so a second placement at the other
 * cell would fail and the verifier could never see a consistent pair. Grouping
 * uses declared block state (`half` / `part`) or the verifier's door/bed
 * anchors; it never matches a block name.
 */
export function blueprintTemplate(blueprint: Blueprint): PlanTemplate {
  const min = minCorner(blueprint.blocks)
  const max = maxCorner(blueprint.blocks)
  const grouped = groupBlueprintBlocks(blueprint)
  const workItems: WorkItem[] = []
  for (let index = 0; index < blueprint.blocks.length; index += 1) {
    const anchor = blueprint.blocks[index]!
    if (grouped.consumed.has(index)) continue
    const group = grouped.groups.get(index)
    if (group === undefined) {
      workItems.push(singleItem(anchor, min))
      continue
    }
    workItems.push({
      id: `b:${anchor.x},${anchor.y},${anchor.z}`,
      kind: 'place',
      at: [anchor.x - min.x, anchor.y - min.y, anchor.z - min.z],
      expected: expectedOf(anchor),
      cells: group.map(block => ({
        at: [block.x - min.x, block.y - min.y, block.z - min.z] as [number, number, number],
        expected: expectedOf(block),
      })),
    })
  }
  return {
    id: 'blueprint',
    version: blueprint.version,
    size: [max.x - min.x + 1, max.y - min.y + 1, max.z - min.z + 1],
    materialPolicy: {},
    workItems,
    ...(blueprint.verify === undefined
      ? {}
      : {
          verify: blueprint.verify.kind === 'sealed-room'
            ? {
                kind: 'sealed-room' as const,
                min: relative(blueprint.verify.min, min),
                max: relative(blueprint.verify.max, min),
              }
            : {
                kind: 'usable-room' as const,
                min: relative(blueprint.verify.min, min),
                max: relative(blueprint.verify.max, min),
                ...(blueprint.verify.door === undefined
                  ? {}
                  : { door: relative(blueprint.verify.door, min) }),
                ...(blueprint.verify.bed === undefined
                  ? {}
                  : { bed: relative(blueprint.verify.bed, min) }),
              },
        }),
  }
}

function singleItem(block: BlueprintBlock, min: Vec3): WorkItem {
  return {
    id: `b:${block.x},${block.y},${block.z}`,
    kind: 'place',
    at: [block.x - min.x, block.y - min.y, block.z - min.z],
    expected: expectedOf(block),
  }
}

function expectedOf(block: BlueprintBlock): { name: string; state?: Record<string, string> } {
  return {
    name: block.name,
    ...(block.state === undefined ? {} : { state: { ...block.state } }),
  }
}

export type BlueprintGroups = {
  /** Anchor block index → the other cells this one placement must produce. */
  groups: Map<number, BlueprintBlock[]>
  /** Indices consumed as a secondary cell (never a separate work item). */
  consumed: Set<number>
}

/** Exposed for tests and for the definition-error path. */
export function groupBlueprintBlocks(blueprint: Blueprint): BlueprintGroups {
  const byPosition = new Map<string, number>()
  blueprint.blocks.forEach((block, index) => byPosition.set(`${block.x},${block.y},${block.z}`, index))
  const groups = new Map<number, BlueprintBlock[]>()
  const consumed = new Set<number>()

  const pair = (index: number, other: number | undefined): void => {
    if (other === undefined || consumed.has(other) || other === index) return
    const existing = groups.get(index)
    if (existing === undefined) groups.set(index, [blueprint.blocks[other]!])
    else existing.push(blueprint.blocks[other]!)
    consumed.add(other)
  }

  for (let index = 0; index < blueprint.blocks.length; index += 1) {
    if (consumed.has(index)) continue
    const block = blueprint.blocks[index]!
    if (block.state?.half === 'upper') continue
    if (block.state?.part === 'head') continue
    // Vertical pair (door lower/upper) from declared state.
    if (block.state?.half === 'lower') {
      pair(index, byPosition.get(`${block.x},${block.y + 1},${block.z}`))
    }
    // Horizontal pair (bed foot/head) from declared state.
    if (block.state?.part === 'foot') {
      pair(index, neighbourIndex(blueprint.blocks, byPosition, block, true))
    }
  }

  // Without declared state, the verifier anchors still identify the pair.
  const verify = blueprint.verify
  if (verify !== undefined && verify.kind === 'usable-room') {
    if (verify.door !== undefined) {
      const lower = byPosition.get(`${verify.door.x},${verify.door.y},${verify.door.z}`)
      if (lower !== undefined && !consumed.has(lower)) {
        pair(lower, byPosition.get(`${verify.door.x},${verify.door.y + 1},${verify.door.z}`))
      }
    }
    if (verify.bed !== undefined) {
      const foot = byPosition.get(`${verify.bed.x},${verify.bed.y},${verify.bed.z}`)
      if (foot !== undefined && !consumed.has(foot) && blueprint.blocks[foot]!.state?.part === 'foot') {
        pair(foot, neighbourIndex(blueprint.blocks, byPosition, blueprint.blocks[foot]!, false))
      }
    }
  }
  return { groups, consumed }
}

function neighbourIndex(
  blocks: BlueprintBlock[],
  byPosition: Map<string, number>,
  block: BlueprintBlock,
  preferHead: boolean,
): number | undefined {
  const candidates: number[] = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const index = byPosition.get(`${block.x + dx},${block.y},${block.z + dz}`)
    if (index === undefined) continue
    const other = blocks[index]!
    if (other.name !== block.name) continue
    if (preferHead && other.state?.part !== 'head') continue
    candidates.push(index)
  }
  return candidates[0]
}

function relative(point: Vec3, origin: Vec3): [number, number, number] {
  return [point.x - origin.x, point.y - origin.y, point.z - origin.z]
}

export function blueprintPlan(blueprint: Blueprint, orderId: string): PlanInstance {
  return instantiatePlan(blueprintTemplate(blueprint), orderId, minCorner(blueprint.blocks))
}

export function blueprintMaterials(blueprint: Blueprint): Record<string, number> {
  const required: Record<string, number> = {}
  // One work item consumes one item, even when it produces two cells.
  for (const item of blueprintTemplate(blueprint).workItems) {
    if (item.expected === undefined) continue
    required[item.expected.name] = (required[item.expected.name] ?? 0) + 1
  }
  return required
}

function parseBlock(value: unknown, path: string): { ok: true; block: BlueprintBlock } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: [`${path} must be an object`] }
  for (const key of Object.keys(value)) {
    if (!['x', 'y', 'z', 'name', 'state'].includes(key)) errors.push(`${path}.${key}: unknown field`)
  }
  const x = parseCoordinate(value.x, `${path}.x`, errors)
  const y = parseCoordinate(value.y, `${path}.y`, errors)
  const z = parseCoordinate(value.z, `${path}.z`, errors)
  if (typeof value.name !== 'string' || value.name.length === 0) {
    errors.push(`${path}.name must be a non-empty block name`)
  }
  let state: Record<string, string> | undefined
  if (value.state !== undefined) {
    if (!isRecord(value.state)) {
      errors.push(`${path}.state must be an object`)
    } else {
      state = {}
      for (const [key, entry] of Object.entries(value.state)) {
        if (typeof entry !== 'string') {
          errors.push(`${path}.state.${key} must be a string`)
          continue
        }
        state[key] = entry
      }
    }
  }
  if (errors.length > 0 || x === undefined || y === undefined || z === undefined) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    block: {
      x,
      y,
      z,
      name: normalizeName(value.name as string),
      ...(state === undefined ? {} : { state }),
    },
  }
}

function parseVec(value: unknown, path: string, errors: string[]): Vec3 | undefined {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`)
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (!['x', 'y', 'z'].includes(key)) errors.push(`${path}.${key}: unknown field`)
  }
  const x = parseCoordinate(value.x, `${path}.x`, errors)
  const y = parseCoordinate(value.y, `${path}.y`, errors)
  const z = parseCoordinate(value.z, `${path}.z`, errors)
  return x === undefined || y === undefined || z === undefined ? undefined : { x, y, z }
}

function parseCoordinate(value: unknown, path: string, errors: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    errors.push(`${path} must be a safe integer`)
    return undefined
  }
  return value
}

function minCorner(blocks: BlueprintBlock[]): Vec3 {
  return blocks.reduce((min, block) => ({
    x: Math.min(min.x, block.x),
    y: Math.min(min.y, block.y),
    z: Math.min(min.z, block.z),
  }), { x: blocks[0]?.x ?? 0, y: blocks[0]?.y ?? 0, z: blocks[0]?.z ?? 0 })
}

function maxCorner(blocks: BlueprintBlock[]): Vec3 {
  return blocks.reduce((max, block) => ({
    x: Math.max(max.x, block.x),
    y: Math.max(max.y, block.y),
    z: Math.max(max.z, block.z),
  }), { x: blocks[0]?.x ?? 0, y: blocks[0]?.y ?? 0, z: blocks[0]?.z ?? 0 })
}

function normalizeName(name: string): string {
  return name.replace(/^minecraft:/u, '')
}

import { isRecord } from '../contracts/protocol.ts'
import type { Vec3 } from '../port/index.ts'
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
  return { ok: true, blueprint: { version: version as number, blocks, ...(verify === undefined ? {} : { verify }) } }
}

/**
 * Translate final geometry to place work items. The support order is not
 * encoded: plan evaluation derives it from the live world.
 */
export function blueprintTemplate(blueprint: Blueprint): PlanTemplate {
  const min = minCorner(blueprint.blocks)
  const max = maxCorner(blueprint.blocks)
  const workItems: WorkItem[] = blueprint.blocks.map(block => ({
    id: `b:${block.x},${block.y},${block.z}`,
    kind: 'place',
    at: [block.x - min.x, block.y - min.y, block.z - min.z],
    expected: {
      name: block.name,
      ...(block.state === undefined ? {} : { state: { ...block.state } }),
    },
  }))
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

function relative(point: Vec3, origin: Vec3): [number, number, number] {
  return [point.x - origin.x, point.y - origin.y, point.z - origin.z]
}

export function blueprintPlan(blueprint: Blueprint, orderId: string): PlanInstance {
  return instantiatePlan(blueprintTemplate(blueprint), orderId, minCorner(blueprint.blocks))
}

export function blueprintMaterials(blueprint: Blueprint): Record<string, number> {
  const required: Record<string, number> = {}
  for (const block of blueprint.blocks) {
    required[block.name] = (required[block.name] ?? 0) + 1
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

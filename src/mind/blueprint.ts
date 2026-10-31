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

export type BlueprintVerify = {
  kind: 'sealed-room'
  min: Vec3
  max: Vec3
}

export type Blueprint = {
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
    if (key !== 'blocks' && key !== 'verify') errors.push(`blueprint.${key}: unknown field`)
  }
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
      for (const key of Object.keys(value.verify)) {
        if (key !== 'kind' && key !== 'min' && key !== 'max') {
          errors.push(`blueprint.verify.${key}: unknown field`)
        }
      }
      if (value.verify.kind !== 'sealed-room') {
        errors.push('blueprint.verify.kind must be sealed-room')
      }
      const min = parseVec(value.verify.min, 'blueprint.verify.min', errors)
      const max = parseVec(value.verify.max, 'blueprint.verify.max', errors)
      if (min !== undefined && max !== undefined) {
        if (min.x > max.x || min.y > max.y || min.z > max.z) {
          errors.push('blueprint.verify min must not exceed max')
        } else if (value.verify.kind === 'sealed-room') {
          verify = { kind: 'sealed-room', min, max }
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, blueprint: { blocks, ...(verify === undefined ? {} : { verify }) } }
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
    version: 1,
    size: [max.x - min.x + 1, max.y - min.y + 1, max.z - min.z + 1],
    materialPolicy: {},
    workItems,
    ...(blueprint.verify === undefined
      ? {}
      : {
          verify: {
            kind: 'sealed-room' as const,
            min: [
              blueprint.verify.min.x - min.x,
              blueprint.verify.min.y - min.y,
              blueprint.verify.min.z - min.z,
            ] as [number, number, number],
            max: [
              blueprint.verify.max.x - min.x,
              blueprint.verify.max.y - min.y,
              blueprint.verify.max.z - min.z,
            ] as [number, number, number],
          },
        }),
  }
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

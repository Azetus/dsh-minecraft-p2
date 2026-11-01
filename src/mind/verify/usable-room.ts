import type { Vec3 } from '../../port/index.ts'
import { isAirName, isSolidBlock, itemPosition } from '../plan.ts'
import type { PlanInstance, VerifySpec } from '../plan.ts'
import { standingAt } from '../../port/terrain.ts'
import type { WorldView } from '../types.ts'
import { absolute } from './sealed-room.ts'
import type { VerifyResult } from './sealed-room.ts'

/**
 * Usability verifier for a room that must remain enterable and usable:
 * - interior cells must be air (a bed is allowed);
 * - the shell must be solid except a door/open entrance;
 * - there must be a standable interior cell;
 * - the door/opening must have standable cells on both sides;
 * - an optional bed must be placed and have a standable cell beside it.
 *
 * This is intentionally geometry-only. Opening a door and sleeping are actions
 * the Agent can order; the verifier only proves those actions are possible.
 */
export function verifyUsableRoom(
  plan: PlanInstance,
  spec: Extract<VerifySpec, { kind: 'usable-room' }>,
  world: WorldView,
): VerifyResult {
  const min = absolute(plan, spec.min)
  const max = absolute(plan, spec.max)
  let unknown: Vec3 | undefined
  const read = (at: Vec3) => {
    const block = world.blockAt(at)
    if (block === null || !block.loaded) unknown ??= at
    return block
  }

  const bed = spec.bed === undefined ? undefined : absolute(plan, spec.bed)
  for (let x = min.x; x <= max.x; x += 1) {
    for (let y = min.y; y <= max.y; y += 1) {
      for (let z = min.z; z <= max.z; z += 1) {
        const at = { x, y, z }
        if (bed !== undefined && same(at, bed)) continue
        const block = read(at)
        if (block === null || !block.loaded) continue
        if (!isAirName(block.name)) {
          return refuted(at, plan, `interior cell contains ${block.name}`)
        }
      }
    }
  }

  const doorLower = spec.door === undefined ? undefined : absolute(plan, spec.door)
  const doorUpper = doorLower === undefined ? undefined : { x: doorLower.x, y: doorLower.y + 1, z: doorLower.z }
  let entrance: Vec3 | undefined
  const openings: Vec3[] = []

  for (let x = min.x - 1; x <= max.x + 1; x += 1) {
    for (let y = min.y - 1; y <= max.y + 1; y += 1) {
      for (let z = min.z - 1; z <= max.z + 1; z += 1) {
        if (inside({ x, y, z }, min, max)) continue
        const at = { x, y, z }
        if (doorLower !== undefined && doorUpper !== undefined && (same(at, doorLower) || same(at, doorUpper))) continue
        const block = read(at)
        if (block === null || !block.loaded) continue
        if (isSolidBlock(block)) continue
        if (isAirName(block.name)) openings.push(at)
        else return refuted(at, plan, `shell cell is ${block.name}`)
      }
    }
  }

  if (doorLower === undefined) {
    entrance = openings.find(cell => hasApproach(plan, world, cell, min, max))
    if (entrance === undefined) {
      return refuted(openings[0] ?? min, plan, 'room has no usable entrance')
    }
  } else {
    const lower = read(doorLower)
    const upper = read(doorUpper!)
    if (lower === null || upper === null || !lower.loaded || !upper.loaded) {
      return { state: 'insufficient', at: doorLower, detail: 'door is not loaded' }
    }
    if (!isDoor(lower.name) || !isDoor(upper.name)) {
      return refuted(doorLower, plan, `door cells are ${lower.name}/${upper.name}`)
    }
    if (!hasApproach(plan, world, doorLower, min, max)) {
      return refuted(doorLower, plan, 'door has no standable cell on one side')
    }
    entrance = doorLower
  }

  let standable: Vec3 | undefined
  for (let x = min.x; x <= max.x; x += 1) {
    for (let y = min.y; y <= max.y; y += 1) {
      for (let z = min.z; z <= max.z; z += 1) {
        const at = { x, y, z }
        if (bed !== undefined && same(at, bed)) continue
        if (standingAt(point => world.blockAt(point), at).state === 'valid') {
          standable ??= at
        }
      }
    }
  }
  if (standable === undefined) return refuted(entrance, plan, 'room has no standable interior cell')

  if (bed !== undefined) {
    const block = read(bed)
    if (block === null || !block.loaded) {
      return { state: 'insufficient', at: bed, detail: 'bed is not loaded' }
    }
    if (!block.name.endsWith('_bed')) {
      return refuted(bed, plan, `bed cell is ${block.name}`)
    }
    if (!hasStandableNeighbour(plan, world, bed, min, max)) {
      return refuted(bed, plan, 'bed has no standable adjacent cell')
    }
  }

  return unknown === undefined
    ? { state: 'confirmed' }
    : { state: 'insufficient', at: unknown, detail: 'part of the room is not loaded' }
}

function hasApproach(
  plan: PlanInstance,
  world: WorldView,
  cell: Vec3,
  min: Vec3,
  max: Vec3,
): boolean {
  return hasStandableNeighbour(plan, world, cell, min, max, true)
    && hasStandableNeighbour(plan, world, cell, min, max, false)
}

function hasStandableNeighbour(
  plan: PlanInstance,
  world: WorldView,
  cell: Vec3,
  min: Vec3,
  max: Vec3,
  insideSide?: boolean,
): boolean {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const at = { x: cell.x + dx, y: cell.y, z: cell.z + dz }
    const isInside = inside(at, min, max)
    if (insideSide !== undefined && isInside !== insideSide) continue
    if (standingAt(point => world.blockAt(point), at).state === 'valid') return true
  }
  return false
}

function inside(at: Vec3, min: Vec3, max: Vec3): boolean {
  return at.x >= min.x && at.x <= max.x
    && at.y >= min.y && at.y <= max.y
    && at.z >= min.z && at.z <= max.z
}

function isDoor(name: string): boolean {
  return name.endsWith('_door')
}

function same(left: Vec3, right: Vec3): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z
}

function refuted(at: Vec3 | undefined, plan: PlanInstance, detail: string): VerifyResult {
  const workItemId = at === undefined ? undefined : workItemAt(plan, at)
  return {
    state: 'refuted',
    ...(at === undefined ? {} : { at }),
    detail,
    ...(workItemId === undefined ? {} : { workItemId }),
  }
}

function workItemAt(plan: PlanInstance, at: Vec3): string | undefined {
  for (const item of plan.workItems) {
    if (item.expected === undefined) continue
    const point = itemPosition(plan, item)
    if (point.x === at.x && point.y === at.y && point.z === at.z) return item.id
  }
  return undefined
}

import type { BlockInfo, Vec3 } from '../../body/api.ts'
import { isAirName, itemCells, itemPosition, matchesExpected } from '../plan.ts'
import type { PlanInstance, VerifySpec, WorkItem } from '../plan.ts'
import { standingAt } from '../standing.ts'
import type { WorldView } from '../types.ts'
import { absolute } from './sealed-room.ts'
import type { VerifyResult } from './sealed-room.ts'

type CellExpectation = { pos: Vec3; expected: { name: string; state?: Record<string, string> } }

/**
 * Usability verifier for a room that must remain enterable and usable:
 * - interior cells must be air (the declared bed cells are allowed);
 * - the shell must be solid except the door/open entrance;
 * - the door must be one two-cell placement with lower/upper halves, a
 *   consistent facing and standable cells on both sides;
 * - the bed must be one two-cell placement with foot/head parts, a consistent
 *   facing, head space and a standable adjacent cell;
 * - there must be a standable interior cell.
 *
 * State is read from the observed block, not inferred from the block name.
 * Missing state is `insufficient`, never a silent pass.
 */
export function verifyUsableRoom(
  plan: PlanInstance,
  spec: Extract<VerifySpec, { kind: 'usable-room' }>,
  world: WorldView,
): VerifyResult {
  const min = absolute(plan, spec.min)
  const max = absolute(plan, spec.max)
  let unknown: Vec3 | undefined
  const read = (at: Vec3): BlockInfo | null => {
    const block = world.blockAt(at)
    if (block === null || !block.loaded) unknown ??= at
    return block
  }

  const door = spec.door === undefined ? undefined : doorCells(plan, absolute(plan, spec.door))
  const bed = spec.bed === undefined ? undefined : bedCells(plan, absolute(plan, spec.bed))
  if (spec.door !== undefined && door === undefined) {
    return refuted(absolute(plan, spec.door), plan, 'door is not declared as a two-cell placement')
  }
  if (spec.bed !== undefined && bed === undefined) {
    return refuted(absolute(plan, spec.bed), plan, 'bed is not declared as a two-cell placement')
  }
  const groupCells = new Set<string>([
    ...(door === undefined ? [] : [key(door.lower.pos), key(door.upper.pos)]),
    ...(bed === undefined ? [] : [key(bed.foot.pos), key(bed.head.pos)]),
  ])
  // The bed head space is verified below with its own message.
  const interiorAirSkip = new Set(groupCells)
  if (bed !== undefined) {
    interiorAirSkip.add(key({ x: bed.head.pos.x, y: bed.head.pos.y + 1, z: bed.head.pos.z }))
  }

  if (bed !== undefined) {
    const foot = read(bed.foot.pos)
    const head = read(bed.head.pos)
    if (foot === null || head === null || !foot.loaded || !head.loaded) {
      return { state: 'insufficient', at: bed.foot.pos, detail: 'bed is not loaded' }
    }
    if (!namesMatch(foot, bed.foot.expected) || !namesMatch(head, bed.head.expected)) {
      return refuted(bed.foot.pos, plan, `bed cells are ${foot.name}/${head.name}`)
    }
    if (bed.foot.expected.state !== undefined && foot.state === undefined
      || bed.head.expected.state !== undefined && head.state === undefined) {
      return { state: 'insufficient', at: bed.foot.pos, detail: 'bed part state is not observed' }
    }
    if (!matchesExpected(foot, bed.foot.expected) || !matchesExpected(head, bed.head.expected)) {
      return refuted(bed.foot.pos, plan, `bed cells are ${foot.name}/${head.name}`)
    }
    const footPart = foot.state?.part
    const headPart = head.state?.part
    if (footPart === undefined || headPart === undefined) {
      return { state: 'insufficient', at: bed.foot.pos, detail: 'bed part state is not observed' }
    }
    if (footPart !== 'foot' || headPart !== 'head') {
      return refuted(bed.foot.pos, plan, `bed parts are ${footPart}/${headPart}`)
    }
    const footFacing = foot.state?.facing
    const headFacing = head.state?.facing
    if (footFacing === undefined || headFacing === undefined) {
      return { state: 'insufficient', at: bed.foot.pos, detail: 'bed facing state is not observed' }
    }
    if (footFacing !== headFacing) {
      return refuted(bed.foot.pos, plan, `bed facing differs: ${footFacing}/${headFacing}`)
    }
    const above = read({ x: bed.head.pos.x, y: bed.head.pos.y + 1, z: bed.head.pos.z })
    if (above === null || !above.loaded) {
      return { state: 'insufficient', at: bed.head.pos, detail: 'bed head space is not loaded' }
    }
    if (isSolid(above)) {
      return refuted(bed.head.pos, plan, `bed head space is blocked by ${above.name}`)
    }
    if (!hasStandableNeighbour(plan, world, bed.foot.pos, min, max, undefined, groupCells)) {
      return refuted(bed.foot.pos, plan, 'bed has no standable adjacent cell')
    }
  }

  for (let x = min.x; x <= max.x; x += 1) {
    for (let y = min.y; y <= max.y; y += 1) {
      for (let z = min.z; z <= max.z; z += 1) {
        const at = { x, y, z }
        if (interiorAirSkip.has(key(at))) continue
        const block = read(at)
        if (block === null || !block.loaded) continue
        if (!isAirName(block.name)) {
          return refuted(at, plan, `interior cell contains ${block.name}`)
        }
      }
    }
  }

  const openings: Vec3[] = []
  for (let x = min.x - 1; x <= max.x + 1; x += 1) {
    for (let y = min.y - 1; y <= max.y + 1; y += 1) {
      for (let z = min.z - 1; z <= max.z + 1; z += 1) {
        if (inside({ x, y, z }, min, max)) continue
        const at = { x, y, z }
        if (groupCells.has(key(at))) continue
        const block = read(at)
        if (block === null || !block.loaded) continue
        if (isSolid(block)) continue
        if (isAirName(block.name)) openings.push(at)
        else return refuted(at, plan, `shell cell is ${block.name}`)
      }
    }
  }

  if (door === undefined) {
    const entrance = openings.find(cell => hasApproach(plan, world, cell, min, max))
    if (entrance === undefined) return refuted(openings[0] ?? min, plan, 'room has no usable entrance')
  } else {
    const lower = read(door.lower.pos)
    const upper = read(door.upper.pos)
    if (lower === null || upper === null || !lower.loaded || !upper.loaded) {
      return { state: 'insufficient', at: door.lower.pos, detail: 'door is not loaded' }
    }
    if (!matchesExpected(lower, door.lower.expected) || !matchesExpected(upper, door.upper.expected)) {
      return refuted(door.lower.pos, plan, `door cells are ${lower.name}/${upper.name}`)
    }
    const lowerHalf = lower.state?.half
    const upperHalf = upper.state?.half
    if (lowerHalf === undefined || upperHalf === undefined) {
      return { state: 'insufficient', at: door.lower.pos, detail: 'door half state is not observed' }
    }
    if (lowerHalf !== 'lower' || upperHalf !== 'upper') {
      return refuted(door.lower.pos, plan, `door halves are ${lowerHalf}/${upperHalf}`)
    }
    const lowerFacing = lower.state?.facing
    const upperFacing = upper.state?.facing
    if (lowerFacing === undefined || upperFacing === undefined) {
      return { state: 'insufficient', at: door.lower.pos, detail: 'door facing state is not observed' }
    }
    if (lowerFacing !== upperFacing) {
      return refuted(door.lower.pos, plan, `door facing differs: ${lowerFacing}/${upperFacing}`)
    }
    if (!hasApproach(plan, world, door.lower.pos, min, max)) {
      return refuted(door.lower.pos, plan, 'door has no standable cell on one side')
    }
  }

  let standable: Vec3 | undefined
  for (let x = min.x; x <= max.x; x += 1) {
    for (let y = min.y; y <= max.y; y += 1) {
      for (let z = min.z; z <= max.z; z += 1) {
        const at = { x, y, z }
        if (groupCells.has(key(at))) continue
        if (standingAt(point => world.blockAt(point), at).state === 'valid') standable ??= at
      }
    }
  }
  if (standable === undefined) return refuted(door?.lower.pos ?? min, plan, 'room has no standable interior cell')

  return unknown === undefined
    ? { state: 'confirmed' }
    : { state: 'insufficient', at: unknown, detail: 'part of the room is not loaded' }
}

/** Cells of the door placement, from the plan's group when it has one. */
function doorCells(plan: PlanInstance, at: Vec3): { lower: CellExpectation; upper: CellExpectation } | undefined {
  const group = groupAt(plan, at)
  if (group === undefined) return undefined
  const lower = group.find(cell => same(cell.pos, at))
  const upper = group.find(cell => cell.pos.x === at.x && cell.pos.z === at.z && cell.pos.y === at.y + 1)
  if (lower === undefined || upper === undefined) return undefined
  return { lower, upper }
}

/** Cells of the bed placement; the verifier's `bed` anchor is the foot. */
function bedCells(plan: PlanInstance, at: Vec3): { foot: CellExpectation; head: CellExpectation } | undefined {
  const group = groupAt(plan, at)
  if (group === undefined || group.length < 2) return undefined
  const foot = group.find(cell => same(cell.pos, at))
    ?? group.find(cell => cell.expected.state?.part === 'foot')
  const head = group.find(cell => cell !== foot && cell.expected.state?.part === 'head')
    ?? group.find(cell => cell !== foot)
  if (foot === undefined || head === undefined) return undefined
  return { foot, head }
}

function groupAt(plan: PlanInstance, at: Vec3): CellExpectation[] | undefined {
  for (const item of plan.workItems) {
    if (item.cells === undefined) continue
    const cells = itemCells(plan, item)
    if (!cells.some(cell => same(cell.pos, at))) continue
    return cells
  }
  return undefined
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
  excluded?: Set<string>,
): boolean {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const at = { x: cell.x + dx, y: cell.y, z: cell.z + dz }
    if (excluded?.has(key(at)) === true) continue
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

function isSolid(block: BlockInfo): boolean {
  return !isAirName(block.name) && block.name !== 'water' && block.name !== 'lava'
}

function same(left: Vec3, right: Vec3): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z
}

function namesMatch(block: BlockInfo, expected: { name: string }): boolean {
  return block.name.replace(/^minecraft:/u, '') === expected.name.replace(/^minecraft:/u, '')
}

function key(at: Vec3): string {
  return `${at.x},${at.y},${at.z}`
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
    for (const cell of item.cells ?? []) {
      if (plan.origin.x + cell.at[0] === at.x
        && plan.origin.y + cell.at[1] === at.y
        && plan.origin.z + cell.at[2] === at.z) return item.id
    }
  }
  return undefined
}

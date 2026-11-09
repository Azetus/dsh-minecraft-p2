import type { Vec3 } from '../body/api.ts'
import { itemPosition } from './plan.ts'
import type { PlanInstance, WorkItem } from './plan.ts'
import type { WorldView } from './types.ts'

export type BuildAccess = {
  /** Work items that form the temporary two-high entrance and must be last. */
  deferred: Set<string>
  entrance?: {
    inside: Vec3
    outside: Vec3
    feet: Vec3
    head: Vec3
  }
  blocked?: {
    reason: 'NO_ENTRANCE_COLUMN'
    detail: string
  }
}

/**
 * A blueprint origin is the geometry min corner, not necessarily the interior
 * min corner. Verifier bounds are relative to that origin.
 */
export function interiorBounds(plan: PlanInstance): { min: Vec3; max: Vec3 } {
  if (plan.verify !== undefined) {
    return {
      min: {
        x: plan.origin.x + plan.verify.min[0],
        y: plan.origin.y + plan.verify.min[1],
        z: plan.origin.z + plan.verify.min[2],
      },
      max: {
        x: plan.origin.x + plan.verify.max[0],
        y: plan.origin.y + plan.verify.max[1],
        z: plan.origin.z + plan.verify.max[2],
      },
    }
  }
  return {
    min: { ...plan.origin },
    max: {
      x: plan.origin.x + plan.size[0] - 1,
      y: plan.origin.y + plan.size[1] - 1,
      z: plan.origin.z + plan.size[2] - 1,
    },
  }
}

/**
 * Derive a temporary entrance from the plan's interior volume and work items.
 * This is deliberately block-type agnostic: any two-high shell column adjacent
 * to the interior can be left open, then filled last from inside. It never
 * assumes a door block, a material, or a particular face name.
 */
export function planBuildAccess(plan: PlanInstance, world: WorldView, self: Vec3): BuildAccess {
  if (plan.verify === undefined) return { deferred: new Set() }
  const interior = interiorBounds(plan)
  const origin = interior.min
  const maxX = interior.max.x
  const maxY = interior.max.y
  const maxZ = interior.max.z
  if (maxY < origin.y + 1) {
    return {
      deferred: new Set(),
      blocked: { reason: 'NO_ENTRANCE_COLUMN', detail: 'interior is too low for a two-cell entrance' },
    }
  }

  const byPosition = new Map<string, WorkItem>()
  for (const item of plan.workItems) {
    const at = itemPosition(plan, item)
    byPosition.set(key(at), item)
  }

  const candidates: Array<{
    x: number
    z: number
    feet: Vec3
    head: Vec3
    inside: Vec3
    outside: Vec3
    ids: string[]
    distance: number
  }> = []
  let openColumn: { feet: Vec3; head: Vec3; inside: Vec3; outside: Vec3 } | undefined

  for (let x = origin.x - 1; x <= maxX + 1; x += 1) {
    for (let z = origin.z - 1; z <= maxZ + 1; z += 1) {
      const feet = { x, y: origin.y, z }
      const head = { x, y: origin.y + 1, z }
      if (inside(origin, maxX, maxY, maxZ, feet) || inside(origin, maxX, maxY, maxZ, head)) continue
      const side = adjacentInside(origin, feet, maxX, maxZ)
      if (side === undefined) continue
      const workItems = [byPosition.get(key(feet)), byPosition.get(key(head))]
        .filter((item): item is WorkItem => item !== undefined)
      if (workItems.length === 0) {
        openColumn ??= { feet, head, inside: side.inside, outside: side.outside }
        continue
      }
      candidates.push({
        x,
        z,
        feet,
        head,
        inside: side.inside,
        outside: side.outside,
        ids: workItems.map(item => item.id),
        distance: Math.hypot(x + 0.5 - self.x, z + 0.5 - self.z),
      })
    }
  }

  candidates.sort((left, right) => left.distance - right.distance)
  if (openColumn !== undefined) {
    return { deferred: new Set(), entrance: openColumn }
  }
  const chosen = candidates[0]
  if (chosen === undefined) {
    const cell = world.blockAt({ x: origin.x, y: origin.y, z: origin.z })
    if (cell === null || !cell.loaded) {
      return { deferred: new Set(), blocked: { reason: 'NO_ENTRANCE_COLUMN', detail: 'no loaded interior cell' } }
    }
    return {
      deferred: new Set(),
      blocked: { reason: 'NO_ENTRANCE_COLUMN', detail: 'no work-item shell column adjacent to the interior' },
    }
  }
  return {
    deferred: new Set(chosen.ids),
    entrance: {
      feet: chosen.feet,
      head: chosen.head,
      inside: chosen.inside,
      outside: chosen.outside,
    },
  }
}

function adjacentInside(
  origin: Vec3,
  cell: Vec3,
  maxX: number,
  maxZ: number,
): { inside: Vec3; outside: Vec3 } | undefined {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const insideCell = { x: cell.x + dx, y: cell.y, z: cell.z + dz }
    const outsideCell = { x: cell.x - dx, y: cell.y, z: cell.z - dz }
    if (!rectInside(insideCell, origin, maxX, maxZ)) continue
    if (rectInside(outsideCell, origin, maxX, maxZ)) continue
    return { inside: insideCell, outside: outsideCell }
  }
  return undefined
}

function rectInside(cell: Vec3, origin: Vec3, maxX: number, maxZ: number): boolean {
  return cell.x >= origin.x && cell.x <= maxX && cell.z >= origin.z && cell.z <= maxZ
}

function inside(min: Vec3, maxX: number, maxY: number, maxZ: number, cell: Vec3): boolean {
  return cell.x >= min.x && cell.x <= maxX
    && cell.y >= min.y && cell.y <= maxY
    && cell.z >= min.z && cell.z <= maxZ
}

function key(at: Vec3): string {
  return `${at.x},${at.y},${at.z}`
}

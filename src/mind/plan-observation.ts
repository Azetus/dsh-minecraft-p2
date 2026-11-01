import type { Box, Vec3 } from '../port/index.ts'
import { interiorBounds } from './build-access.ts'
import { itemPosition } from './plan.ts'
import type { PlanInstance, WorkItem } from './plan.ts'

/** Bounded P2-internal observation budget; these boxes never reach the Agent. */
export const MAX_OBSERVATION_CELLS = 8_192
export const MAX_OBSERVATION_BOXES = 8

/** Radius that covers the stance search around one work cell (x/z ±5, y ±1). */
const STANCE_RADIUS = 5
const STANCE_VERTICAL = 1

export function itemObservationBox(plan: PlanInstance, item: WorkItem): Box {
  const at = itemPosition(plan, item)
  return expand(
    { min: at, max: at },
    STANCE_RADIUS + 2,
    STANCE_VERTICAL + 2,
  )
}

export function pointObservationBox(at: Vec3, radius = 1): Box {
  return expand({ min: at, max: at }, radius, radius)
}

/**
 * Observation for the stage currently being built: the union of the stage
 * cells expanded to the stance ring. When the union is too large it degrades to
 * a bounded set of per-item boxes; the giver re-reads any remaining unknown
 * item with `itemObservationBox` before deciding.
 */
export function stageObservationBoxes(plan: PlanInstance, items: WorkItem[]): Box[] {
  if (items.length === 0) return []
  const union = expand(unionOf(items.map(item => itemPosition(plan, item))), STANCE_RADIUS, STANCE_VERTICAL)
  if (volume(union) <= MAX_OBSERVATION_CELLS) return [union]
  return items
    .slice(0, MAX_OBSERVATION_BOXES)
    .map(item => itemObservationBox(plan, item))
}

/**
 * Everything the plan needs to keep observed while it is active: the build
 * envelope, the temporary entrance/apron, the interior and the verifier
 * anchors. Measurements stay internal; the model context only sees events.
 */
export function planObservationBoxes(plan: PlanInstance, items: WorkItem[]): Box[] {
  const boxes: Box[] = []
  const envelope = planEnvelope(plan)
  if (volume(envelope) <= MAX_OBSERVATION_CELLS) boxes.push(envelope)
  boxes.push(...stageObservationBoxes(plan, items))
  const interior = interiorBounds(plan)
  boxes.push(expand(interior, 2, 1))
  return dedupe(boxes).slice(0, MAX_OBSERVATION_BOXES)
}

/** Final verification needs the shell, the interior and the door/bed cells. */
export function verifyObservationBoxes(plan: PlanInstance): Box[] {
  const boxes: Box[] = [expand(interiorBounds(plan), 2, 1)]
  const envelope = planEnvelope(plan)
  if (volume(envelope) <= MAX_OBSERVATION_CELLS) boxes.push(envelope)
  if (plan.verify?.kind === 'usable-room') {
    for (const at of [plan.verify.door, plan.verify.bed]) {
      if (at === undefined) continue
      boxes.push(pointObservationBox(
        { x: plan.origin.x + at[0], y: plan.origin.y + at[1], z: plan.origin.z + at[2] },
        2,
      ))
    }
  }
  return dedupe(boxes).slice(0, MAX_OBSERVATION_BOXES)
}

export function planEnvelope(plan: PlanInstance): Box {
  const min = { ...plan.origin }
  const max = {
    x: plan.origin.x + plan.size[0] - 1,
    y: plan.origin.y + plan.size[1] - 1,
    z: plan.origin.z + plan.size[2] - 1,
  }
  for (const item of plan.workItems) {
    const at = itemPosition(plan, item)
    min.x = Math.min(min.x, at.x)
    min.y = Math.min(min.y, at.y)
    min.z = Math.min(min.z, at.z)
    max.x = Math.max(max.x, at.x)
    max.y = Math.max(max.y, at.y)
    max.z = Math.max(max.z, at.z)
  }
  return { min, max }
}

function unionOf(points: Vec3[]): Box {
  const first = points[0]!
  const min = { ...first }
  const max = { ...first }
  for (const point of points) {
    min.x = Math.min(min.x, point.x)
    min.y = Math.min(min.y, point.y)
    min.z = Math.min(min.z, point.z)
    max.x = Math.max(max.x, point.x)
    max.y = Math.max(max.y, point.y)
    max.z = Math.max(max.z, point.z)
  }
  return { min, max }
}

function expand(box: Box, radius: number, vertical: number): Box {
  return {
    min: { x: box.min.x - radius, y: box.min.y - vertical, z: box.min.z - radius },
    max: { x: box.max.x + radius, y: box.max.y + vertical, z: box.max.z + radius },
  }
}

function volume(box: Box): number {
  return (box.max.x - box.min.x + 1) * (box.max.y - box.min.y + 1) * (box.max.z - box.min.z + 1)
}

function dedupe(boxes: Box[]): Box[] {
  const seen = new Set<string>()
  const result: Box[] = []
  for (const box of boxes) {
    const key = `${box.min.x},${box.min.y},${box.min.z}:${box.max.x},${box.max.y},${box.max.z}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(box)
  }
  return result
}

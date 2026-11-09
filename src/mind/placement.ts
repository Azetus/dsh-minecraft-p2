import type { Vec3 } from '../body/api.ts'
import { reachableCells as coreReachableCells } from '../motion/search/index.ts'
import { interiorBounds } from './build-access.ts'
import { itemCells } from './plan.ts'
import type { BlockReason, PlanInstance, WorkItem } from './plan.ts'
import { isSolidBlock } from './plan.ts'
import { createReadOnlyMotionWorld, isStandable } from './standing.ts'
import type { WorldView } from './types.ts'

export type ItemBlockReason =
  | BlockReason
  | 'NO_PLACE_STANCE'
  | 'UNKNOWN'
  | 'INSUFFICIENT_OBSERVATION'
  | 'NO_PATH'
  | 'PLACE_FAILED'

/** Bounded placement attempts: three stances, two no-progress tries each. */
export const MAX_ITEM_STANCES = 3
export const MAX_STANCE_TRIES = 2
export const MAX_STANCE_CANDIDATES = 12

const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const

export type StanceChoice = {
  stance: Vec3
  distance: number
}

export type StanceRejection = {
  stance: Vec3
  reason: string
  code?: string
}

export type ItemLedger = {
  itemId: string
  stage: number
  target: Vec3
  /** Stance key → attempts that produced no world change. */
  attempts: Map<string, number>
  failed: Set<string>
  lastCode?: string
  blocked?: {
    reason: ItemBlockReason
    detail: string
    triedStances: StanceRejection[]
  }
  unknownReads: number
  fingerprint: string
}

/**
 * Per-plan work-item ledger. It is the single place that decides whether an
 * item is blocked, so a stance that failed for one cell can never poison the
 * candidate pool of another cell (the old global `failedStances` set did).
 */
export class PlanItemLedger {
  private readonly plans = new WeakMap<PlanInstance, Map<string, ItemLedger>>()

  entry(plan: PlanInstance, item: WorkItem, stage: number, target: Vec3, world: WorldView): ItemLedger {
    let entries = this.plans.get(plan)
    if (entries === undefined) {
      entries = new Map()
      this.plans.set(plan, entries)
    }
    let entry = entries.get(item.id)
    if (entry === undefined) {
      entry = {
        itemId: item.id,
        stage,
        target,
        attempts: new Map(),
        failed: new Set(),
        unknownReads: 0,
        fingerprint: fingerprint(plan, item, world),
      }
      entries.set(item.id, entry)
      return entry
    }
    // Furniture/wall changes make a previously unusable stance legal again.
    // Only re-evaluate when the world around this item actually changed.
    const current = fingerprint(plan, item, world)
    if (current !== entry.fingerprint) {
      entry.fingerprint = current
      delete entry.blocked
      entry.attempts.clear()
      entry.failed.clear()
      entry.unknownReads = 0
    }
    entry.stage = stage
    entry.target = target
    return entry
  }

  /** Record a real job outcome for `(item, stance)`; `ok` means world-proven. */
  record(
    plan: PlanInstance,
    item: WorkItem,
    stance: Vec3,
    result: { ok: boolean; code?: string },
    world: WorldView,
  ): void {
    const entries = this.plans.get(plan)
    const entry = entries?.get(item.id)
    if (entry === undefined) return
    if (result.ok) {
      entry.attempts.clear()
      entry.failed.clear()
      delete entry.blocked
      delete entry.lastCode
      return
    }
    const key = cellKey(stance)
    const changed = fingerprint(plan, item, world) !== entry.fingerprint
    const tries = (changed ? 1 : (entry.attempts.get(key) ?? 0) + 1)
    entry.attempts.set(key, tries)
    entry.fingerprint = fingerprint(plan, item, world)
    if (result.code !== undefined) entry.lastCode = result.code
    if (tries >= MAX_STANCE_TRIES) entry.failed.add(key)
    if (entry.failed.size >= MAX_ITEM_STANCES) {
      entry.blocked = {
        reason: 'NO_PLACE_STANCE',
        detail: `every placement stance failed (${entry.failed.size}/${MAX_ITEM_STANCES})`,
        triedStances: this.rejections(entry),
      }
    }
  }

  block(
    plan: PlanInstance,
    item: WorkItem,
    reason: ItemBlockReason,
    detail: string,
    tried: StanceRejection[] = [],
  ): void {
    const entries = this.plans.get(plan)
    const entry = entries?.get(item.id)
    if (entry === undefined) return
    entry.blocked = { reason, detail, triedStances: tried }
  }

  blocked(plan: PlanInstance, item: WorkItem): ItemLedger['blocked'] {
    return this.plans.get(plan)?.get(item.id)?.blocked
  }

  lastCode(plan: PlanInstance, item: WorkItem): string | undefined {
    return this.plans.get(plan)?.get(item.id)?.lastCode
  }

  /** Total no-progress attempts recorded for one work item. */
  tries(plan: PlanInstance, item: WorkItem): number {
    const entry = this.plans.get(plan)?.get(item.id)
    if (entry === undefined) return 0
    let total = 0
    for (const count of entry.attempts.values()) total += count
    return total
  }

  entries(plan: PlanInstance): ItemLedger[] {
    return [...(this.plans.get(plan)?.values() ?? [])]
  }

  failedStances(plan: PlanInstance, item: WorkItem): Set<string> {
    return new Set(this.plans.get(plan)?.get(item.id)?.failed ?? [])
  }

  noteUnknown(plan: PlanInstance, item: WorkItem): number {
    const entries = this.plans.get(plan)
    const entry = entries?.get(item.id)
    if (entry === undefined) return 0
    entry.unknownReads += 1
    return entry.unknownReads
  }

  rejections(entry: ItemLedger): StanceRejection[] {
    const result: StanceRejection[] = []
    for (const [key, tries] of entry.attempts) {
      const [x, y, z] = key.split(',').map(Number)
      result.push({
        stance: { x: x ?? 0, y: y ?? 0, z: z ?? 0 },
        reason: `no world change after ${tries} attempt(s)`,
        ...(entry.lastCode === undefined ? {} : { code: entry.lastCode }),
      })
    }
    return result
  }
}

/**
 * Full placement-stance scan around one work item. A future target that is
 * still air is a legal temporary stand; a target that is already solid is not
 * (the body cannot occupy it). Stage decides preference, not admission, so a
 * missing preferred side does not silently empty the pool.
 */
export function placementStances(
  plan: PlanInstance,
  world: WorldView,
  item: WorkItem,
  stage: number,
): StanceChoice[] {
  const targets = itemCells(plan, item)
  if (targets.length === 0) return []
  const anchor = targets[0]!.pos
  const interior = interiorBounds(plan)
  const excluded = new Set(targets.map(cell => cellKey(cell.pos)))
  const reachable = coreReachableCells(
    createReadOnlyMotionWorld(point => world.blockAt(point)),
    world.self.pos,
  )
  const choices: StanceChoice[] = []
  for (let dx = -5; dx <= 5; dx += 1) {
    for (let dz = -5; dz <= 5; dz += 1) {
      // A placement can be made up to ~4.5 blocks from the eye, so a stand may
      // be up to five cells below the target (the interior floor when placing
      // an upper wall or roof). A ±2 window only found wall-top stances, which
      // are unreachable without scaffolding.
      for (let dy = -5; dy <= 5; dy += 1) {
        const stance = { x: anchor.x + dx, y: anchor.y + dy, z: anchor.z + dz }
        const key = cellKey(stance)
        if (excluded.has(key)) continue
        if (!isStandableCached(world, stance)) continue
        if (overlapsBody(stance, targets.map(cell => cell.pos))) continue
        const inside = plan.verify !== undefined && insideBox(stance, interior.min, interior.max)
        // Before the entrance exists the body cannot legitimately stand
        // inside a verified room; afterwards both sides are allowed and the
        // interior is preferred for roof/furniture work.
        if (stage <= 2 && inside) continue
        if (!canPlaceFrom(world, targets.map(cell => cell.pos), stance)) continue
        const distance = Math.hypot(stance.x - anchor.x, stance.y - anchor.y, stance.z - anchor.z)
        choices.push({ stance, distance: distance + (stage >= 3 && !inside ? 2 : 0) + (reachable.has(key) ? 0 : 4) })
      }
    }
  }
  return choices
    .sort((left, right) => left.distance - right.distance)
    .slice(0, MAX_STANCE_CANDIDATES)
}

/** Cells to try when the body stands on its own target and must move away. */
export function stepAsideStances(
  plan: PlanInstance,
  world: WorldView,
  item: WorkItem,
  stage: number,
): StanceChoice[] {
  const feet = {
    x: Math.floor(world.self.pos.x),
    y: Math.floor(world.self.pos.y),
    z: Math.floor(world.self.pos.z),
  }
  const planned = new Set<string>()
  for (const candidate of plan.workItems) {
    planned.add(cellKey(candidatePosition(plan, candidate)))
    for (const cell of itemCells(plan, candidate)) planned.add(cellKey(cell.pos))
  }
  const choices = placementStances(plan, world, item, stage)
    .filter(choice => cellKey(choice.stance) !== cellKey(feet))
  // Stepping onto another pending target only moves the same problem to the
  // next work item and ping-pongs the body between two floor cells.
  const clear = choices.filter(choice => !planned.has(cellKey(choice.stance)))
  const pool = clear.length > 0 ? clear : choices
  return pool.sort((left, right) => Math.hypot(left.stance.x - feet.x, left.stance.z - feet.z)
    - Math.hypot(right.stance.x - feet.x, right.stance.z - feet.z))
}

function candidatePosition(plan: PlanInstance, item: WorkItem): Vec3 {
  return itemCells(plan, item)[0]?.pos ?? { x: 0, y: 0, z: 0 }
}

/**
 * A stance must have a clear placement line to an exposed support face.
 * `overlapsBody` separately rejects a stance whose own body would occupy the
 * target (including the upper cell of a door or the head of a bed).
 */
export function canPlaceFrom(world: WorldView, targets: Vec3[], stand: Vec3): boolean {
  const eye = { x: stand.x + 0.5, y: stand.y + 1.5, z: stand.z + 0.5 }
  const allowed = new Set([cellKey(stand), ...targets.map(cellKey)])
  for (const target of targets) {
    const center = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }
    for (const [dx, dy, dz] of FACES) {
      const reference = { x: target.x + dx, y: target.y + dy, z: target.z + dz }
      if (!isSolidBlock(world.blockAt(reference))) continue
      allowed.add(cellKey(reference))
      const point = {
        x: center.x + dx * 0.5,
        y: center.y + dy * 0.5,
        z: center.z + dz * 0.5,
      }
      if (Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z) > 4.5) continue
      if (lineClear(world, eye, point, allowed)) return true
    }
  }
  return false
}

function overlapsBody(stand: Vec3, targets: Vec3[]): boolean {
  return targets.some(target => target.x === stand.x && target.z === stand.z
    && (target.y === stand.y || target.y === stand.y + 1))
}

function lineClear(world: WorldView, from: Vec3, to: Vec3, allowed: Set<string>): boolean {
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  const steps = Math.ceil(distance / 0.1)
  for (let step = 1; step < steps; step += 1) {
    const t = step / steps
    const at = {
      x: Math.floor(from.x + (to.x - from.x) * t),
      y: Math.floor(from.y + (to.y - from.y) * t),
      z: Math.floor(from.z + (to.z - from.z) * t),
    }
    if (allowed.has(cellKey(at))) continue
    const block = world.blockAt(at)
    if (block === null || !block.loaded) return false
    if (isSolidBlock(block)) return false
  }
  return true
}

/** Bounded walkability preference; never a hard filter (doors/jumps are unknown here). */
function fingerprint(plan: PlanInstance, item: WorkItem, world: WorldView): string {
  const cells = itemCells(plan, item)
  const parts: string[] = []
  for (const cell of cells) {
    for (const offset of [[0, 0, 0], ...FACES] as const) {
      const at = { x: cell.pos.x + offset[0], y: cell.pos.y + offset[1], z: cell.pos.z + offset[2] }
      const block = world.blockAt(at)
      parts.push(`${at.x},${at.y},${at.z}=${block === null ? 'null' : block.loaded ? block.name : 'unloaded'}`)
    }
  }
  return parts.join(';')
}

function insideBox(at: Vec3, min: Vec3, max: Vec3): boolean {
  return at.x >= min.x && at.x <= max.x
    && at.y >= min.y && at.y <= max.y
    && at.z >= min.z && at.z <= max.z
}

const standableCache = new WeakMap<WorldView, Map<string, boolean>>()

/** One snapshots is immutable, so standability can be cached per evaluation. */
function isStandableCached(world: WorldView, at: Vec3): boolean {
  let cache = standableCache.get(world)
  if (cache === undefined) {
    cache = new Map()
    standableCache.set(world, cache)
  }
  const key = cellKey(at)
  const known = cache.get(key)
  if (known !== undefined) return known
  const value = isStandable(world, at)
  cache.set(key, value)
  return value
}

function cellKey(at: Vec3): string {
  return `${at.x},${at.y},${at.z}`
}

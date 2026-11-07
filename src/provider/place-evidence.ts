/**
 * Placement evidence helpers shared by the mineflayer provider. They are pure
 * so the off-target/inventory logic can be tested without a live bot.
 *
 * `bot.placeBlock` only reports whether the requested reference face produced a
 * block update at the destination. It cannot tell us whether the server placed
 * the item in a different cell or consumed it. These helpers compare a bounded
 * neighbourhood before/after and the item count to answer that question.
 */

export type PlacePoint = { x: number; y: number; z: number }

/** Minimal block view exposed by mineflayer's `blockAt`. */
export type PlaceBlockView = {
  name: string
  boundingBox?: string
  shapes?: readonly unknown[]
} | null

export type PlaceSnapshot = Map<string, string>

export type PlaceChange = PlacePoint & { name: string }

export type PlaceDiff = {
  /** Cells that changed to the requested item. */
  placedCells: PlacePoint[]
  /** Every changed cell, including a different block or removal. */
  changedCells: PlaceChange[]
}

export function placeKey(point: PlacePoint): string {
  return `${point.x},${point.y},${point.z}`
}

export function samePlacePoint(left: PlacePoint, right: PlacePoint): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z
}

/** A block that can carry a placement: loaded, non-fluid and with collision. */
export function isPlaceSupport(block: PlaceBlockView): boolean {
  if (block === null) return false
  if (isAirName(block.name) || isFluidName(block.name)) return false
  if (block.boundingBox === 'empty') return false
  if (block.shapes !== undefined && block.shapes.length === 0) return false
  return true
}

/** A target cell that already contains a colliding block cannot be placed into. */
export function isTargetOccupied(block: PlaceBlockView): boolean {
  return isPlaceSupport(block)
}

export function snapshotPlaceNeighborhood(
  blockAt: (point: PlacePoint) => PlaceBlockView,
  center: PlacePoint,
  radius = 1,
): PlaceSnapshot {
  const snapshot: PlaceSnapshot = new Map()
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const at = { x: center.x + dx, y: center.y + dy, z: center.z + dz }
        let block: PlaceBlockView
        try {
          block = blockAt(at)
        } catch {
          continue
        }
        if (block === null) continue
        snapshot.set(placeKey(at), block.name)
      }
    }
  }
  return snapshot
}

export function diffPlacement(
  before: PlaceSnapshot,
  after: PlaceSnapshot,
  item: string,
): PlaceDiff {
  const wanted = normalizeItem(item)
  const placedCells: PlacePoint[] = []
  const changedCells: PlaceChange[] = []
  for (const [key, name] of after) {
    if (before.get(key) === name) continue
    const point = parseKey(key)
    changedCells.push({ ...point, name })
    if (normalizeItem(name) === wanted) placedCells.push(point)
  }
  return { placedCells, changedCells }
}

export function countItem(
  items: readonly { name: string; count: number }[],
  item: string,
): number {
  const wanted = normalizeItem(item)
  return items.reduce((total, stack) => normalizeItem(stack.name) === wanted
    ? total + stack.count
    : total, 0)
}

/** `null` means the inventory model was inconclusive (e.g. it grew mid-read). */
export function itemConsumed(before: number, after: number): boolean | null {
  if (after < before) return true
  if (after === before) return false
  return null
}

/**
 * Only a server refusal with no item/block change is safe to retry with another
 * face. Timeouts and unknown failures are not.
 */
export function isRefusalMessage(message: string): boolean {
  return /Server refused to place/iu.test(message) || /the block is still/iu.test(message)
}

export function retrySafe(input: {
  message: string
  consumed: boolean | null
  placedCells: readonly unknown[]
}): boolean {
  return input.placedCells.length === 0
    && input.consumed === false
    && isRefusalMessage(input.message)
}

function normalizeItem(name: string): string {
  return name.replace(/^minecraft:/u, '')
}

function parseKey(key: string): PlacePoint {
  const [x, y, z] = key.split(',').map(Number)
  return { x: x ?? 0, y: y ?? 0, z: z ?? 0 }
}

function isAirName(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

function isFluidName(name: string): boolean {
  return name === 'water' || name === 'flowing_water' || name === 'lava' || name === 'flowing_lava'
}

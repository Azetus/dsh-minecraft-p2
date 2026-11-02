import { bodyOverlap, cellKey, hasTag, offset, supportTopAt } from '../model/block.ts'
import { vanillaClassifier } from '../model/semantics/vanilla.ts'
import type {
  BlockClassifier,
  Cell,
  ClassifiedBlock,
  MotionWorld,
} from '../model/types.ts'

/**
 * The node buckets a vanilla-ish pathfinder distinguishes. This is deliberately
 * smaller than vanilla's `PathType`: hazards/lava/fences/walls/deep water all
 * collapse into "not a node", and the dangerous-block policy stays in the
 * existing `BlockClassifier` tags (no new table here).
 */
export type VanillaNodeKind = 'walkable' | 'water' | 'climbable' | 'door'

export type VanillaNode = {
  cell: Cell
  kind: VanillaNodeKind
}

/**
 * Snapshot-consistent block reader with a vanilla-style node classification.
 * It is intentionally *not* `RuleSet`: no constraints, no break policy, no
 * body-height knobs beyond the player's 1.8. `undefined` means "not a node"
 * (blocked or unloaded); the search treats both as unusable.
 */
export class VanillaNodeReader {
  private readonly cache = new Map<string, ClassifiedBlock | null>()
  private readonly classifier: BlockClassifier

  constructor(
    private readonly world: MotionWorld,
    classifier?: BlockClassifier,
  ) {
    this.classifier = classifier ?? vanillaClassifier
  }

  invalidate(): void {
    this.cache.clear()
  }

  block(cell: Cell): ClassifiedBlock | null {
    const at = { x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z) }
    const key = cellKey(at)
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    const raw = this.world.blockAt(at)
    const value = raw === null || !raw.loaded
      ? null
      : { ...raw, tags: this.classifier.classify(raw) }
    this.cache.set(key, value)
    return value
  }

  /** Air-like: loaded, no collision, not a fluid. Used by goal snapping. */
  isAir(cell: Cell): boolean {
    const block = this.block(cell)
    if (block === null) return false
    if (hasTag(block, 'water') || hasTag(block, 'lava')) return false
    return block.collision !== undefined && block.collision.length === 0
  }

  /** Solid-enough to stand on: any collision shape. Used by goal snapping. */
  isSolid(cell: Cell): boolean {
    const block = this.block(cell)
    if (block === null) return false
    return block.collision !== undefined && block.collision.length > 0
  }

  /** Can the body pass through this cell (used for falls, corners, jump headroom)? */
  passable(cell: Cell): boolean {
    const block = this.block(cell)
    if (block === null) return false
    if (hasTag(block, 'hazard') || hasTag(block, 'lava')) return false
    if (hasTag(block, 'water')) return true
    if (block.collision === undefined) return false
    if (block.collision.length === 0) return true
    return bodyOverlap(block, cell, cell.y) === false
  }

  node(cell: Cell): VanillaNode | undefined {
    const block = this.block(cell)
    if (block === null) return undefined
    if (hasTag(block, 'hazard') || hasTag(block, 'lava')) return undefined

    // Doors: an open door is passable regardless of its collision shape (the
    // state is authoritative); a closed one is only a node when it can be
    // opened, so the follower knows to click it.
    if (hasTag(block, 'door') || hasTag(block, 'gate')) {
      if (block.state.open === 'true') return { cell, kind: 'walkable' }
      return hasTag(block, 'openable') ? { cell, kind: 'door' } : undefined
    }

    const headCell = offset(cell, 0, 1, 0)
    const head = this.block(headCell)
    if (head === null) return undefined
    if (hasTag(head, 'hazard') || hasTag(head, 'lava')) return undefined
    if (bodyOverlap(head, headCell, cell.y) !== false) return undefined

    // Water: only the surface cell is a node (deep water = no diving).
    if (hasTag(block, 'water')) {
      return hasTag(head, 'water') ? undefined : { cell, kind: 'water' }
    }

    // Ladders/vines are nodes even without support; the follower climbs them.
    if (hasTag(block, 'climbable')) {
      if (bodyOverlap(block, cell, cell.y) !== false) return undefined
      return { cell, kind: 'climbable' }
    }

    if (bodyOverlap(block, cell, cell.y) !== false) return undefined
    const supportCell = offset(cell, 0, -1, 0)
    const support = this.block(supportCell)
    if (support === null) return undefined
    if (hasTag(support, 'water') || hasTag(support, 'lava') || hasTag(support, 'hazard')) return undefined
    const top = supportTopAt(support)
    if (top === undefined || top <= 0 || top > 1) return undefined
    return { cell, kind: 'walkable' }
  }
}

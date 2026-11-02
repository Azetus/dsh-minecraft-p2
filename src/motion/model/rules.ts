import {
  bodyOverlap,
  cellKey,
  hasTag,
  isPlaceReference,
  offset,
  topSurfaceAt,
  PLAYER_HEIGHT,
} from './block.ts'
import { vanillaClassifier } from './semantics/vanilla.ts'
import {
  defaultConstraints,
  type BlockClassifier,
  type Cell,
  type ClassifiedBlock,
  type Direction,
  type DoorState,
  type MotionConstraints,
  type MotionWorld,
  type Rules,
  type StandInfo,
  type Tri,
} from './types.ts'

const EPSILON = 0.001

export type RulesOptions = {
  /**
   * Semantic classifier. Defaults to the vanilla table; passing another one is
   * the whole content-replacement seam.
   */
  classifier?: BlockClassifier
}

/**
 * Snapshot-consistent rule implementation. Reads are cached per instance;
 * call `invalidate()` when the executor moves to a new tick or a block change
 * is observed, so a stale cache never decides an edge.
 */
export class RuleSet implements Rules {
  private readonly cache = new Map<string, ClassifiedBlock | null>()
  private readonly classifier: BlockClassifier

  constructor(
    private readonly world: MotionWorld,
    private readonly constraints: MotionConstraints,
    options: RulesOptions = {},
  ) {
    this.classifier = options.classifier ?? vanillaClassifier
  }

  invalidate(): void {
    this.cache.clear()
  }

  private read(cell: Cell): ClassifiedBlock | null {
    const at = { x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z) }
    const key = cellKey(at)
    if (this.cache.has(key)) return this.cache.get(key) ?? null
    const raw = this.world.blockAt(at)
    if (raw === null) {
      this.cache.set(key, null)
      return null
    }
    const classified: ClassifiedBlock = { ...raw, tags: this.classifier.classify(raw) }
    this.cache.set(key, classified)
    return classified
  }

  private withinBounds(cell: Cell): boolean {
    const { minY, maxY, worldBorder } = this.constraints
    if (minY !== undefined && cell.y < minY) return false
    if (maxY !== undefined && cell.y > maxY) return false
    if (worldBorder !== undefined) {
      if (cell.x < worldBorder.min.x || cell.x > worldBorder.max.x) return false
      if (cell.z < worldBorder.min.z || cell.z > worldBorder.max.z) return false
      if (cell.y < worldBorder.min.y || cell.y > worldBorder.max.y) return false
    }
    return true
  }

  isHazard(cell: Cell): Tri {
    const block = this.read(cell)
    if (block === null || !block.loaded) return 'unknown'
    if (hasTag(block, 'lava')) return 'yes'
    if (hasTag(block, 'magma') && this.constraints.allowWalkOnMagma) return 'no'
    return hasTag(block, 'hazard') ? 'yes' : 'no'
  }

  isClimbable(cell: Cell): Tri {
    return this.tagTri(cell, 'climbable')
  }

  isWater(cell: Cell): Tri {
    return this.tagTri(cell, 'water')
  }

  isLava(cell: Cell): Tri {
    return this.tagTri(cell, 'lava')
  }

  private tagTri(cell: Cell, tag: 'climbable' | 'water' | 'lava'): Tri {
    const block = this.read(cell)
    if (block === null || !block.loaded) return 'unknown'
    return hasTag(block, tag) ? 'yes' : 'no'
  }

  canWalkThrough(cell: Cell): Tri {
    if (!this.withinBounds(cell)) return 'no'
    const block = this.read(cell)
    if (block === null || !block.loaded) return 'unknown'
    if (this.isHazard(cell) !== 'no') return 'no'
    if (hasTag(block, 'water') || hasTag(block, 'lava')) return 'no'
    const body = this.bodyCheck(cell, cell.y)
    return body.state === 'yes' ? 'yes' : body.state === 'unknown' ? 'unknown' : 'no'
  }

  canWalkOn(cell: Cell): Tri {
    if (!this.withinBounds(cell)) return 'no'
    const block = this.read(cell)
    if (block === null || !block.loaded) return 'unknown'
    if (this.isHazard(cell) === 'yes') return 'no'
    if (hasTag(block, 'lava')) return 'no'
    if (hasTag(block, 'water') && !this.constraints.assumeWalkOnWater) return 'no'
    const top = hasTag(block, 'water') ? 1 : topSurfaceAt(block, 0.5, 0.5)
    if (top === undefined) return 'unknown'
    return top > 0 && top <= 1 ? 'yes' : 'no'
  }

  canPlaceAgainst(cell: Cell): Tri {
    const block = this.read(cell)
    if (block === null || !block.loaded) return 'unknown'
    if (hasTag(block, 'hazard') || hasTag(block, 'water') || hasTag(block, 'lava')) return 'no'
    if (block.collision === undefined) return 'unknown'
    return isPlaceReference(block) ? 'yes' : 'no'
  }

  isReplaceable(cell: Cell): Tri {
    const block = this.read(cell)
    if (block === null || !block.loaded) return 'unknown'
    if (hasTag(block, 'hazard') || hasTag(block, 'water') || hasTag(block, 'lava')) return 'no'
    return hasTag(block, 'replaceable') ? 'yes' : 'no'
  }

  doorState(cell: Cell): DoorState {
    const block = this.read(cell)
    if (block === null || !block.loaded) return 'unknown'
    if (!hasTag(block, 'door') && !hasTag(block, 'gate')) return 'none'
    const open = block.state.open
    if (open === 'true') return 'open'
    if (open === 'false') return hasTag(block, 'locked') ? 'locked' : 'closed'
    if (block.state.half === 'upper') {
      const lower = this.read(offset(cell, 0, -1, 0))
      if (lower !== null && lower.loaded) {
        const lowerOpen = lower.state.open
        if (lowerOpen === 'true') return 'open'
        if (lowerOpen === 'false') return hasTag(lower, 'locked') ? 'locked' : 'closed'
      }
    }
    return 'unknown'
  }

  isDoorPassable(cell: Cell, _side: Direction): Tri {
    return this.doorTri(cell, 'door')
  }

  isGatePassable(cell: Cell, _side: Direction): Tri {
    return this.doorTri(cell, 'gate')
  }

  private doorTri(cell: Cell, kind: 'door' | 'gate'): Tri {
    const block = this.read(cell)
    if (block === null || !block.loaded) return 'unknown'
    if (!hasTag(block, kind)) return 'no'
    const state = this.doorState(cell)
    if (state === 'unknown') return 'unknown'
    if (state === 'open') return 'yes'
    if (state === 'locked') return 'no'
    if (state === 'closed') return this.constraints.allowDoor && hasTag(block, 'openable') ? 'yes' : 'no'
    return 'no'
  }

  standable(cell: Cell): Tri {
    const info = this.standInfo(cell)
    return info.state
  }

  standInfo(cell: Cell): StandInfo {
    if (!this.withinBounds(cell)) return { state: 'no', reason: 'outside-bounds' }
    const supportCell = offset(cell, 0, -1, 0)
    const support = this.read(supportCell)
    if (support === null || !support.loaded) return { state: 'unknown', reason: 'support-unloaded' }
    if (this.isHazard(supportCell) === 'yes') return { state: 'no', reason: 'hazard-support' }
    if (hasTag(support, 'lava')) return { state: 'no', reason: 'lava-support' }
    if (hasTag(support, 'water') && !this.constraints.assumeWalkOnWater) {
      return { state: 'no', reason: 'water-support' }
    }
    if (hasTag(support, 'water') && this.constraints.assumeWalkOnWater) {
      return this.bodyCheck(cell, cell.y)
    }
    const top = topSurfaceAt(support, 0.5, 0.5)
    if (top === undefined) return { state: 'unknown', reason: 'collision-unknown' }
    if (top <= 0) return { state: 'no', reason: 'no-support' }
    if (top > 1) return { state: 'no', reason: 'support-too-high' }
    return this.bodyCheck(cell, cell.y - 1 + top)
  }

  /**
   * Body clearance above `feetY`. The support cell is excluded by the epsilon
   * on the body's lower bound, so a slab's top does not count as a wall.
   */
  private bodyCheck(cell: Cell, feetY: number): StandInfo {
    const minY = feetY + EPSILON
    const maxY = feetY + PLAYER_HEIGHT - EPSILON
    const first = Math.floor(minY)
    const last = Math.floor(maxY)
    for (let y = first; y <= last; y += 1) {
      const at = { x: cell.x, y, z: cell.z }
      const block = this.read(at)
      if (block === null || !block.loaded) return { state: 'unknown', reason: 'body-unloaded' }
      if (this.isHazard(at) === 'yes') return { state: 'no', reason: 'hazard-body' }
      if (hasTag(block, 'water') || hasTag(block, 'lava')) return { state: 'no', reason: 'fluid-body' }
      const overlap = bodyOverlap(block, at, feetY)
      if (overlap === undefined) return { state: 'unknown', reason: 'collision-unknown' }
      if (overlap) return { state: 'no', reason: 'body-collision' }
    }
    return { state: 'yes', feetY }
  }
}

export function createRules(
  world: MotionWorld,
  constraints: MotionConstraints = defaultConstraints(),
  options: RulesOptions = {},
): RuleSet {
  return new RuleSet(world, constraints, options)
}

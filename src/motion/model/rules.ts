import {
  bodyOverlap,
  cellKey,
  hasTag,
  isPlaceReference,
  offset,
  supportTopAt,
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
    if (hasTag(block, 'lava')) return 'no'
    if (hasTag(block, 'water') && this.wadeCell(cell) !== 'yes') return 'no'
    const body = this.bodyCheck(cell, cell.y)
    return body.state === 'yes' ? 'yes' : body.state === 'unknown' ? 'unknown' : 'no'
  }

  canPass(cell: Cell): Tri {
    if (!this.withinBounds(cell)) return 'no'
    const block = this.read(cell)
    if (block === null || !block.loaded) return 'unknown'
    if (this.isHazard(cell) !== 'no') return 'no'
    if (hasTag(block, 'lava')) return 'no'
    if (hasTag(block, 'water')) return this.wadeCell(cell) === 'yes' ? 'yes' : 'no'
    if (block.collision === undefined) return 'unknown'
    return block.collision.length === 0 ? 'yes' : 'no'
  }

  canWalkOn(cell: Cell): Tri {
    if (!this.withinBounds(cell)) return 'no'
    const block = this.read(cell)
    if (block === null || !block.loaded) return 'unknown'
    if (this.isHazard(cell) === 'yes') return 'no'
    if (hasTag(block, 'lava')) return 'no'
    if (hasTag(block, 'water') && !this.constraints.assumeWalkOnWater) return 'no'
    const top = hasTag(block, 'water') ? 1 : supportTopAt(block)
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

  canBreak(cell: Cell): Tri {
    if (!this.constraints.allowBreak || this.constraints.breakTargets === undefined) return 'no'
    const target = this.constraints.breakTargets.find(item => cellKey(item) === cellKey(cell))
    if (target === undefined) return 'no'
    const block = this.read(cell)
    if (block === null || !block.loaded) return 'unknown'
    if (target.name !== undefined && block.name !== target.name) return 'no'
    if (block.diggable === false) return 'no'
    if (this.avoidBreaking(cell, block)) return 'no'
    // Hardness unknown means the adapter cannot price the removal; do not guess.
    if (block.hardness === undefined) return 'unknown'
    return 'yes'
  }

  breakCost(cell: Cell): number | undefined {
    if (this.canBreak(cell) !== 'yes') return undefined
    const block = this.read(cell)
    if (block === null || block.hardness === undefined) return undefined
    const base = 1 + Math.min(8, Math.max(0, block.hardness) * 0.5)
    return base + (this.constraints.breakPenalty ?? 0)
  }

  /**
   * Reasons not to remove a cell even when it is on the explicit whitelist:
   * liquids/hazards, ice (turns to water), infested blocks, and blocks touching
   * a liquid (removing them can start a flow).
   */
  private avoidBreaking(cell: Cell, block: ClassifiedBlock): boolean {
    if (hasTag(block, 'hazard') || hasTag(block, 'water') || hasTag(block, 'lava')) return true
    if (block.name === 'ice' || block.name === 'frosted_ice' || block.name.startsWith('infested_')) return true
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const neighbour = this.read(offset(cell, dx, dy, dz))
      if (neighbour === null || !neighbour.loaded) continue
      if (hasTag(neighbour, 'water') || hasTag(neighbour, 'lava')) return true
    }
    return false
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

  standInfo(cell: Cell, ignoreBody: readonly Cell[] = []): StandInfo {
    const support = this.supportFeet(cell)
    if (support.state !== 'yes') return support
    return this.bodyCheck(cell, support.feetY, ignoreBody)
  }

  supportFeet(cell: Cell): StandInfo {
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
      return { state: 'yes', feetY: cell.y }
    }
    const top = supportTopAt(support)
    if (top === undefined) return { state: 'unknown', reason: 'collision-unknown' }
    if (top <= 0) return { state: 'no', reason: 'no-support' }
    if (top > 1) return { state: 'no', reason: 'support-too-high' }
    return { state: 'yes', feetY: cell.y - 1 + top }
  }

  /**
   * Is this a water cell the body may enter under the current profile? `wade`
   * accepts exactly one block of water over a full-height, dry, walkable floor:
   * the feet get wet, the head stays in air. Anything deeper, over a partial
   * support, or with water above the head needs a swim/waterline controller.
   */
  private wadeCell(cell: Cell): Tri {
    if (this.constraints.waterProfile === 'none') return 'no'
    const block = this.read(cell)
    if (block === null || !block.loaded) return 'unknown'
    if (!hasTag(block, 'water')) return 'no'
    const above = this.read(offset(cell, 0, 1, 0))
    if (above === null || !above.loaded) return 'unknown'
    if (hasTag(above, 'water') || hasTag(above, 'lava')) return 'no'
    const supportCell = offset(cell, 0, -1, 0)
    const below = this.read(supportCell)
    if (below === null || !below.loaded) return 'unknown'
    if (this.isHazard(supportCell) === 'yes') return 'no'
    if (hasTag(below, 'water') || hasTag(below, 'lava')) return 'no'
    const top = supportTopAt(below)
    if (top === undefined) return 'unknown'
    // A partial support under water would put the feet below the cell base.
    if (top < 1 - EPSILON) return 'no'
    return this.bodyCheck(cell, cell.y).state
  }

  /**
   * Body clearance above `feetY`. The support cell is excluded by the epsilon
   * on the body's lower bound, so a slab's top does not count as a wall.
   */
  private bodyCheck(cell: Cell, feetY: number, ignoreBody: readonly Cell[] = []): StandInfo {
    const minY = feetY + EPSILON
    const maxY = feetY + PLAYER_HEIGHT - EPSILON
    const first = Math.floor(minY)
    const last = Math.floor(maxY)
    for (let y = first; y <= last; y += 1) {
      const at = { x: cell.x, y, z: cell.z }
      if (ignoreBody.some(ignored => cellKey(ignored) === cellKey(at))) continue
      const block = this.read(at)
      if (block === null || !block.loaded) return { state: 'unknown', reason: 'body-unloaded' }
      if (this.isHazard(at) === 'yes') return { state: 'no', reason: 'hazard-body' }
      if (hasTag(block, 'lava')) return { state: 'no', reason: 'lava-body' }
      if (hasTag(block, 'water')) {
        if (!this.wadeBodyCell(cell, y)) return { state: 'no', reason: 'fluid-body' }
        continue
      }
      const overlap = bodyOverlap(block, at, feetY)
      if (overlap === undefined) return { state: 'unknown', reason: 'collision-unknown' }
      if (overlap) return { state: 'no', reason: 'body-collision' }
    }
    return { state: 'yes', feetY }
  }

  /**
   * A wadeable water cell may occupy only the feet cell of the body: the block
   * above it must be dry, otherwise the head would be underwater.
   */
  private wadeBodyCell(cell: Cell, bodyY: number): boolean {
    if (this.constraints.waterProfile === 'none') return false
    if (bodyY !== cell.y) return false
    const above = this.read(offset(cell, 0, 1, 0))
    if (above === null || !above.loaded) return false
    return !hasTag(above, 'water') && !hasTag(above, 'lava')
  }
}

export function createRules(
  world: MotionWorld,
  constraints: MotionConstraints = defaultConstraints(),
  options: RulesOptions = {},
): RuleSet {
  return new RuleSet(world, constraints, options)
}

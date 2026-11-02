import {
  createRules,
  defaultConstraints,
  type Cell,
  type CollisionBox,
  type MotionWorld,
  type RawBlock,
  type SelfView,
  type StandInfo,
} from '../motion/model/index.ts'
import { AIR_NAMES, isLegacySolidName } from '../motion/model/semantics/vanilla.ts'
import type { BlockInfo, Vec3 } from '../port/index.ts'
import type { WorldView } from './types.ts'

/** Legacy-compatible standability result consumed by givers/drivers. */
export type Standability = {
  state: 'valid' | 'unknown' | 'blocked' | 'unsafe'
  position?: Vec3
  reason?: string
  block?: { position: Vec3; name: string }
}

const SELF: SelfView = {
  pos: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  onGround: true,
  sneaking: false,
  sprinting: false,
  health: 20,
}

function collisionFor(block: BlockInfo): readonly CollisionBox[] | undefined {
  if (block.collision !== undefined) return block.collision as unknown as readonly CollisionBox[]
  if (block.solid === false || AIR_NAMES.has(block.name)) return []
  if (block.name === 'water' || block.name === 'lava' || block.name === 'bubble_column') return []
  if (block.solid === true || isLegacySolidName(block.name)) return [[0, 0, 0, 1, 1, 1]]
  // A snapshot without collision or a solid hint is genuinely unknown.
  return undefined
}

function rawBlock(block: BlockInfo): RawBlock {
  const collision = collisionFor(block)
  return {
    loaded: block.loaded,
    name: block.name,
    state: block.state ?? {},
    ...(collision === undefined ? {} : { collision }),
    ...(block.serverTags === undefined ? {} : { serverTags: block.serverTags }),
    ...(block.hardness === undefined ? {} : { hardness: block.hardness }),
    ...(block.diggable === undefined ? {} : { diggable: block.diggable }),
  }
}

export function createReadOnlyMotionWorld(read: (p: Vec3) => BlockInfo | null): MotionWorld {
  return {
    self: () => SELF,
    blockAt: (p: Cell) => {
      const block = read(p)
      return block === null ? null : rawBlock(block)
    },
    entities: () => [],
    tick: () => 0,
    onTick: () => () => {},
    setInput: () => {},
    look: () => {},
    useOn: () => {},
    place: () => {},
    dig: () => {},
    attack: () => {},
    releaseAll: () => {},
  }
}

function mapStandInfo(cell: Cell, info: StandInfo): Standability {
  if (info.state === 'yes') {
    return { state: 'valid', position: { x: cell.x + 0.5, y: info.feetY, z: cell.z + 0.5 } }
  }
  if (info.state === 'unknown') return { state: 'unknown', reason: info.reason }
  const unsafe = /hazard|lava|water|fluid/u.test(info.reason)
  return { state: unsafe ? 'unsafe' : 'blocked', reason: info.reason }
}

/**
 * The single standability implementation used by givers, drivers and
 * verifiers. It reads through the same RuleSet as the motion planner.
 */
export function standingAt(read: (p: Vec3) => BlockInfo | null, cell: Vec3): Standability {
  const at = { x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z) }
  const rules = createRules(createReadOnlyMotionWorld(read), defaultConstraints())
  return mapStandInfo(at, rules.standInfo(at))
}

export function standability(world: WorldView, position: Vec3): Standability {
  return standingAt(point => world.blockAt(point), position)
}

export function isStandable(world: WorldView, position: Vec3): boolean {
  return standability(world, position).state === 'valid'
}

export function isStandableAt(read: (p: Vec3) => BlockInfo | null, position: Vec3): boolean {
  return standingAt(read, position).state === 'valid'
}

/**
 * Motion model vocabulary. Pure data and interfaces only: this module must not
 * import a client adapter, and it must not branch on block names. Semantic
 * meaning is supplied by a `BlockClassifier` (see `semantics/`).
 */

export type Vec3 = { x: number; y: number; z: number }

/** Integer block cell. Path nodes are feet cells: the block the feet occupy. */
export type Cell = Vec3

export type Box = { min: Vec3; max: Vec3 }

/** Local collision AABB [minX,minY,minZ,maxX,maxY,maxZ], in 0..1 block units. */
export type CollisionBox = readonly [number, number, number, number, number, number]

/** Three-state predicate result. Unknown is never folded into yes or no. */
export type Tri = 'yes' | 'no' | 'unknown'

export function triOf(value: boolean): Tri {
  return value ? 'yes' : 'no'
}

/** Only `yes` may be used as a capability; `unknown` behaves as unavailable. */
export function isAvailable(value: Tri): boolean {
  return value === 'yes'
}

export const COST_INF = Number.POSITIVE_INFINITY

/**
 * Semantic tags. Rules consume these; they never inspect `name`. The vanilla
 * table lives in `semantics/vanilla.ts` and can be replaced wholesale.
 */
export type BlockTag =
  | 'hazard'
  | 'climbable'
  | 'door'
  | 'gate'
  | 'openable'
  | 'locked'
  | 'replaceable'
  | 'solid'
  | 'water'
  | 'lava'
  | 'magma'

/**
 * Adapter-provided block view. `collision` comes from the block state; when it
 * is missing the geometry is unknown, never "empty". `loaded: false` is also
 * unknown and must not be treated as air.
 */
export type RawBlock = {
  loaded: boolean
  name: string
  state: Readonly<Record<string, string>>
  collision?: readonly CollisionBox[]
  /**
   * Raw vanilla block tags from the server (`minecraft:wooden_doors`,
   * `minecraft:replaceable`, ...). The core never reads these names directly;
   * `BlockClassifier` maps them to semantic tags. Undefined means the adapter
   * cannot tell (tags not received yet), never "no tags".
   */
  serverTags?: ReadonlySet<string>
}

/** A raw block plus classifier tags; geometry is never rewritten by classification. */
export type ClassifiedBlock = RawBlock & { tags: readonly BlockTag[] }

/** The single replaceable content seam: names/states in, semantic tags out. */
export interface BlockClassifier {
  classify(block: RawBlock): readonly BlockTag[]
}

export type EntityView = {
  id: string
  name: string
  position: Vec3
  width?: number
  height?: number
  kind?: string
}

export type SelfView = {
  pos: Vec3
  velocity: Vec3
  yaw: number
  pitch: number
  onGround: boolean
  sneaking: boolean
  sprinting: boolean
  health: number
}

export type InputControl = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sneak' | 'sprint'

/**
 * Read-only world view plus execution primitives. The adapter owns all game
 * I/O; the model only observes and requests inputs/actions.
 */
export type MotionWorld = {
  self(): SelfView
  /** `null` means unloaded. A loaded block with unknown collision is still a block. */
  blockAt(p: Cell): RawBlock | null
  entities(box: Box): readonly EntityView[]
  tick(): number
  onTick(cb: () => void): () => void
  setInput(control: InputControl, on: boolean): void
  look(yaw: number, pitch: number): void
  useOn(p: Cell): void
  place(p: Cell, item: string): void
  dig(p: Cell): void
  attack(entityId: string): void
  releaseAll(): void
}

export type MotionProfile = 'walk' | 'sprint' | 'parkour' | 'descend' | 'ascend'

/**
 * What one planning/execution pass is allowed to do. Defaults deny every
 * world-changing action; bridge/pillar must be authorized explicitly.
 */
export type MotionConstraints = {
  profile: MotionProfile
  allowBreak: boolean
  allowPlace: boolean
  allowParkour: boolean
  allowDiagonal: boolean
  /** Open closed wooden doors/gates while traversing. */
  allowDoor: boolean
  /** Maximum planned, support-to-support drop in blocks. */
  maxFall: number
  allowFallIntoLava: boolean
  assumeWalkOnWater: boolean
  allowWalkOnMagma: boolean
  worldBorder?: { min: Cell; max: Cell }
  minY?: number
  maxY?: number
  /** Material used by Bridge/Pillar when placement is authorized. */
  material?: string
  hasThrowaway?: boolean
  toolset?: readonly string[]
}

export function defaultConstraints(profile: MotionProfile = 'walk'): MotionConstraints {
  return {
    profile,
    allowBreak: false,
    allowPlace: false,
    allowParkour: false,
    allowDiagonal: false,
    allowDoor: true,
    maxFall: 2,
    allowFallIntoLava: false,
    assumeWalkOnWater: false,
    allowWalkOnMagma: false,
  }
}

/** Apply an explicit patch without inventing values for omitted fields. */
export function resolveConstraints(
  base: MotionConstraints,
  patch: Partial<MotionConstraints>,
): MotionConstraints {
  return { ...base, ...patch }
}

export type Direction = 'north' | 'south' | 'east' | 'west' | 'up' | 'down'

export type DoorState = 'open' | 'closed' | 'locked' | 'none' | 'unknown'

/**
 * Result of a standing check. `feetY` is the continuous feet height derived
 * from the support's real collision top (0.5 for a bottom slab, 1 for a cube).
 */
export type StandInfo =
  | { state: 'yes'; feetY: number }
  | { state: 'no'; reason: string }
  | { state: 'unknown'; reason: string }

/** Shared predicates used by both the planner and the executor. */
export interface Rules {
  canWalkThrough(cell: Cell): Tri
  canWalkOn(cell: Cell): Tri
  canPlaceAgainst(cell: Cell): Tri
  isReplaceable(cell: Cell): Tri
  isDoorPassable(cell: Cell, side: Direction): Tri
  isGatePassable(cell: Cell, side: Direction): Tri
  isHazard(cell: Cell): Tri
  isClimbable(cell: Cell): Tri
  isWater(cell: Cell): Tri
  isLava(cell: Cell): Tri
  standable(cell: Cell): Tri
  standInfo(cell: Cell): StandInfo
  doorState(cell: Cell): DoorState
}

export type MoveStatus =
  | 'prepping'
  | 'waiting'
  | 'running'
  | 'success'
  | 'unreachable'
  | 'failed'
  | 'canceled'

export type MoveKind =
  | 'traverse'
  | 'ascend'
  | 'descend'
  | 'fall'
  | 'downward'
  | 'bridge'
  | 'pillar'
  | 'diagonal'
  | 'parkour'

export type MoveState = {
  status: MoveStatus
  ticks: number
  startedAt: number
  elapsedMs: number
  /** Last diagnostic from the move's own state machine. */
  detail?: string
}

export function initialMoveState(now: number): MoveState {
  return { status: 'prepping', ticks: 0, startedAt: now, elapsedMs: 0 }
}

export type MoveContext = {
  world: MotionWorld
  rules: Rules
  constraints: MotionConstraints
  self: SelfView
  tick: number
  now: number
  /** Continuous feet position for this update. */
  position: Vec3
}

/**
 * One edge in the movement graph. `cost` is shared by planner and executor;
 * the executor re-evaluates it at runtime and aborts if it becomes COST_INF.
 */
export interface Move {
  readonly kind: MoveKind
  readonly src: Cell
  readonly dest: Cell
  cost(ctx: MoveContext): number
  /** Feet cells allowed while this edge executes (recovery targets). */
  validPositions(): readonly Cell[]
  update(state: MoveState, ctx: MoveContext): MoveStatus
  reset(): void
  /** Whether an in-flight switch away from this move is safe. */
  safeToCancel(state: MoveState): boolean
  /** Cells this edge must remove before it can run. */
  toBreak(): readonly Cell[]
  /** Cells this edge must fill before it can run. */
  toPlace(): readonly Cell[]
}

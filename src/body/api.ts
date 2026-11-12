import type { JsonValue } from '../contracts/types.ts'
import type { SuspensionState } from '../contracts/protocol.ts'

/** Pure-data geometry shared by the body API and its implementation. */
export type Vec3 = { x: number; y: number; z: number }

export type Box = { min: Vec3; max: Vec3 }

export type Face = 'up' | 'down' | 'north' | 'south' | 'east' | 'west'

/** `loaded: false` is unknown, never air. `blockAt` uses `null` instead. */
export type BlockInfo = {
  name: string
  state?: Record<string, string>
  loaded: boolean
  /** Collision hint from the adapter; undefined means it cannot tell. */
  solid?: boolean
  /** Local collision AABBs [minX,minY,minZ,maxX,maxY,maxZ]; [] is non-colliding. */
  collision?: number[][]
  /**
   * Raw server block tags for this block (`minecraft:wooden_doors`, ...).
   * Undefined means the adapter has not received/mapped tags yet, never
   * "no tags"; the semantic classifier falls back to name rules in that case.
   */
  serverTags?: ReadonlySet<string>
  /** Set by `blocksIn` entries; `blockAt` already knows the position. */
  pos?: Vec3
  /** Adapter-provided harvest metadata; omitted when the adapter cannot tell. */
  material?: string
  diggable?: boolean
  hardness?: number
  /** Block light 0–15 when the adapter can read it; undefined is unknown. */
  light?: number
  /** Sky light 0–15 when the adapter can read it; undefined is unknown. */
  skyLight?: number
  /** Item names that can harvest this block; [] means hand is sufficient. */
  harvestTools?: string[]
}

export type Item = { slot: number; name: string; count: number }

/**
 * Read-only nearest-block query. The implementation searches only loaded
 * chunks and returns at most `count` loaded matches, nearest first.
 */
export type FindBlocksQuery = {
  near: Vec3
  radius: number
  names: string[]
  count: number
}

export type EntityInfo = {
  id: string
  name: string
  position: Vec3
  /** Adapter-reported velocity in blocks per tick; absent when unknown. */
  velocity?: Vec3
  /** Entity yaw in radians (mineflayer: 0 = -z); absent when it cannot tell. */
  yaw?: number
  /** Entity AABB width/height; item fallback is 0.25x0.25. */
  width?: number
  height?: number
  /** Adapter-provided entity category: player/animal/hostile/other/... */
  type?: string
  /** Human-readable category, when the adapter has one. */
  kind?: string
  /** Entity health when exposed (not guaranteed for all mobs). */
  health?: number
  username?: string
  /** Dropped item stack, resolved when possible. */
  item?: { name: string; count: number }
}

export type BiomeInfo = {
  id: number
  name: string
}

/** A named place the implementation resolves to a position. */
export type Landmark = { name: string }

/** Result of a check job that opens a container/furnace interface. */
export type ContainerCheckResult =
  | {
      state: 'ok'
      block: string
      items: Item[]
      fuel?: number
      progress?: number
    }
  | { state: 'failed'; code: string; message?: string }
  | { state: 'unknown'; code: string; message?: string }

export type SelfInfo = {
  pos: Vec3
  yaw: number
  pitch: number
  health: number
  food: number
  onGround: boolean
  inWater: boolean
  inLava: boolean
  /** Player AABB width/height; fallback is 0.6x1.8. */
  width?: number
  height?: number
}

export const BodyErrorCodes = {
  STALE_WRITE: 'STALE_WRITE',
  /**
   * Timeout after the action was stopped and release was confirmed. The action
   * either never produced an effect or is safe to repeat (move/look/equip).
   */
  ACT_TIMEOUT: 'ACT_TIMEOUT',
  /**
   * Timeout after the action may have reached the server. The effect is
   * unknown: never replay it; re-observe and decide from the world.
   */
  ACT_UNCONFIRMED: 'ACT_UNCONFIRMED',
  /**
   * A server chat/system message in the act window explicitly refused the
   * action (permission/protection/adventure mode). Definitive failure.
   */
  ACTION_DENIED: 'ACTION_DENIED',
  /**
   * Legacy wire code from before the ACT_TIMEOUT/ACT_UNCONFIRMED split.
   * Never emitted now; kept so saved sessions and old metrics still map.
   */
  CLIENT_TIMEOUT: 'CLIENT_TIMEOUT',
} as const

/**
 * Three-state action result. `unknown` means the request was issued but its
 * effect is not confirmed: it is never success and must not be replayed.
 */
export type ActState = 'ok' | 'failed' | 'unknown'

export type ActResult = {
  state: ActState
  code?: string
  observed?: JsonValue
  elapsedMs: number
}

export function actOk(elapsedMs: number, observed?: JsonValue): ActResult {
  return observed === undefined ? { state: 'ok', elapsedMs } : { state: 'ok', observed, elapsedMs }
}

export function actFailed(code: string, elapsedMs: number, observed?: JsonValue): ActResult {
  return observed === undefined
    ? { state: 'failed', code, elapsedMs }
    : { state: 'failed', code, observed, elapsedMs }
}

export function actUnknown(code: string, elapsedMs: number, observed?: JsonValue): ActResult {
  return observed === undefined
    ? { state: 'unknown', code, elapsedMs }
    : { state: 'unknown', code, observed, elapsedMs }
}

/** Dynamic, per-order break authorization. */
export type UnstickBlock = Vec3 & { name: string }

export type MoveOptions = {
  range?: number
  timeoutMs?: number
  exact?: boolean
  unstickDig?: UnstickBlock[]
  intent?: 'interact' | 'attack'
  /** Extra motion options; all default false and require explicit order authorization. */
  allowParkour?: boolean
  allowDiagonal?: boolean
  allowPlace?: boolean
  material?: string
  /**
   * Explicit authorization to sprint on plain ground traversal. Off by
   * default; the driver drops it when the body is too hungry, and jump/descend
   * moves never sprint regardless. Vanilla plannner (`risky`) ignores it.
   */
  sprint?: boolean
  /**
   * Only for an explicit `traverse scaffold`: an exact goal may start
   * unsupported because the Pillar move will place the column under it. The
   * implementation ignores this unless `allowPlace` is also true.
   */
  allowUnsupportedGoal?: boolean
  /**
   * `astar` (default) is the validated planner: it refuses edges it cannot
   * prove. `vanilla` is the unvalidated, best-effort mode (`go { risky: true }`):
   * it never promises safety and may drown or fall.
   */
  planner?: 'astar' | 'vanilla'
}

export type ContainerTransferAction =
  | 'deposit'
  | 'withdraw'
  | 'load-input'
  | 'load-fuel'
  | 'take-input'
  | 'take-fuel'
  | 'take-output'

export type BodyEvent =
  | 'blockUpdated'
  | 'inventoryChanged'
  | 'screenOpened'
  | 'damaged'
  | 'died'
  | 'chat'
  | 'provider.suspended'
  | 'provider.resumed'
  | 'move.started'
  | 'move.progress'
  | 'move.no_path'
  | 'move.stuck'
  | 'move.finished'
  | 'move.door'
  | 'move.unstick-dig'
  | 'entityHurt'
  | 'entityDead'
  | 'explosion'

export type WriteToken = { runId: string; jobId: string; seq: number }

/**
 * The single consumer-facing game-I/O boundary. Values are pure data: no
 * mineflayer objects, types, events or handles cross this type.
 *
 * It is not a provider abstraction: `MineflayerBody` is the only
 * implementation. Consumers add a method here only when they need one.
 */
export type BodyApi = {
  /** Current provider suspension; a paused server is a temporary loss of observation. */
  suspension?(): SuspensionState
  /** Open a container/furnace for a check job; closes it before resolving. */
  containerAt(p: Vec3): Promise<ContainerCheckResult>
  /** Transfer items through a chest/furnace window; one bounded action. */
  containerTransfer(
    p: Vec3,
    action: ContainerTransferAction,
    item?: string,
    count?: number,
  ): Promise<ActResult>
  self(): SelfInfo
  /** Stable recovery identity for this world/character binding. */
  identity(): { worldId: string; characterId: string }
  /** Start one Agent-authorized fatal step-off; core pathing never calls it. */
  fatalStep(target: Vec3): Promise<ActResult>
  blockAt(p: Vec3): BlockInfo | null
  biomeAt(p: Vec3): BiomeInfo | null
  blocksIn(box: Box, filter?: string[]): BlockInfo[]
  /**
   * Nearest loaded blocks whose name is in `names`, within Euclidean `radius`
   * of `near`. At most `count`, nearest first; unloaded cells are skipped.
   */
  findBlocks(query: FindBlocksQuery): BlockInfo[]
  inventory(): Item[]
  offhand?(): Item | undefined
  entities(box: Box): EntityInfo[]
  /** Resolve one entity by username or entity name without a box scan. */
  entityByName?(name: string): EntityInfo | undefined
  /** Resolve one entity by provider id. */
  entityById?(id: string): EntityInfo | undefined
  /** Whether a player with this exact username is in the tab list. */
  playerOnline?(name: string): boolean
  time(): { timeOfDay: number; worldAge: number }

  beginWrite(token: WriteToken): void
  endWrite(token: WriteToken): void

  moveTo(target: Vec3 | Landmark, opts?: MoveOptions): Promise<ActResult>
  /**
   * Set the persistent combat movement controls (and facing) for the next
   * 50ms tick. Controls stay active until the next input or `endWrite`.
   */
  combatInput?(opts: {
    face: Vec3
    forward?: boolean
    back?: boolean
    left?: boolean
    right?: boolean
    jump?: boolean
  }): Promise<ActResult>
  /** Read-only bounded path planning; combat follows the returned waypoints. */
  pathTo?(target: Vec3, range: number, timeoutMs: number): Promise<{
    state: 'ok' | 'failed'
    code?: string
    path?: Vec3[]
  }>
  lookAt(p: Vec3): Promise<ActResult>
  /** Set the horizontal look direction (radians, 0 = +z) for oriented placement. */
  lookYaw?(yaw: number): Promise<ActResult>
  dig(p: Vec3): Promise<ActResult>
  place(p: Vec3, face: Face, item: string): Promise<ActResult>
  useItem(opts?: { durationMs?: number; offhand?: boolean }): Promise<ActResult>
  /**
   * Persistent off-hand stance: `true` holds the off-hand item across acts,
   * `false` releases it. Unlike `useItem` the stance is not tied to one act's
   * lifetime; it is released on `false`, a write-epoch change, `endWrite`, or
   * a provider reset. Absent means the adapter cannot keep an item held.
   */
  offhandHold?(active: boolean): Promise<ActResult>
  equip(item: string, destination?: 'hand' | 'offhand'): Promise<ActResult>
  unequip?(destination?: 'hand' | 'offhand'): Promise<ActResult>
  craft(item: string, count?: number): Promise<ActResult>
  useOn(p: Vec3): Promise<ActResult>
  attack(entityId: string): Promise<ActResult>
  sleep(bed: Vec3): Promise<ActResult>

  say(text: string): void

  /** Line of sight to an entity; false is "cannot tell", never visible. */
  canSee?(entityId: string): boolean
  /** Current attacks per second from the player/item attributes. */
  attackSpeed?(): number
  /**
   * Effective entity interaction range (eye to target AABB) from the player
   * attribute `player.entity_interaction_range`.
   */
  attackReach?(): number

  on(event: BodyEvent, cb: (payload: JsonValue) => void): void
  off?(event: BodyEvent, cb: (payload: JsonValue) => void): void
}

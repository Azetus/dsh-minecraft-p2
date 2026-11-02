import type { JsonValue } from '../contracts/types.ts'
import type { SuspensionState } from '../contracts/protocol.ts'
import type { Capability } from './capabilities.ts'
import type {
  ActResult,
  BiomeInfo,
  BlockInfo,
  Box,
  ContainerCheckResult,
  EntityInfo,
  Face,
  Item,
  Landmark,
  ScreenInfo,
  SelfInfo,
  Vec3,
} from './types.ts'
import type { WriteToken } from './write-token.ts'
import type { HazardPolicy, UnstickBlock } from './policy.ts'
export type ClientEvent =
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

export type MoveOptions = {
  range?: number
  timeoutMs?: number
  exact?: boolean
  approach?: boolean
  unstickDig?: UnstickBlock[]
  intent?: 'interact' | 'attack'
  /** Extra motion capabilities; all default false and require explicit order authorization. */
  allowParkour?: boolean
  allowDiagonal?: boolean
  allowPlace?: boolean
  material?: string
  /**
   * `astar` (default) is the validated planner: it refuses edges it cannot
   * prove. `vanilla` is the unvalidated, best-effort mode (`go { risky: true }`):
   * it never promises safety and may drown or fall.
   */
  planner?: 'astar' | 'vanilla'
}

/**
 * The only game-I/O boundary. Values are pure data: no mineflayer objects,
 * types, events or handles cross this interface.
 *
 * Actions resolve with an ActResult instead of throwing; the doc's schematic
 * `ActResult` return is a Promise here because mineflayer cannot complete an
 * action without awaiting (and blocking the loop would kill the heartbeat).
 */
export type ContainerTransferAction =
  | 'deposit'
  | 'withdraw'
  | 'load-input'
  | 'load-fuel'
  | 'take-input'
  | 'take-fuel'
  | 'take-output'

export interface ClientPort {
  /**
   * Current provider suspension, when the adapter can report it. A paused
   * server is a temporary loss of observation, not a failed action.
   */
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
  inventory(): Item[]
  entities(box: Box): EntityInfo[]
  screen(): Promise<ScreenInfo | null>
  time(): { timeOfDay: number; worldAge: number }

  beginWrite(token: WriteToken): void
  endWrite(token: WriteToken): void

  moveTo(target: Vec3 | Landmark, opts?: MoveOptions): Promise<ActResult>
  lookAt(p: Vec3): Promise<ActResult>
  /**
   * Set the horizontal look direction (radians, 0 = +z) for an oriented
   * placement such as a bed. Optional: adapters without direct yaw control can
   * omit it, and the placement then relies on the current facing.
   */
  lookYaw?(yaw: number): Promise<ActResult>
  dig(p: Vec3): Promise<ActResult>
  place(p: Vec3, face: Face, item: string): Promise<ActResult>
  useItem(opts?: { durationMs?: number }): Promise<ActResult>
  equip(item: string): Promise<ActResult>
  craft(item: string, count?: number): Promise<ActResult>
  useOn(p: Vec3): Promise<ActResult>
  attack(entityId: string): Promise<ActResult>
  sleep(bed: Vec3): Promise<ActResult>

  say(text: string): void

  /**
   * Line of sight to an entity, when the adapter can raycast. Absent means the
   * adapter cannot tell; callers must not treat that as "visible".
   */
  canSee?(entityId: string): boolean
  /** Current attacks per second from the player/item attributes. */
  attackSpeed?(): number

  on(event: ClientEvent, cb: (payload: JsonValue) => void): void
  /** Remove a listener registered with `on`; optional for simple adapters. */
  off?(event: ClientEvent, cb: (payload: JsonValue) => void): void
  capabilities(): Capability[]
}

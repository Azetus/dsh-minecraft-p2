import type { JsonValue } from '../contracts/types.ts'
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
import type { HazardPolicy, UnstickBlock } from './terrain.ts'

export type ClientEvent =
  | 'blockUpdated'
  | 'inventoryChanged'
  | 'screenOpened'
  | 'damaged'
  | 'died'
  | 'chat'
  | 'move.started'
  | 'move.progress'
  | 'move.no_path'
  | 'move.stuck'
  | 'move.finished'
  | 'move.door'
  | 'move.unstick-dig'

export type MoveOptions = {
  range?: number
  timeoutMs?: number
  exact?: boolean
  approach?: boolean
  unstickDig?: UnstickBlock[]
  intent?: 'interact' | 'attack'
  /** Explicit danger permissions for this call; default is empty. */
  hazards?: HazardPolicy
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
  dig(p: Vec3): Promise<ActResult>
  place(p: Vec3, face: Face, item: string): Promise<ActResult>
  /** Jump and place the held material under the feet, once per level. */
  pillarUp(item: string, levels: number): Promise<ActResult>
  useItem(opts?: { durationMs?: number }): Promise<ActResult>
  equip(item: string): Promise<ActResult>
  craft(item: string, count?: number): Promise<ActResult>
  useOn(p: Vec3): Promise<ActResult>
  attack(entityId: string): Promise<ActResult>
  sleep(bed: Vec3): Promise<ActResult>

  say(text: string): void

  on(event: ClientEvent, cb: (payload: JsonValue) => void): void
  capabilities(): Capability[]
}

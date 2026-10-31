import type { JsonValue } from '../contracts/types.ts'
import type { Capability } from './capabilities.ts'
import type {
  ActResult,
  BlockInfo,
  Box,
  EntityInfo,
  Face,
  Item,
  Landmark,
  ScreenInfo,
  SelfInfo,
  Vec3,
} from './types.ts'
import type { WriteToken } from './write-token.ts'

export type ClientEvent =
  | 'blockUpdated'
  | 'inventoryChanged'
  | 'screenOpened'
  | 'damaged'
  | 'died'
  | 'chat'

export type MoveOptions = { range?: number; timeoutMs?: number }

/**
 * The only game-I/O boundary. Values are pure data: no mineflayer objects,
 * types, events or handles cross this interface.
 *
 * Actions resolve with an ActResult instead of throwing; the doc's schematic
 * `ActResult` return is a Promise here because mineflayer cannot complete an
 * action without awaiting (and blocking the loop would kill the heartbeat).
 */
export interface ClientPort {
  self(): SelfInfo
  blockAt(p: Vec3): BlockInfo | null
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
  useItem(): Promise<ActResult>
  useOn(p: Vec3): Promise<ActResult>
  attack(entityId: string): Promise<ActResult>
  sleep(bed: Vec3): Promise<ActResult>

  say(text: string): void

  on(event: ClientEvent, cb: (payload: JsonValue) => void): void
  capabilities(): Capability[]
}

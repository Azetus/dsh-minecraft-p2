import type { JsonValue } from '../contracts/types.ts'

/** Pure-data geometry shared by every ClientPort implementation. */
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
  /** Set by `blocksIn` entries; `blockAt` already knows the position. */
  pos?: Vec3
}

export type Item = { slot: number; name: string; count: number }

export type EntityInfo = {
  id: string
  name: string
  position: Vec3
  /** Adapter-provided entity category: player/animal/hostile/other/... */
  type?: string
  /** Human-readable category, when the adapter has one. */
  kind?: string
  username?: string
  /** Dropped item stack, resolved by the adapter when it can. */
  item?: { name: string; count: number }
}

export type BiomeInfo = {
  id: number
  name: string
}

/** A named place the adapter resolves to a position. */
export type Landmark = { name: string }

/** Read-only view of an open container/villager screen. */
export type ScreenInfo = {
  kind: string
  slots: Item[]
}

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
}

export const PortErrorCodes = {
  CAPABILITY_MISSING: 'CAPABILITY_MISSING',
  STALE_WRITE: 'STALE_WRITE',
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

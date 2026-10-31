import type { Bot, EquipmentDestination } from 'mineflayer'
import mineflayer from 'mineflayer'
import type { Movements } from 'mineflayer-pathfinder'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'

/**
 * The mineflayer module itself, re-exported for the body's authored-op bridge.
 * The body bundle must not import mineflayer statically: it reaches the
 * provider through a runtime dynamic import, and that file keeps the package
 * external so CommonJS `require` of node builtins keeps working.
 */
export const mineflayerModule: unknown = mineflayer

import type { ProviderRuntimeStatus } from '../contracts/protocol.ts'
import type { JsonValue, ValueMeta } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import type {
  ActHandle,
  ActPoll,
  ActPort,
  QueryOutcome,
  QueryPort,
} from './runtime.ts'

export type MineflayerProviderOptions = {
  actionTimeoutMs?: number
  moveDurationMs?: number
  /** How long the server age must stay unchanged before the provider treats it as paused. */
  serverIdleMs?: number
  /** Reported provider version; the body passes its own bodyVersion. */
  providerVersion?: string
}

export type MineflayerConnectionOptions = {
  host: string
  port: number
  username: string
  version?: string
  timeoutMs?: number
}

export async function connectMineflayer(options: MineflayerConnectionOptions): Promise<Bot> {
  const bot = mineflayer.createBot({
    host: options.host,
    port: options.port,
    username: options.username,
    auth: 'offline',
    version: options.version ?? '1.21.1',
    hideErrors: false,
  })
  const timeout = options.timeoutMs ?? 15_000
  return await new Promise<Bot>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      try { bot.quit('connect timeout') } catch {}
      reject(new Error(`Mineflayer connect timed out after ${timeout}ms`))
    }, timeout)
    const cleanup = (): void => {
      clearTimeout(timer)
      bot.removeListener('spawn', onSpawn)
      bot.removeListener('error', onError)
      bot.removeListener('kicked', onKicked)
      bot.removeListener('end', onEnd)
    }
    const onSpawn = (): void => {
      cleanup()
      resolve(bot)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onKicked = (reason: unknown): void => {
      cleanup()
      reject(new Error(`Mineflayer kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`))
    }
    const onEnd = (reason: unknown): void => {
      cleanup()
      reject(new Error(`Mineflayer ended before spawn: ${String(reason)}`))
    }
    bot.once('spawn', onSpawn)
    bot.once('error', onError)
    bot.once('kicked', onKicked)
    bot.once('end', onEnd)
  })
}

type BotControl = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'sneak'

const PLACE_FACES: Record<string, readonly [number, number, number]> = {
  up: [0, 1, 0],
  down: [0, -1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
}

const EQUIP_DESTINATIONS: readonly EquipmentDestination[] = ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']

/** Capabilities this provider actually implements; the op broker gates on them. */
export const PROVIDER_CAPABILITIES: readonly string[] = Object.freeze([
  'look',
  'move',
  'dig',
  'place',
  'attack',
  'equip',
  'use',
  'craft',
  'container',
  'toss',
  'sleep',
  'interact',
  'mount',
  'trade',
  'respawn',
  'pathfind',
])

/** Runtime shape of the pathfinder package (published as CommonJS). */
export type PathfinderRuntime = {
  pathfinder: (bot: Bot) => void
  Movements: new (bot: Bot) => Movements
  goals: {
    GoalNear: new (x: number, y: number, z: number, range: number) => unknown
    GoalFollow: new (entity: unknown, distance: number) => unknown
  }
}

const requireFromHere = createRequire(import.meta.url)
let pathfinderRuntime: PathfinderRuntime | undefined

/**
 * Load `mineflayer-pathfinder` through `require`.
 *
 * The package is CommonJS; a named ESM import compiles fine but throws
 * "Named export not found" at runtime once the provider is bundled. Loading it
 * lazily also keeps fake-bot unit tests working without the plugin.
 *
 * Exported for authored operations that navigate with the pathfinder directly.
 */
export function loadPathfinderRuntime(): PathfinderRuntime | undefined {
  if (pathfinderRuntime !== undefined) return pathfinderRuntime
  try {
    pathfinderRuntime = requireFromHere('mineflayer-pathfinder') as PathfinderRuntime
    return pathfinderRuntime
  } catch {
    return undefined
  }
}

/** Load the pathfinder plugin and build conservative movement settings. */
function createMovements(bot: Bot): Movements | undefined {
  const library = loadPathfinderRuntime()
  if (library === undefined) return undefined
  try {
    const loadable = bot as unknown as { loadPlugin?: (plugin: unknown) => void }
    loadable.loadPlugin?.(library.pathfinder)
    const movements = new library.Movements(bot as never)
    // Navigation must not dig or tower by itself: those are explicit acts.
    // Parkour and deep drops are off as well: a chain of legal 4-block drops was
    // enough to kill the bot during a routine goto.
    movements.canDig = false
    movements.allow1by1towers = false
    movements.allowParkour = false
    movements.allowSprinting = true
    movements.maxDropDown = 3
    return movements
  } catch {
    return undefined
  }
}

/** Provider identity reported in hello/describe/status. */
export const PROVIDER_ID = 'mineflayer'

/** Container block names the `container` operations understand. */
const CONTAINER_NAMES: readonly string[] = Object.freeze([
  'chest',
  'trapped_chest',
  'barrel',
  'furnace',
  'blast_furnace',
  'smoker',
  'dispenser',
  'crafting_table',
])

function meta(source: ValueMeta['source'], scope: string, sampledAt = Date.now()): ValueMeta {
  return { source, scope, sampledAt, validUntil: sampledAt + 1000 }
}

function isAirName(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

function isFluidName(name: string): boolean {
  return name === 'water' || name === 'flowing_water' || name === 'lava' || name === 'flowing_lava'
}

function clampNumber(value: JsonValue | undefined, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/** Stable ordering for optional text fields; missing values sort last. */
function compareNullableText(left: string | null, right: string | null): number {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left < right ? -1 : 1
}

function blockPosition(args: Record<string, JsonValue>): { x: number; y: number; z: number } | undefined {
  const { x, y, z } = args
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return undefined
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/**
 * The trading window fills its offers asynchronously; mineflayer documents a
 * `ready` event for that. Wait for it (bounded) before reading trades.
 */
async function waitVillagerReady(window: AnyWindow, timeoutMs = 2000): Promise<void> {
  if (Array.isArray(window.trades) && window.trades.length > 0) return
  if (typeof window.once !== 'function') return
  await new Promise<void>(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    try {
      window.once?.('ready', finish)
    } catch {
      finish()
      return
    }
    setTimeout(finish, timeoutMs)
  })
}

/** Structural view of a container/villager window; only the fields we use. */
type AnyWindow = {
  slots?: Array<{ slot?: number; name: string; count: number } | null>
  /** Documented prismarine-windows helper: items of the container (top) section. */
  containerItems?: () => Array<{ slot?: number; name: string; count: number }>
  /** Documented prismarine-windows helper: item count in the inventory section. */
  count?: (itemType: number, metadata?: number | null) => number
  /** Documented prismarine-windows property: first slot of the player inventory. */
  inventoryStart?: number
  once?: (event: string, listener: () => void) => void
  fuel?: number
  progress?: number
  trades?: Array<{
    inputItem1?: { name: string; count: number } | null
    inputItem2?: { name: string; count: number } | null
    outputItem?: { name: string; count: number } | null
    tradeDisabled?: boolean
    nbTradeUses?: number
    maximumNbTradeUses?: number
  }>
  deposit?: (itemType: number, metadata: number | null, count: number | null) => Promise<void>
  withdraw?: (itemType: number, metadata: number | null, count: number | null) => Promise<void>
  putInput?: (itemType: number, metadata: number | null, count: number) => Promise<void>
  putFuel?: (itemType: number, metadata: number | null, count: number) => Promise<void>
  takeInput?: () => Promise<unknown>
  takeFuel?: () => Promise<unknown>
  takeOutput?: () => Promise<unknown>
  close?: () => Promise<void>
}

function openContainerWindow(bot: Bot, block: Parameters<Bot['openFurnace']>[0]): Promise<AnyWindow> {
  if (block.name === 'furnace' || block.name === 'blast_furnace' || block.name === 'smoker') {
    return bot.openFurnace(block) as unknown as Promise<AnyWindow>
  }
  return bot.openContainer(block) as unknown as Promise<AnyWindow>
}

async function closeWindowQuietly(window: AnyWindow | null | undefined): Promise<void> {
  try {
    await window?.close?.()
  } catch {
    // The server may already have closed the window; that is not a failure here.
  }
}

/** Query/act adapter over one connected Mineflayer bot. */
export class MineflayerProvider implements ActPort {
  readonly capabilities = PROVIDER_CAPABILITIES
  readonly providerId = PROVIDER_ID
  readonly providerVersion: string

  private current: ActHandle | undefined
  private disconnected: Error | undefined
  private paused = false
  private lastDeath: { at: number; position: { x: number; y: number; z: number } | null } | undefined
  private lastServerAge: number | undefined
  private lastServerAgeAt = 0
  private readonly pauseTimer: ReturnType<typeof setInterval>
  private readonly options: Required<MineflayerProviderOptions>
  private readonly movements: Movements | undefined

  constructor(
    private readonly bot: Bot,
    options: MineflayerProviderOptions = {},
  ) {
    this.options = {
      actionTimeoutMs: options.actionTimeoutMs ?? 600_000,
      moveDurationMs: options.moveDurationMs ?? 700,
      serverIdleMs: options.serverIdleMs ?? 1500,
      providerVersion: options.providerVersion ?? '0',
    }
    this.providerVersion = this.options.providerVersion
    this.movements = createMovements(this.bot)
    this.pauseTimer = setInterval(() => this.refreshPauseState(), 250)
    this.pauseTimer.unref?.()
    bot.once('end', reason => {
      clearInterval(this.pauseTimer)
      this.disconnected = new Error(`Mineflayer connection ended: ${String(reason)}`)
      this.bot.clearControlStates()
      const current = this.current as (ActHandle & { abort?: (error: Error, code?: string) => void }) | undefined
      current?.abort?.(this.disconnected, 'CONNECTION_LOST')
    })
    bot.on('death', () => {
      this.bot.clearControlStates()
      const position = this.bot.entity?.position
      this.lastDeath = {
        at: Date.now(),
        position: position === undefined ? null : { x: position.x, y: position.y, z: position.z },
      }
      const current = this.current as (ActHandle & { abort?: (error: Error, code?: string) => void }) | undefined
      current?.abort?.(new Error('the bot died'), 'DEATH')
    })
    bot.on('error', error => {
      clearInterval(this.pauseTimer)
      this.disconnected = error instanceof Error ? error : new Error(String(error))
      this.bot.clearControlStates()
      const current = this.current as (ActHandle & { abort?: (error: Error, code?: string) => void }) | undefined
      current?.abort?.(this.disconnected, 'CONNECTION_LOST')
    })
  }

  /** Server world age, or null when the client has no time packet yet. */
  serverAge(): number | null {
    const age = this.bot.time?.age
    if (typeof age === 'number') return age
    if (typeof age === 'bigint') return Number(age)
    return null
  }

  liveStatus(): ProviderRuntimeStatus {
    const serverAge = this.serverAge()
    const current = this.current as MineflayerActHandle | undefined
    return {
      connected: this.disconnected === undefined,
      paused: this.paused,
      serverAge,
      idleMs: this.paused && this.lastServerAgeAt > 0 ? Date.now() - this.lastServerAgeAt : 0,
      controlState: this.controlState(),
      controlRelease: current?.controlRelease() ?? null,
      lastDeathAt: this.lastDeath?.at ?? null,
      lastDeathPosition: this.lastDeath?.position ?? null,
    }
  }

  /**
   * Release verdict for the operation broker. A disconnected client cannot
   * observe its effects, so the state stays `unknown` instead of claiming idle.
   */
  controlState(): 'idle' | 'active' | 'unknown' {
    if (this.disconnected !== undefined) return 'unknown'
    const current = this.current as MineflayerActHandle | undefined
    return current === undefined ? 'idle' : current.controlState()
  }

  /**
   * Apply the server-age watchdog at a deterministic instant.
   * A stalled age means `/tick freeze` or a server that is not ticking; the
   * current act is aborted and world queries fail closed until age advances.
   */
  refreshPauseState(now = Date.now()): void {
    if (this.disconnected !== undefined) return
    const age = this.serverAge()
    if (age === null) return
    if (this.lastServerAge === undefined) {
      this.lastServerAge = age
      this.lastServerAgeAt = now
      return
    }
    if (age !== this.lastServerAge) {
      this.lastServerAge = age
      this.lastServerAgeAt = now
      this.paused = false
      return
    }
    if (!this.paused && now - this.lastServerAgeAt >= this.options.serverIdleMs) {
      this.paused = true
      this.bot.clearControlStates()
      const current = this.current as (ActHandle & { abort?: (error: Error, code?: string) => void }) | undefined
      current?.abort?.(new Error('server ticks are paused'), 'GAME_PAUSED')
    }
  }

  private queryMeta(scope: string, sampledAt: number): ValueMeta {
    const result = meta('query', scope, sampledAt)
    const serverAge = this.serverAge()
    return {
      ...result,
      ...(serverAge === null ? {} : { serverAge }),
      paused: this.paused,
    }
  }

  /** Operator rescue channel; commands are normalized and allow-listed by the body. */
  sendCommand(command: string): void {
    if (this.disconnected !== undefined) {
      throw p2Error('CONNECTION_LOST', 'environment', this.disconnected.message, { module: 'provider.mineflayer' })
    }
    if (!command.startsWith('/') || command.length > 200 || /[\r\n]/u.test(command)) {
      throw p2Error('RESCUE_COMMAND_INVALID', 'validation', 'rescue command is not a single chat command', { module: 'provider.mineflayer' })
    }
    this.bot.chat(command)
  }

  private entityView(entity: unknown, origin: { x: number; y: number; z: number } | undefined): {
    id: number
    name: string | null
    displayName: string | null
    type: string | null
    kind: string | null
    objectType: string | null
    item: { itemId: number; count: number } | null
    position: { x: number; y: number; z: number } | null
    distance: number | null
  } {
    const record = entity as {
      id?: number
      name?: string
      displayName?: string
      type?: string
      kind?: string
      objectType?: string
      position?: { x: number; y: number; z: number }
      metadata?: Record<number, unknown>
    }
    const metadataItem = record.metadata?.[8]
    const item = typeof metadataItem === 'object' && metadataItem !== null
      && typeof (metadataItem as { itemId?: unknown }).itemId === 'number'
      ? {
          itemId: (metadataItem as { itemId: number }).itemId,
          count: typeof (metadataItem as { itemCount?: unknown }).itemCount === 'number'
            ? (metadataItem as { itemCount: number }).itemCount
            : 1,
        }
      : null
    const position = record.position
    return {
      id: record.id ?? -1,
      name: record.name ?? null,
      displayName: record.displayName ?? null,
      type: record.type ?? null,
      kind: record.kind ?? null,
      objectType: record.objectType ?? null,
      item,
      position: position === undefined ? null : { x: position.x, y: position.y, z: position.z },
      distance: position === undefined || origin === undefined
        ? null
        : Math.hypot(origin.x - position.x, origin.y - position.y, origin.z - position.z),
    }
  }

  private itemName(id: number): string {
    const registry = this.bot.registry as unknown as { items?: Record<number, { name?: string }> }
    return registry.items?.[id]?.name ?? `item:${id}`
  }

  private itemTypeId(name: string): number | undefined {
    const registry = this.bot.registry as unknown as { itemsByName?: Record<string, { id?: number }> }
    return registry.itemsByName?.[name]?.id
  }

  private inventoryCount(name: string): number {
    return this.bot.inventory.items()
      .filter(item => item.name === name)
      .reduce((total, item) => total + item.count, 0)
  }

  private openWindowFor(block: Parameters<Bot['openFurnace']>[0]): Promise<AnyWindow> {
    return openContainerWindow(this.bot, block)
  }

  private async closeWindow(window: AnyWindow): Promise<void> {
    await closeWindowQuietly(window)
  }

  private closeOpenWindow(): void {
    const current = this.bot.currentWindow as unknown as AnyWindow | null
    if (current === null) return
    void this.closeWindow(current)
  }

  private snapshotWindow(kind: string, window: AnyWindow): JsonValue {
    const slots = Array.isArray(window.slots) ? window.slots : []
    // `window.containerItems()` is the documented prismarine-windows helper for
    // the container (top) section; fall back to slicing at `inventoryStart`.
    const containerItems = typeof window.containerItems === 'function' ? window.containerItems() : undefined
    const items: JsonValue[] = []
    let containerSlots = typeof window.inventoryStart === 'number' ? window.inventoryStart : slots.length
    if (Array.isArray(containerItems)) {
      for (const item of containerItems) {
        const slot = typeof item.slot === 'number' ? item.slot : -1
        items.push({ slot, name: item.name, count: item.count })
      }
    } else {
      containerSlots = Math.min(containerSlots, slots.length)
      for (let index = 0; index < containerSlots; index += 1) {
        const item = slots[index]
        if (item === null || item === undefined) continue
        items.push({ slot: index, name: item.name, count: item.count })
      }
    }
    const value: Record<string, JsonValue> = { kind, containerSlots, slots: items }
    if (typeof window.fuel === 'number') value.fuel = window.fuel
    if (typeof window.progress === 'number') value.progress = window.progress
    if (Array.isArray(window.trades)) value.trades = this.snapshotTrades(window)
    return value
  }

  private snapshotTrades(window: AnyWindow): JsonValue {
    const trades = Array.isArray(window.trades) ? window.trades : []
    const item = (value: { name: string; count: number } | null | undefined): JsonValue =>
      value === null || value === undefined ? null : { name: value.name, count: value.count }
    return trades.map((trade, index) => ({
      index,
      input1: item(trade.inputItem1),
      input2: item(trade.inputItem2),
      output: item(trade.outputItem),
      disabled: trade.tradeDisabled === true,
      uses: typeof trade.nbTradeUses === 'number' ? trade.nbTradeUses : null,
      maxUses: typeof trade.maximumNbTradeUses === 'number' ? trade.maximumNbTradeUses : null,
    }))
  }

  /**
   * Open a container window for a read-only snapshot. Window opening is async,
   * so the query resolves as `pending` and is polled by the executor.
   */
  private pendingWindowQuery(
    block: Parameters<Bot['openFurnace']>[0],
    snapshot: (window: AnyWindow) => JsonValue,
  ): QueryOutcome {
    const sampledAt = Date.now()
    const deadline = sampledAt + 3000
    let outcome: QueryOutcome | undefined
    void (async () => {
      try {
        const window = await this.openWindowFor(block)
        try {
          outcome = { status: 'ok', value: snapshot(window), meta: this.queryMeta('mineflayer.container', sampledAt) }
        } finally {
          await this.closeWindow(window)
        }
      } catch (error) {
        outcome = {
          status: 'failed',
          error: p2Error('CONTAINER_FAILED', 'environment', errorMessage(error), { module: 'provider.mineflayer' }),
        }
      }
    })()
    const poll = (): QueryOutcome => {
      if (outcome !== undefined) return outcome
      if (Date.now() > deadline) {
        this.closeOpenWindow()
        return {
          status: 'failed',
          error: p2Error('CONTAINER_TIMEOUT', 'timeout', 'container window did not open in time', { module: 'provider.mineflayer' }),
        }
      }
      return { status: 'pending', poll }
    }
    return poll()
  }

  private pendingVillagerQuery(entity: unknown): QueryOutcome {
    const sampledAt = Date.now()
    const deadline = sampledAt + 3000
    let outcome: QueryOutcome | undefined
    void (async () => {
      try {
        const window = await this.bot.openVillager(entity as Parameters<Bot['openVillager']>[0]) as unknown as AnyWindow
        try {
          await waitVillagerReady(window)
          outcome = { status: 'ok', value: this.snapshotTrades(window), meta: this.queryMeta('mineflayer.offers', sampledAt) }
        } finally {
          await this.closeWindow(window)
        }
      } catch (error) {
        outcome = {
          status: 'failed',
          error: p2Error('OFFERS_FAILED', 'environment', errorMessage(error), { module: 'provider.mineflayer' }),
        }
      }
    })()
    const poll = (): QueryOutcome => {
      if (outcome !== undefined) return outcome
      if (Date.now() > deadline) {
        this.closeOpenWindow()
        return {
          status: 'failed',
          error: p2Error('OFFERS_TIMEOUT', 'timeout', 'villager window did not open in time', { module: 'provider.mineflayer' }),
        }
      }
      return { status: 'pending', poll }
    }
    return poll()
  }

  queryPort(): QueryPort {
    return (ref, args) => this.query(ref.op, args)
  }

  query(op: string, args: Record<string, JsonValue> = {}): QueryOutcome {
    if (this.disconnected !== undefined) {
      return {
        status: 'failed',
        error: p2Error('CONNECTION_LOST', 'environment', this.disconnected.message, { module: 'provider.mineflayer' }),
      }
    }
    this.refreshPauseState()
    if (this.paused && op !== 'time') {
      return {
        status: 'failed',
        error: p2Error(
          'GAME_PAUSED',
          'environment',
          'server ticks are not advancing; world queries are unavailable while paused',
          { module: 'provider.mineflayer' },
          { serverAge: this.serverAge(), idleMs: this.liveStatus().idleMs },
        ),
      }
    }
    const sampledAt = Date.now()
    try {
      switch (op) {
        case 'position': {
          const position = this.bot.entity?.position
          if (position === undefined) {
            return { status: 'failed', error: p2Error('POSITION_UNAVAILABLE', 'environment', 'bot position is not available', { module: 'provider.mineflayer' }) }
          }
          const entity = this.bot.entity as unknown as {
            yaw?: number
            pitch?: number
            onGround?: boolean
            isInWater?: boolean
            isInLava?: boolean
          }
          return {
            status: 'ok',
            value: {
              x: position.x,
              y: position.y,
              z: position.z,
              dimension: this.bot.game?.dimension ?? null,
              yaw: typeof entity.yaw === 'number' ? entity.yaw : null,
              pitch: typeof entity.pitch === 'number' ? entity.pitch : null,
              onGround: typeof entity.onGround === 'boolean' ? entity.onGround : null,
              inWater: typeof entity.isInWater === 'boolean' ? entity.isInWater : null,
              inLava: typeof entity.isInLava === 'boolean' ? entity.isInLava : null,
            },
            meta: this.queryMeta('mineflayer.position', sampledAt),
          }
        }
        case 'spawn': {
          // Read-only: `spawn_position` is the world spawn carried by the
          // protocol. Vanilla 1.21.1 never sends a client-visible personal
          // respawn point, so the body also reports what trusted content has
          // observed from a real sleep/respawn cycle (stored on the bot object
          // by the content itself). Missing tracking stays null, never false.
          const point = (this.bot as unknown as { spawnPoint?: { x: number; y: number; z: number } }).spawnPoint
          const tracked = (this.bot as unknown as {
            __p2?: { lastSleepBed?: JsonValue; respawnCheck?: JsonValue }
          }).__p2
          return {
            status: 'ok',
            value: {
              worldSpawn: point === undefined ? null : { x: point.x, y: point.y, z: point.z },
              dimension: this.bot.game?.dimension ?? null,
              lastSleepBed: tracked?.lastSleepBed ?? null,
              respawnCheck: tracked?.respawnCheck ?? null,
            },
            meta: this.queryMeta('mineflayer.spawn', sampledAt),
          }
        }
        case 'inventory': {
          return {
            status: 'ok',
            value: this.bot.inventory.items().map(item => ({ name: item.name, count: item.count })),
            meta: this.queryMeta('mineflayer.inventory', sampledAt),
          }
        }
        case 'health': {
          const slots = this.bot.inventory.slots ?? []
          const armor = [5, 6, 7, 8]
            .map(slot => {
              const item = slots[slot]
              return item === null || item === undefined ? null : { slot, name: item.name, count: item.count }
            })
            .filter((entry): entry is { slot: number; name: string; count: number } => entry !== null)
          return {
            status: 'ok',
            value: {
              health: this.bot.health ?? null,
              food: this.bot.food ?? null,
              saturation: this.bot.foodSaturation ?? null,
              oxygen: this.bot.oxygenLevel ?? null,
              armor,
            },
            meta: this.queryMeta('mineflayer.health', sampledAt),
          }
        }
        case 'entities': {
          const objectTypeFilter = typeof args.objectType === 'string' ? args.objectType : undefined
          const nameFilter = typeof args.name === 'string' ? args.name : undefined
          const typeFilter = typeof args.type === 'string' ? args.type : undefined
          const hostileOnly = args.hostileOnly === true
          const maxDistance = typeof args.maxDistance === 'number' && Number.isFinite(args.maxDistance)
            ? Math.max(0, args.maxDistance)
            : undefined
          const limit = clampNumber(args.count, 64, 1, 256)
          const sort = args.sort === 'name' || args.sort === 'type' || args.sort === 'distance' ? args.sort : 'distance'
          const descending = args.descending === true
          const origin = this.bot.entity?.position
          const entities = Object.values(this.bot.entities)
            .filter(entity => objectTypeFilter === undefined || (entity as unknown as { objectType?: string }).objectType === objectTypeFilter)
            .filter(entity => typeFilter === undefined || entity.type === typeFilter)
            .filter(entity => nameFilter === undefined || entity.name === nameFilter)
            .filter(entity => !hostileOnly || (entity as unknown as { kind?: string }).kind === 'Hostile mobs')
            .map(entity => this.entityView(entity, origin))
            .filter(entry => maxDistance === undefined || entry.distance === null || entry.distance <= maxDistance)
            .sort((left, right) => {
              const compared = sort === 'name'
                ? compareNullableText(left.name, right.name)
                : sort === 'type'
                  ? compareNullableText(left.type, right.type)
                  : (left.distance ?? Number.POSITIVE_INFINITY) - (right.distance ?? Number.POSITIVE_INFINITY)
              return descending ? -compared : compared
            })
            .slice(0, limit)
          return {
            status: 'ok',
            value: entities,
            meta: this.queryMeta('mineflayer.entities', sampledAt),
          }
        }
        case 'blocks': {
          const namesArg = args.names
          const rawNames = Array.isArray(namesArg)
            ? namesArg.filter((name): name is string => typeof name === 'string')
            : typeof namesArg === 'string'
              ? [namesArg]
              : []
          const names = rawNames.map(name => name.replace(/^minecraft:/u, ''))
          const radius = clampNumber(args.radius, 16, 1, 32)
          const count = clampNumber(args.count, 16, 1, 64)
          const yMin = typeof args.yMin === 'number' ? args.yMin : undefined
          const yMax = typeof args.yMax === 'number' ? args.yMax : undefined
          // `exposed` keeps only blocks with at least one air neighbour, which is
          // what a player could actually see or reach. Without it a query returns
          // buried ores too, because findBlocks scans whole chunk sections.
          const exposed = args.exposed === true
          const registry = (this.bot.registry?.blocksByName ?? {}) as unknown as Record<string, { id: number } | undefined>
          const ids = names
            .map(name => registry[name]?.id)
            .filter((id): id is number => typeof id === 'number')
          if (names.length > 0 && ids.length === 0) {
            return { status: 'ok', value: [], meta: this.queryMeta('mineflayer.blocks', sampledAt) }
          }
          const matching = ids.length > 0 ? ids : (block: { name: string }) => !isAirName(block.name)
          // findBlocks only returns the nearest N candidates, so a y filter needs a
          // wider candidate window before the (post-)filter; otherwise the layer the
          // caller asked for is silently missing. The exposed filter has the same
          // problem: most candidates can be buried.
          const narrowed = yMin !== undefined || yMax !== undefined || exposed
          const candidateCount = narrowed ? Math.min(2048, Math.max(256, count * 32)) : Math.min(256, Math.max(64, count * 4))
          const found = this.bot.findBlocks({ matching, maxDistance: radius, count: candidateCount })
          const position = this.bot.entity?.position
          const blocks = found
            .filter(point => (yMin === undefined || point.y >= yMin) && (yMax === undefined || point.y <= yMax))
            .filter(point => !exposed || this.isExposedBlock(point.x, point.y, point.z))
            .map(point => {
              const block = this.bot.blockAt(point)
              if (block === null) return null
              return {
                name: block.name,
                x: point.x,
                y: point.y,
                z: point.z,
                distance: position === undefined ? 0 : Math.hypot(position.x - point.x, position.y - point.y, position.z - point.z),
              }
            })
            .filter((entry): entry is { name: string; x: number; y: number; z: number; distance: number } => entry !== null)
            .sort((left, right) => left.distance - right.distance)
            .slice(0, count)
          return { status: 'ok', value: blocks, meta: this.queryMeta('mineflayer.blocks', sampledAt) }
        }
        case 'time': {
          return {
            status: 'ok',
            value: {
              timeOfDay: typeof this.bot.time?.timeOfDay === 'bigint'
                ? Number(this.bot.time.timeOfDay)
                : this.bot.time?.timeOfDay ?? null,
              age: this.serverAge(),
              paused: this.paused,
              doDaylightCycle: this.bot.time?.doDaylightCycle ?? null,
              difficulty: this.bot.game?.difficulty ?? null,
            },
            meta: this.queryMeta('mineflayer.time', sampledAt),
          }
        }
        case 'block': {
          const x = typeof args.x === 'number' ? args.x : this.bot.entity?.position.x
          const y = typeof args.y === 'number' ? args.y : this.bot.entity?.position.y
          const z = typeof args.z === 'number' ? args.z : this.bot.entity?.position.z
          if (x === undefined || y === undefined || z === undefined) {
            return { status: 'failed', error: p2Error('BLOCK_UNAVAILABLE', 'environment', 'block coordinates are unavailable', { module: 'provider.mineflayer' }) }
          }
          const block = this.bot.blockAt(new Vec3(x, y, z))
          return {
            status: 'ok',
            value: block === null ? null : { name: block.name, x: block.position.x, y: block.position.y, z: block.position.z },
            meta: this.queryMeta('mineflayer.block', sampledAt),
          }
        }
        case 'equipment': {
          const slots = this.bot.inventory.slots ?? []
          const describe = (slot: number): { slot: number; name: string; count: number } | null => {
            const item = slots[slot]
            return item === null || item === undefined ? null : { slot, name: item.name, count: item.count }
          }
          const armor = [5, 6, 7, 8].map(describe).filter((entry): entry is { slot: number; name: string; count: number } => entry !== null)
          const held = this.bot.heldItem
          const offhand = describe(45)
          return {
            status: 'ok',
            value: {
              held: held === null || held === undefined ? null : { name: held.name, count: held.count },
              offhand,
              armor,
              quickBarSlot: typeof this.bot.quickBarSlot === 'number' ? this.bot.quickBarSlot : null,
            },
            meta: this.queryMeta('mineflayer.equipment', sampledAt),
          }
        }
        case 'entity': {
          const entityId = typeof args.id === 'number' ? Math.floor(args.id) : Number.NaN
          const entity = Number.isFinite(entityId) ? this.bot.entities[entityId] : undefined
          return {
            status: 'ok',
            value: entity === undefined ? null : this.entityView(entity, this.bot.entity?.position),
            meta: this.queryMeta('mineflayer.entity', sampledAt),
          }
        }
        case 'players': {
          const origin = this.bot.entity?.position
          const maxDistance = typeof args.maxDistance === 'number' && Number.isFinite(args.maxDistance)
            ? Math.max(0, args.maxDistance)
            : undefined
          const players = Object.entries(this.bot.players ?? {}).map(([username, player]) => {
            const entity = (player as unknown as { entity?: { position?: { x: number; y: number; z: number } } }).entity
            const position = entity?.position
            const value = position === undefined
              ? null
              : { x: position.x, y: position.y, z: position.z }
            return {
              name: username,
              uuid: (player as unknown as { uuid?: string }).uuid ?? null,
              position: value,
              dimension: this.bot.game?.dimension ?? null,
              distance: value === null || origin === undefined
                ? null
                : Math.hypot(origin.x - value.x, origin.y - value.y, origin.z - value.z),
            }
          })
            .filter(entry => maxDistance === undefined || entry.distance === null || entry.distance <= maxDistance)
            .sort((left, right) => (left.distance ?? Number.POSITIVE_INFINITY) - (right.distance ?? Number.POSITIVE_INFINITY))
          return { status: 'ok', value: players, meta: this.queryMeta('mineflayer.players', sampledAt) }
        }
        case 'recipe': {
          const name = typeof args.item === 'string' ? args.item.replace(/^minecraft:/u, '') : ''
          const itemType = name.length === 0 ? undefined : this.itemTypeId(name)
          if (itemType === undefined) {
            return {
              status: 'failed',
              error: p2Error('RECIPE_UNKNOWN_ITEM', 'validation', `unknown item: ${String(args.item)}`, { module: 'provider.mineflayer' }),
            }
          }
          const recipes = this.bot.recipesAll(itemType, null, true).map(recipe => {
            const ingredients = recipe.delta
              .filter(entry => entry.count < 0)
              .map(entry => ({ item: this.itemName(entry.id), count: -entry.count }))
            return {
              result: { item: this.itemName(recipe.result.id), count: recipe.result.count },
              requiresTable: recipe.requiresTable,
              ingredients,
              craftable: ingredients.every(entry => this.inventoryCount(entry.item) >= entry.count),
            }
          })
          const value = args.craftableOnly === true ? recipes.filter(entry => entry.craftable) : recipes
          return { status: 'ok', value, meta: this.queryMeta('mineflayer.recipe', sampledAt) }
        }
        case 'container': {
          const position = blockPosition(args)
          if (position === undefined) {
            return {
              status: 'failed',
              error: p2Error('CONTAINER_NO_POSITION', 'validation', 'container requires numeric x, y and z', { module: 'provider.mineflayer' }),
            }
          }
          const block = this.bot.blockAt(new Vec3(position.x, position.y, position.z))
          if (block === null || isAirName(block.name)) {
            return {
              status: 'failed',
              error: p2Error('CONTAINER_NO_BLOCK', 'environment', `no container block at ${position.x},${position.y},${position.z}`, { module: 'provider.mineflayer' }),
            }
          }
          if (!CONTAINER_NAMES.includes(block.name)) {
            return {
              status: 'failed',
              error: p2Error('CONTAINER_UNSUPPORTED', 'validation', `${block.name} is not a supported container`, { module: 'provider.mineflayer' }),
            }
          }
          return this.pendingWindowQuery(block, window => this.snapshotWindow(block.name, window))
        }
        case 'offers': {
          const entityId = typeof args.entityId === 'number' ? Math.floor(args.entityId) : Number.NaN
          const entity = Number.isFinite(entityId) ? this.bot.entities[entityId] : undefined
          if (entity === undefined) {
            return {
              status: 'failed',
              error: p2Error('OFFERS_NO_ENTITY', 'environment', `no entity with id ${String(args.entityId)}`, { module: 'provider.mineflayer' }),
            }
          }
          return this.pendingVillagerQuery(entity)
        }
        case 'weather': {
          return {
            status: 'ok',
            value: {
              raining: typeof this.bot.isRaining === 'boolean' ? this.bot.isRaining : null,
              thundering: typeof this.bot.thunderState === 'number' ? this.bot.thunderState > 0 : null,
              thunderState: typeof this.bot.thunderState === 'number' ? this.bot.thunderState : null,
            },
            meta: this.queryMeta('mineflayer.weather', sampledAt),
          }
        }
        default:
          return {
            status: 'failed',
            error: p2Error('QUERY_UNSUPPORTED', 'validation', `unsupported query: ${op}`, { module: 'provider.mineflayer' }),
          }
      }
    } catch (error) {
      return {
        status: 'failed',
        error: p2Error('QUERY_FAILED', 'environment', error instanceof Error ? error.message : String(error), { module: 'provider.mineflayer' }),
      }
    }
  }

  start(name: string, args: Record<string, JsonValue>): ActHandle {
    if (this.disconnected !== undefined) {
      throw p2Error('CONNECTION_LOST', 'environment', this.disconnected.message, { module: 'provider.mineflayer' })
    }
    this.refreshPauseState()
    if (this.paused) {
      throw p2Error(
        'GAME_PAUSED',
        'environment',
        'cannot start an act while server ticks are paused',
        { module: 'provider.mineflayer', nodePath: name },
        { serverAge: this.serverAge(), idleMs: this.liveStatus().idleMs },
      )
    }
    if (name !== 'stop' && this.current !== undefined && this.current.poll().status === 'running') {
      throw p2Error('ACT_BUSY', 'runtime', 'another Mineflayer act is running', { module: 'provider.mineflayer' })
    }
    const handle = new MineflayerActHandle(name, args, this.bot, this.options, this.movements)
    this.current = handle
    return handle
  }

  /** True when at least one of the six neighbours of a block is air. */
  private isExposedBlock(x: number, y: number, z: number): boolean {
    const offsets: ReadonlyArray<readonly [number, number, number]> = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ]
    for (const [dx, dy, dz] of offsets) {
      const neighbor = this.bot.blockAt(new Vec3(x + dx, y + dy, z + dz))
      if (neighbor !== null && isAirName(neighbor.name)) return true
    }
    return false
  }
}

class MineflayerActHandle implements ActHandle {
  private result: JsonValue | undefined
  private failed: Error | undefined
  private failedCode = 'ACT_FAILED'
  /** Set only after release is observed; never merely because stop was requested. */
  private cancelled = false
  private completed = false
  private releaseUnknown = false
  /** A stop was requested; input may still be in flight until release is proven. */
  private stopRequested = false
  /** The async craft chain is still between recipes, so release is not proven. */
  private craftRunning = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly startedAt = Date.now()
  private wasAirborne = false
  private moveTarget: {
    x: number
    z: number
    tolerance: number
    timeoutMs: number
    blockedMs: number
  } | undefined
  private lastDistance = Number.POSITIVE_INFINITY
  private lastProgressAt = Date.now()
  private lastLookAt = 0
  private lastJumpAt = 0

  constructor(
    private readonly name: string,
    private readonly args: Record<string, JsonValue>,
    private readonly bot: Bot,
    private readonly options: Required<MineflayerProviderOptions>,
    private readonly movements: Movements | undefined,
  ) {
    this.run()
  }

  poll(): ActPoll {
    if (this.stopRequested && !this.cancelled) this.refreshRelease()
    if (this.cancelled) return { status: 'cancelled' }
    if (this.failed !== undefined) {
      return {
        status: 'failed',
        error: p2Error(this.failedCode, actErrorCategory(this.failedCode), this.failed.message, { module: 'provider.mineflayer', nodePath: this.name }),
      }
    }
    if (!this.completed && this.name === 'jump') {
      if (this.bot.entity?.onGround === false) this.wasAirborne = true
      if (this.wasAirborne && this.bot.entity?.onGround === true) {
        this.result = this.position()
        this.completed = true
      }
    }
    if (!this.completed && this.failed === undefined && this.name === 'moveTo') {
      this.pollMoveTo()
    }
    if (!this.completed && Date.now() - this.startedAt > this.options.actionTimeoutMs) {
      this.failed = new Error(`act ${this.name} timed out`)
      this.failedCode = 'ACT_TIMEOUT'
    }
    if (this.completed) {
      return this.result === undefined
        ? { status: 'succeeded', meta: meta('act', `mineflayer.${this.name}`) }
        : { status: 'succeeded', result: this.result, meta: meta('act', `mineflayer.${this.name}`) }
    }
    if (this.failed !== undefined) {
      return {
        status: 'failed',
        error: p2Error(this.failedCode, actErrorCategory(this.failedCode), this.failed.message, { module: 'provider.mineflayer', nodePath: this.name }),
      }
    }
    return { status: 'running' }
  }

  stop(): void {
    if (this.stopRequested || this.completed) return
    this.stopRequested = true
    let unknown = false
    const attempt = (fn: () => void): void => {
      try {
        fn()
      } catch {
        // A failed cleanup means release cannot be confirmed for this handle.
        unknown = true
      }
    }
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.name === 'dig') attempt(() => this.bot.stopDigging())
    if (this.name === 'use') attempt(() => this.bot.deactivateItem())
    if (this.name === 'goto' || this.name === 'follow') {
      attempt(() => (this.bot as unknown as { pathfinder?: { stop(): void } }).pathfinder?.stop() ?? undefined)
    }
    if (this.name === 'drive') attempt(() => this.bot.moveVehicle(0, 0))
    if (this.name === 'fish') attempt(() => this.bot.deactivateItem())
    if (this.name === 'sleep') {
      // Documented way out of a bed; stop() must not leave the bot asleep.
      attempt(() => { void this.bot.wake() })
    }
    if (this.name === 'pillar') attempt(() => this.bot.setControlState('jump', false))
    attempt(() => this.bot.clearControlStates())
    this.releaseUnknown = unknown
    // A cancel flag alone never proves the effect is gone: confirm only what
    // the provider can still observe (pathfinder path, dig target, craft loop).
    this.refreshRelease()
  }

  /**
   * Fold the observable control state into a release conclusion. Until this
   * succeeds the handle keeps reporting `running`/`active`, which is what makes
   * a lazy pathfinder stop visible instead of a false "already stopped".
   */
  private refreshRelease(): void {
    if (!this.stopRequested || this.cancelled || this.releaseUnknown) return
    try {
      if (this.releaseObserved()) this.cancelled = true
    } catch {
      this.releaseUnknown = true
    }
  }

  private releaseObserved(): boolean {
    if (this.name === 'goto' || this.name === 'follow') {
      const pathfinder = (this.bot as unknown as { pathfinder?: { isMoving?: () => boolean } }).pathfinder
      // `stop()` only sets a flag; the path is cleared on the next physics tick.
      if (typeof pathfinder?.isMoving === 'function' && pathfinder.isMoving() === true) return false
    }
    if (this.name === 'dig') {
      const target = (this.bot as unknown as { targetDigBlock?: unknown }).targetDigBlock
      if (target !== null && target !== undefined) return false
    }
    if (this.name === 'craft' && this.craftRunning) return false
    if (this.name === 'sleep' && (this.bot as unknown as { isSleeping?: boolean }).isSleeping === true) return false
    const getControlState = (this.bot as unknown as { getControlState?: (name: string) => boolean }).getControlState
    if (typeof getControlState === 'function') {
      for (const state of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'] as const) {
        if (getControlState.call(this.bot, state) === true) return false
      }
    }
    return true
  }

  /** `unknown` is sticky: a cancel flag alone never proves the effect is gone. */
  controlState(): 'idle' | 'active' | 'unknown' {
    if (this.releaseUnknown) return 'unknown'
    if (this.cancelled || this.completed) return 'idle'
    if (this.failed !== undefined) {
      // A failed act can still leave a pathfinder path behind; only report idle
      // when the provider can no longer observe an effect.
      try {
        return this.releaseObserved() ? 'idle' : 'active'
      } catch {
        return 'unknown'
      }
    }
    if (this.stopRequested) this.refreshRelease()
    return this.cancelled ? 'idle' : 'active'
  }

  controlRelease(): 'confirmed' | 'best-effort' | null {
    if (this.releaseUnknown) return 'best-effort'
    if (this.cancelled || this.completed) return 'confirmed'
    return null
  }

  abort(error: Error, code = 'ACT_FAILED'): void {
    if (this.cancelled || this.completed) return
    this.failed = error
    this.failedCode = code
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.name === 'use') {
      try { this.bot.deactivateItem() } catch { /* the connection may already be gone */ }
    }
    this.bot.clearControlStates()
  }

  private run(): void {
    try {
      switch (this.name) {
        case 'look': {
          const yaw = typeof this.args.yaw === 'number' ? this.args.yaw : 0
          const pitch = typeof this.args.pitch === 'number' ? this.args.pitch : 0
          void this.bot.look(yaw, pitch, true).then(() => {
            this.result = { yaw, pitch }
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
          })
          return
        }
        case 'move':
        case 'forward':
        case 'back':
        case 'left':
        case 'right': {
          // `move` takes an explicit direction; the four aliases exist so a
          // behavior can express a plain walk without knowing the enum.
          const direction = this.name === 'move'
            ? (typeof this.args.direction === 'string' ? this.args.direction : 'forward')
            : this.name
          if (!isControl(direction)) throw new Error(`unsupported move direction: ${direction}`)
          this.bot.setControlState(direction, true)
          const duration = typeof this.args.durationMs === 'number'
            ? this.args.durationMs
            : this.options.moveDurationMs
          this.timer = setTimeout(() => {
            this.bot.setControlState(direction, false)
            this.result = this.position()
            this.completed = true
          }, Math.max(0, duration))
          return
        }
        case 'jump': {
          this.bot.setControlState('jump', true)
          this.timer = setTimeout(() => {
            this.bot.setControlState('jump', false)
          }, 150)
          return
        }
        case 'pillar': {
          const count = typeof this.args.count === 'number' ? Math.min(8, Math.max(1, Math.floor(this.args.count))) : 1
          void (async () => {
            let placed = 0
            for (let index = 0; index < count; index += 1) {
              this.ensureNotStopped()
              await this.syncInventoryWindow()
              const feet = this.bot.entity.position
              const x = Math.floor(feet.x)
              const z = Math.floor(feet.z)
              const startY = Math.floor(feet.y)
              const support = this.bot.blockAt(new Vec3(x, startY - 1, z))
              if (support === null || isAirName(support.name)) {
                throw Object.assign(new Error(`no support block under ${x},${startY - 1},${z}`), { code: 'PILLAR_NO_SUPPORT' })
              }
              const held = this.bot.heldItem
              if (held === null || held === undefined) {
                throw Object.assign(new Error('pillar requires a held block'), { code: 'PILLAR_NO_ITEM' })
              }
              let lifted = false
              let lastError: unknown
              for (let attempt = 0; attempt < 3 && !lifted; attempt += 1) {
                this.ensureNotStopped()
                // Place only once the feet are a full block above the start: below
                // that the target cell intersects the player box and the server
                // refuses the placement.
                try {
                  await this.bot.lookAt(new Vec3(x + 0.5, startY - 0.5, z + 0.5), true)
                } catch {
                  // Best effort; placeBehind still forces the aim.
                }
                this.bot.setControlState('jump', true)
                try {
                  const deadline = Date.now() + 1200
                  while (!this.stopRequested && this.bot.entity.position.y < startY + 1.05 && Date.now() < deadline) await delay(10)
                } finally {
                  this.bot.setControlState('jump', false)
                }
                this.ensureNotStopped()
                if (this.bot.entity.position.y < startY + 1.0) {
                  await this.waitUntilGrounded()
                  continue
                }
                try {
                  await this.placeBehind(support)
                } catch (error) {
                  lastError = error
                }
                const targetBlock = this.bot.blockAt(new Vec3(x, startY, z))
                if (targetBlock !== null && !isAirName(targetBlock.name)) lifted = true
                await this.waitUntilGrounded()
              }
              if (!lifted) {
                const message = lastError === undefined ? 'pillar failed to place a block' : errorMessage(lastError)
                throw Object.assign(new Error(message), { code: 'PILLAR_FAILED' })
              }
              placed += 1
            }
            return { placed }
          })().then(result => {
            this.result = result
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = typeof (error as { code?: unknown }).code === 'string'
              ? (error as { code: string }).code
              : 'PILLAR_FAILED'
          })
          return
        }
        case 'moveTo': {
          const x = typeof this.args.x === 'number' ? this.args.x : undefined
          const z = typeof this.args.z === 'number' ? this.args.z : undefined
          if (x === undefined || z === undefined) throw new Error('moveTo requires numeric x and z')
          const tolerance = typeof this.args.tolerance === 'number' ? this.args.tolerance : 0.6
          const timeoutMs = typeof this.args.timeoutMs === 'number' ? this.args.timeoutMs : 10_000
          const blockedMs = typeof this.args.blockedMs === 'number' ? this.args.blockedMs : 1500
          if (tolerance < 0 || timeoutMs <= 0 || blockedMs <= 0) throw new Error('moveTo limits must be positive')
          this.moveTarget = { x, z, tolerance, timeoutMs, blockedMs }
          const initial = this.bot.entity?.position
          this.lastDistance = initial === undefined ? Number.POSITIVE_INFINITY : Math.hypot(x - initial.x, z - initial.z)
          this.lastProgressAt = Date.now()
          this.faceTarget()
          this.bot.setControlState('forward', true)
          return
        }
        case 'goto': {
          const library = loadPathfinderRuntime()
          const nav = this.navigation()
          const { x, y, z } = this.args
          if (nav === undefined || library === undefined) {
            this.failed = new Error('pathfinding is not available in this provider')
            this.failedCode = 'GOTO_UNAVAILABLE'
            return
          }
          if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
            this.failed = new Error('goto requires numeric x, y and z')
            this.failedCode = 'BAD_ARGS'
            return
          }
          const range = typeof this.args.range === 'number' ? Math.max(0, this.args.range) : 1
          const timeout = typeof this.args.timeoutMs === 'number' ? this.args.timeoutMs : 30_000
          nav.pathfinder.setMovements(this.movements)
          // GoalNear accepts a 3D target plus a radius; it walks, jumps and drops
          // as needed instead of the flat-only `moveTo` walker.
          nav.pathfinder.setGoal(new library.goals.GoalNear(x, y, z, range))
          const started = Date.now()
          let idleSince = 0
          const check = (): void => {
            if (this.cancelled || this.completed || this.failed !== undefined) return
            const position = this.bot.entity?.position
            if (position !== undefined
              && Math.hypot(position.x - x, position.y - y, position.z - z) <= range + 0.5) {
              nav.pathfinder.stop()
              this.result = { x: position.x, y: position.y, z: position.z }
              this.completed = true
              return
            }
            if (!nav.pathfinder.isMoving()) {
              if (idleSince === 0) idleSince = Date.now()
              else if (Date.now() - idleSince > 1500) {
                nav.pathfinder.stop()
                this.failed = new Error(`no path to ${x},${y},${z}`)
                this.failedCode = 'GOTO_NO_PATH'
                return
              }
            } else {
              idleSince = 0
            }
            if (Date.now() - started > timeout) {
              nav.pathfinder.stop()
              this.failed = new Error(`goto timed out after ${timeout}ms`)
              this.failedCode = 'GOTO_TIMEOUT'
              return
            }
            this.timer = setTimeout(check, 250)
          }
          this.timer = setTimeout(check, 250)
          return
        }
        case 'follow': {
          const library = loadPathfinderRuntime()
          const nav = this.navigation()
          if (nav === undefined || library === undefined) {
            this.failed = new Error('pathfinding is not available in this provider')
            this.failedCode = 'GOTO_UNAVAILABLE'
            return
          }
          const entity = this.entityById(this.args.entityId)
          if (entity === undefined) {
            this.failed = new Error(`no entity with id ${String(this.args.entityId)}`)
            this.failedCode = 'FOLLOW_NO_TARGET'
            return
          }
          const distance = typeof this.args.distance === 'number' ? Math.max(1, this.args.distance) : 3
          const timeout = typeof this.args.timeoutMs === 'number' ? this.args.timeoutMs : 60_000
          nav.pathfinder.setMovements(this.movements)
          nav.pathfinder.setGoal(new library.goals.GoalFollow(entity as never, distance), true)
          const started = Date.now()
          const check = (): void => {
            if (this.cancelled || this.completed || this.failed !== undefined) return
            if (this.bot.entities[entity.id] === undefined) {
              nav.pathfinder.stop()
              this.failed = new Error('follow target is no longer loaded')
              this.failedCode = 'FOLLOW_TARGET_LOST'
              return
            }
            if (Date.now() - started > timeout) {
              nav.pathfinder.stop()
              this.failed = new Error(`follow timed out after ${timeout}ms`)
              this.failedCode = 'FOLLOW_TIMEOUT'
              return
            }
            this.timer = setTimeout(check, 300)
          }
          this.timer = setTimeout(check, 300)
          return
        }
        case 'stop': {
          this.bot.clearControlStates()
          this.result = this.position()
          this.completed = true
          return
        }
        case 'dig': {
          const x = typeof this.args.x === 'number' ? this.args.x : undefined
          const y = typeof this.args.y === 'number' ? this.args.y : undefined
          const z = typeof this.args.z === 'number' ? this.args.z : undefined
          if (x === undefined || y === undefined || z === undefined) {
            throw new Error('dig requires numeric x, y and z')
          }
          const block = this.bot.blockAt(new Vec3(x, y, z))
          if (block === null || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') {
            this.failed = new Error(`no diggable block at ${x},${y},${z}`)
            this.failedCode = 'DIG_NO_BLOCK'
            return
          }
          void this.bot.dig(block).then(() => {
            this.result = { name: block.name, x: block.position.x, y: block.position.y, z: block.position.z }
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = 'DIG_FAILED'
          })
          return
        }
        case 'place': {
          const x = typeof this.args.x === 'number' ? this.args.x : undefined
          const y = typeof this.args.y === 'number' ? this.args.y : undefined
          const z = typeof this.args.z === 'number' ? this.args.z : undefined
          if (x === undefined || y === undefined || z === undefined) throw new Error('place requires numeric x, y and z')
          const face = typeof this.args.face === 'string' ? this.args.face : 'up'
          const vector = PLACE_FACES[face]
          if (vector === undefined) throw new Error(`unsupported place face: ${face}`)
          const target = new Vec3(x, y, z)
          const occupied = this.bot.blockAt(target)
          if (occupied !== null && !isAirName(occupied.name)) {
            this.failed = new Error(`target position is occupied by ${occupied.name}`)
            this.failedCode = 'PLACE_UNSUPPORTED'
            return
          }
          const reference = new Vec3(x - vector[0], y - vector[1], z - vector[2])
          const referenceBlock = this.bot.blockAt(reference)
          if (referenceBlock === null || isAirName(referenceBlock.name)) {
            this.failed = new Error(`no support block at ${reference.x},${reference.y},${reference.z}`)
            this.failedCode = 'PLACE_UNSUPPORTED'
            return
          }
          void (async () => {
            // The client inventory model can lag behind the server; refresh it
            // before trusting `heldItem` or the placement will be refused.
            await this.syncInventoryWindow()
            const feet = this.bot.entity.position
            const bodyX = Math.floor(feet.x)
            const bodyZ = Math.floor(feet.z)
            if (x === bodyX && z === bodyZ && (y === Math.floor(feet.y) || y === Math.floor(feet.y + 1))) {
              throw Object.assign(new Error(`target ${x},${y},${z} is inside the bot's own body`), { code: 'PLACE_BLOCKED_BY_SELF' })
            }
            const held = this.bot.heldItem
            if (held === null || held === undefined) {
              throw Object.assign(new Error('no item is held for placement'), { code: 'PLACE_NO_ITEM' })
            }
            await this.bot.placeBlock(referenceBlock, new Vec3(vector[0], vector[1], vector[2]))
            const placed = this.bot.blockAt(target)
            if (placed === null || isAirName(placed.name) || placed.name !== held.name) {
              throw Object.assign(new Error(`server did not place ${held.name} at ${x},${y},${z}`), { code: 'PLACE_FAILED' })
            }
            return { name: placed.name, x, y, z }
          })().then(result => {
            this.result = result
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = typeof (error as { code?: unknown }).code === 'string'
              ? (error as { code: string }).code
              : 'PLACE_FAILED'
          })
          return
        }
        case 'replace': {
          const x = typeof this.args.x === 'number' ? this.args.x : undefined
          const y = typeof this.args.y === 'number' ? this.args.y : undefined
          const z = typeof this.args.z === 'number' ? this.args.z : undefined
          if (x === undefined || y === undefined || z === undefined) throw new Error('replace requires numeric x, y and z')
          const target = new Vec3(x, y, z)
          const occupied = this.bot.blockAt(target)
          if (occupied !== null && !isAirName(occupied.name) && !isFluidName(occupied.name)) {
            this.failed = new Error(`target position is occupied by ${occupied.name}`)
            this.failedCode = 'PLACE_UNSUPPORTED'
            return
          }
          // Pick a support face whose reference block is solid. Unlike place,
          // the target itself may be water/lava: placing a block replaces fluid.
          const candidates = ['up', 'down', 'north', 'south', 'east', 'west']
          let vector: readonly [number, number, number] | undefined
          let referenceBlock: ReturnType<Bot['blockAt']> | null = null
          for (const name of candidates) {
            const face = PLACE_FACES[name]
            if (face === undefined) continue
            const ref = new Vec3(x - face[0], y - face[1], z - face[2])
            const block = this.bot.blockAt(ref)
            if (block === null || isAirName(block.name) || isFluidName(block.name)) continue
            vector = face
            referenceBlock = block
            break
          }
          if (vector === undefined || referenceBlock === null) {
            this.failed = new Error(`no support block around ${x},${y},${z}`)
            this.failedCode = 'PLACE_UNSUPPORTED'
            return
          }
          void (async () => {
            await this.syncInventoryWindow()
            const feet = this.bot.entity.position
            const bodyX = Math.floor(feet.x)
            const bodyZ = Math.floor(feet.z)
            if (x === bodyX && z === bodyZ && (y === Math.floor(feet.y) || y === Math.floor(feet.y + 1))) {
              throw Object.assign(new Error(`target ${x},${y},${z} is inside the bot's own body`), { code: 'PLACE_BLOCKED_BY_SELF' })
            }
            const held = this.bot.heldItem
            if (held === null || held === undefined) {
              throw Object.assign(new Error('no item is held for placement'), { code: 'PLACE_NO_ITEM' })
            }
            await this.bot.placeBlock(referenceBlock, new Vec3(vector[0], vector[1], vector[2]))
            const placed = this.bot.blockAt(target)
            if (placed === null || isAirName(placed.name) || placed.name !== held.name) {
              throw Object.assign(new Error(`server did not place ${held.name} at ${x},${y},${z}`), { code: 'PLACE_FAILED' })
            }
            return { name: placed.name, x, y, z }
          })().then(result => {
            this.result = result
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = typeof (error as { code?: unknown }).code === 'string'
              ? (error as { code: string }).code
              : 'PLACE_FAILED'
          })
          return
        }
        case 'attack': {
          const entityId = typeof this.args.entityId === 'number' ? Math.floor(this.args.entityId) : Number.NaN
          const entity = Number.isFinite(entityId) ? this.bot.entities[entityId] : undefined
          if (entity === undefined || entity === this.bot.entity) {
            this.failed = new Error(`no attackable entity for id ${String(this.args.entityId)}`)
            this.failedCode = 'ATTACK_NO_TARGET'
            return
          }
          this.bot.attack(entity)
          this.result = { entityId, name: entity.name ?? null }
          this.completed = true
          return
        }
        case 'equip': {
          const itemName = typeof this.args.item === 'string' ? this.args.item.replace(/^minecraft:/u, '') : ''
          if (itemName.length === 0) {
            this.failed = new Error('equip requires an item name')
            this.failedCode = 'EQUIP_NO_ITEM'
            return
          }
          const destination = typeof this.args.destination === 'string' ? this.args.destination : 'hand'
          if (!EQUIP_DESTINATIONS.includes(destination as EquipmentDestination)) {
            throw new Error(`unsupported equip destination: ${destination}`)
          }
          void (async () => {
            await this.syncInventoryWindow()
            const item = this.bot.inventory.items().find(entry => entry.name === itemName)
            if (item === undefined) {
              throw Object.assign(new Error(`no ${itemName} in inventory`), { code: 'EQUIP_NO_ITEM' })
            }
            await this.bot.equip(item, destination as EquipmentDestination)
            await this.syncInventoryWindow()
            const held = this.bot.heldItem
            return { item: item.name, destination, held: held === null || held === undefined ? null : held.name }
          })().then(result => {
            this.result = result
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = typeof (error as { code?: unknown }).code === 'string'
              ? (error as { code: string }).code
              : 'EQUIP_FAILED'
          })
          return
        }
        case 'unequip': {
          const destination = typeof this.args.destination === 'string' ? this.args.destination : 'hand'
          if (!EQUIP_DESTINATIONS.includes(destination as EquipmentDestination)) {
            throw new Error(`unsupported unequip destination: ${destination}`)
          }
          void this.bot.unequip(destination as EquipmentDestination).then(() => {
            this.result = { destination }
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = 'UNEQUIP_FAILED'
          })
          return
        }
        case 'fish': {
          const timeout = typeof this.args.timeoutMs === 'number' ? this.args.timeoutMs : 60_000
          void this.bot.fish().then(() => {
            this.result = { caught: true }
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = 'FISH_FAILED'
          })
          this.timer = setTimeout(() => {
            if (this.completed || this.failed !== undefined) return
            try { this.bot.deactivateItem() } catch { /* connection may be gone */ }
            this.failed = new Error(`fishing timed out after ${timeout}ms`)
            this.failedCode = 'FISH_TIMEOUT'
          }, Math.max(1000, timeout))
          return
        }
        case 'use': {
          const offhand = this.args.offhand === true
          const held = offhand ? this.bot.inventory.slots[45] : this.bot.heldItem
          if (held === null || held === undefined) {
            this.failed = new Error(offhand ? 'no item in the off hand' : 'no item is held')
            this.failedCode = 'USE_NO_ITEM'
            return
          }
          const duration = typeof this.args.durationMs === 'number' ? Math.max(0, this.args.durationMs) : 1000
          this.bot.activateItem(offhand)
          this.timer = setTimeout(() => {
            this.bot.deactivateItem()
            this.result = { item: held.name, offhand }
            this.completed = true
          }, duration)
          return
        }
        case 'lookAt': {
          const point = this.lookTarget()
          if (point === undefined) {
            this.failed = new Error('lookAt requires numeric x/y/z or a loaded entityId')
            this.failedCode = 'LOOKAT_NO_TARGET'
            return
          }
          void this.bot.lookAt(point, true).then(() => {
            this.result = { x: point.x, y: point.y, z: point.z }
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = 'LOOKAT_FAILED'
          })
          return
        }
        case 'consume': {
          const held = this.bot.heldItem
          if (held === null || held === undefined) {
            this.failed = new Error('no item is held')
            this.failedCode = 'USE_NO_ITEM'
            return
          }
          // `consume` waits for the server to accept the food/drink, unlike the
          // timed `use` act which can release the item too early.
          void this.bot.consume().then(() => {
            this.result = { item: held.name, food: this.bot.food ?? null }
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = 'CONSUME_FAILED'
          })
          return
        }
        case 'craft': {
          const name = typeof this.args.item === 'string' ? this.args.item.replace(/^minecraft:/u, '') : ''
          const itemType = name.length === 0 ? undefined : this.itemTypeId(name)
          if (itemType === undefined) {
            this.failed = new Error(`unknown item: ${String(this.args.item)}`)
            this.failedCode = 'CRAFT_UNKNOWN_RECIPE'
            return
          }
          const count = typeof this.args.count === 'number' ? Math.max(1, Math.floor(this.args.count)) : 1
          const table = this.craftTable()
          // Resolve the recipe for one execution; the loop below crafts one at a
          // time so a stale window cannot silently swallow a whole batch.
          const recipes = this.bot.recipesFor(itemType, null, 1, table ?? null)
          const recipe = recipes[0]
          if (recipe === undefined) {
            const needsTable = this.bot.recipesAll(itemType, null, true).some(entry => entry.requiresTable)
            this.failed = new Error(needsTable && table === undefined
              ? `crafting ${name} requires a crafting table`
              : `no craftable recipe for ${name}`)
            this.failedCode = needsTable && table === undefined ? 'CRAFT_NO_TABLE' : 'CRAFT_NO_INGREDIENTS'
            return
          }
          void this.craftRepeatedly(recipe, count, table, itemType, name).then(result => {
            this.result = result
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = typeof (error as { code?: unknown }).code === 'string'
              ? (error as { code: string }).code
              : 'CRAFT_FAILED'
          })
          return
        }
        case 'container-transfer': {
          const position = blockPosition(this.args)
          const block = position === undefined ? null : this.bot.blockAt(new Vec3(position.x, position.y, position.z))
          if (block === null || isAirName(block.name) || !CONTAINER_NAMES.includes(block.name)) {
            this.failed = new Error(`no supported container at ${JSON.stringify(position ?? null)}`)
            this.failedCode = 'CONTAINER_NO_BLOCK'
            return
          }
          void this.transferContainer(block).then(result => {
            this.result = result
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = typeof (error as { code?: unknown }).code === 'string'
              ? (error as { code: string }).code
              : 'CONTAINER_FAILED'
          })
          return
        }
        case 'toss': {
          const name = typeof this.args.item === 'string' ? this.args.item.replace(/^minecraft:/u, '') : ''
          const itemType = name.length === 0 ? undefined : this.itemTypeId(name)
          if (itemType === undefined) {
            this.failed = new Error(`unknown item: ${String(this.args.item)}`)
            this.failedCode = 'TOSS_NO_ITEM'
            return
          }
          const count = typeof this.args.count === 'number' ? Math.max(1, Math.floor(this.args.count)) : 1
          void this.bot.toss(itemType, null, count).then(() => {
            this.result = { item: name, count }
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = 'TOSS_FAILED'
          })
          return
        }
        case 'respawn': {
          if ((this.bot.health ?? 0) > 0) {
            this.result = this.position()
            this.completed = true
            return
          }
          this.bot.respawn()
          const started = Date.now()
          const check = (): void => {
            if (this.cancelled || this.completed) return
            if ((this.bot.health ?? 0) > 0) {
              this.result = this.position()
              this.completed = true
              return
            }
            if (Date.now() - started > 15_000) {
              this.failed = new Error('respawn did not complete')
              this.failedCode = 'RESPAWN_FAILED'
              return
            }
            this.timer = setTimeout(check, 250)
          }
          this.timer = setTimeout(check, 250)
          return
        }
        case 'sleep': {
          const position = blockPosition(this.args)
          const bed = position === undefined ? null : this.bot.blockAt(new Vec3(position.x, position.y, position.z))
          if (bed === null || !this.bot.isABed(bed)) {
            this.failed = new Error(`no bed at ${JSON.stringify(position ?? null)}`)
            this.failedCode = 'SLEEP_NO_BED'
            return
          }
          const started = Date.now()
          let slept = false
          void this.bot.sleep(bed).catch((error: unknown) => {
            const message = errorMessage(error)
            this.failed = new Error(message)
            this.failedCode = /night|day/iu.test(message) ? 'SLEEP_NOT_NIGHT' : 'SLEEP_FAILED'
          })
          const check = (): void => {
            if (this.cancelled || this.completed || this.failed !== undefined) return
            if (this.bot.isSleeping === true) slept = true
            if (slept && this.bot.isSleeping !== true) {
              const timeOfDay = this.timeOfDay()
              this.result = { slept: true, ...(timeOfDay === null ? {} : { timeOfDay }) }
              this.completed = true
              return
            }
            if (Date.now() - started > 60_000) {
              this.failed = new Error('sleep did not finish')
              this.failedCode = 'SLEEP_TIMEOUT'
              return
            }
            this.timer = setTimeout(check, 200)
          }
          this.timer = setTimeout(check, 200)
          return
        }
        case 'interact': {
          const entity = this.entityById(this.args.entityId)
          if (entity === undefined) {
            this.failed = new Error(`no entity with id ${String(this.args.entityId)}`)
            this.failedCode = 'INTERACT_NO_TARGET'
            return
          }
          void this.bot.activateEntity(entity).then(() => {
            this.result = { entityId: entity.id, name: entity.name ?? null }
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = 'INTERACT_FAILED'
          })
          return
        }
        case 'activate': {
          const position = blockPosition(this.args)
          const block = position === undefined ? null : this.bot.blockAt(new Vec3(position.x, position.y, position.z))
          if (block === null || isAirName(block.name) || position === undefined) {
            this.failed = new Error(`no block at ${JSON.stringify(position ?? null)}`)
            this.failedCode = 'ACTIVATE_NO_BLOCK'
            return
          }
          void this.bot.activateBlock(block).then(() => {
            this.result = { name: block.name, x: position.x, y: position.y, z: position.z }
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = 'ACTIVATE_FAILED'
          })
          return
        }
        case 'mount': {
          const entity = this.entityById(this.args.entityId)
          if (entity === undefined) {
            this.failed = new Error(`no entity with id ${String(this.args.entityId)}`)
            this.failedCode = 'MOUNT_NO_TARGET'
            return
          }
          this.bot.mount(entity)
          const started = Date.now()
          const check = (): void => {
            if (this.cancelled || this.completed) return
            if (this.vehicle() !== undefined) {
              this.result = { entityId: entity.id, name: entity.name ?? null }
              this.completed = true
              return
            }
            if (Date.now() - started > 5000) {
              this.failed = new Error('mount did not complete')
              this.failedCode = 'MOUNT_FAILED'
              return
            }
            this.timer = setTimeout(check, 200)
          }
          this.timer = setTimeout(check, 200)
          return
        }
        case 'dismount': {
          this.bot.dismount()
          const started = Date.now()
          const check = (): void => {
            if (this.cancelled || this.completed) return
            if (this.vehicle() === undefined) {
              this.result = this.position()
              this.completed = true
              return
            }
            if (Date.now() - started > 5000) {
              this.failed = new Error('dismount did not complete')
              this.failedCode = 'DISMOUNT_FAILED'
              return
            }
            this.timer = setTimeout(check, 200)
          }
          this.timer = setTimeout(check, 200)
          return
        }
        case 'drive': {
          if (this.vehicle() === undefined) {
            this.failed = new Error('drive requires a mounted vehicle')
            this.failedCode = 'DRIVE_NOT_MOUNTED'
            return
          }
          const left = typeof this.args.left === 'number' ? Math.max(-1, Math.min(1, this.args.left)) : 0
          const forward = typeof this.args.forward === 'number' ? Math.max(-1, Math.min(1, this.args.forward)) : 0
          const duration = typeof this.args.durationMs === 'number' ? Math.max(0, this.args.durationMs) : 1000
          this.bot.moveVehicle(left, forward)
          this.timer = setTimeout(() => {
            this.bot.moveVehicle(0, 0)
            this.result = { left, forward, durationMs: duration }
            this.completed = true
          }, duration)
          return
        }
        case 'place-entity': {
          const position = blockPosition(this.args)
          if (position === undefined) {
            this.failed = new Error('place-entity requires numeric x, y and z')
            this.failedCode = 'BAD_ARGS'
            return
          }
          const face = typeof this.args.face === 'string' ? this.args.face : 'up'
          const vector = PLACE_FACES[face]
          if (vector === undefined) throw new Error(`unsupported place face: ${face}`)
          const reference = new Vec3(position.x - vector[0], position.y - vector[1], position.z - vector[2])
          const referenceBlock = this.bot.blockAt(reference)
          if (referenceBlock === null || isAirName(referenceBlock.name)) {
            this.failed = new Error(`no support block at ${reference.x},${reference.y},${reference.z}`)
            this.failedCode = 'PLACE_UNSUPPORTED'
            return
          }
          void this.bot.placeEntity(referenceBlock, new Vec3(vector[0], vector[1], vector[2])).then(entity => {
            this.result = { entityId: entity.id, name: entity.name ?? null }
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = 'PLACE_FAILED'
          })
          return
        }
        case 'trade': {
          const entity = this.entityById(this.args.entityId)
          const index = typeof this.args.index === 'number' ? Math.floor(this.args.index) : Number.NaN
          if (entity === undefined || !Number.isFinite(index)) {
            this.failed = new Error('trade requires numeric entityId and index')
            this.failedCode = 'TRADE_INVALID'
            return
          }
          const times = typeof this.args.count === 'number' ? Math.max(1, Math.floor(this.args.count)) : 1
          void (async () => {
            const window = await this.bot.openVillager(entity as Parameters<Bot['openVillager']>[0])
            try {
              await waitVillagerReady(window as unknown as AnyWindow)
              await this.bot.trade(window, index, times)
            } finally {
              await window.close()
            }
            return { entityId: entity.id, index, count: times }
          })().then(result => {
            this.result = result
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = 'TRADE_FAILED'
          })
          return
        }
        default:
          throw new Error(`unsupported act: ${this.name}`)
      }
    } catch (error) {
      this.failed = error instanceof Error ? error : new Error(String(error))
    }
  }

  private position(): JsonValue {
    const position = this.bot.entity?.position
    return position === undefined ? null : { x: position.x, y: position.y, z: position.z }
  }

  /** Normalized entity view shared by `entities` and `entity`. */

  private itemTypeId(name: string): number | undefined {
    const registry = this.bot.registry as unknown as { itemsByName?: Record<string, { id?: number }> }
    return registry.itemsByName?.[name]?.id
  }

  private entityById(value: JsonValue | undefined): Parameters<Bot['attack']>[0] | undefined {
    const id = typeof value === 'number' ? Math.floor(value) : Number.NaN
    if (!Number.isFinite(id)) return undefined
    return this.bot.entities[id] as Parameters<Bot['attack']>[0] | undefined
  }

  private navigation(): {
    pathfinder: {
      setGoal(goal: unknown, dynamic?: boolean): void
      setMovements(movements: unknown): void
      stop(): void
      isMoving(): boolean
    }
  } | undefined {
    const pathfinderHandle = (this.bot as unknown as {
      pathfinder?: {
        setGoal(goal: unknown, dynamic?: boolean): void
        setMovements(movements: unknown): void
        stop(): void
        isMoving(): boolean
      }
    }).pathfinder
    if (pathfinderHandle === undefined || this.movements === undefined) return undefined
    return { pathfinder: pathfinderHandle }
  }

  private vehicle(): unknown {
    return (this.bot as unknown as { vehicle?: unknown }).vehicle
  }

  private timeOfDay(): number | null {
    const value = this.bot.time?.timeOfDay
    if (typeof value === 'number') return value
    if (typeof value === 'bigint') return Number(value)
    return null
  }

  private lookTarget(): Vec3 | undefined {
    const entity = this.entityById(this.args.entityId)
    const position = (entity as unknown as { position?: { x: number; y: number; z: number } } | undefined)?.position
    if (position !== undefined) return new Vec3(position.x, position.y + 1.6, position.z)
    const { x, y, z } = this.args
    if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') return new Vec3(x, y, z)
    return undefined
  }

  private craftTable(): Parameters<Bot['craft']>[2] {
    const table = this.args.table
    if (typeof table === 'object' && table !== null && !Array.isArray(table)) {
      const point = blockPosition(table as Record<string, JsonValue>)
      if (point === undefined) return undefined
      return this.bot.blockAt(new Vec3(point.x, point.y, point.z)) ?? undefined
    }
    const tableId = this.blockTypeId('crafting_table') ?? this.itemTypeId('crafting_table')
    if (tableId === undefined) return undefined
    return this.bot.findBlock({ matching: tableId, maxDistance: 4 }) ?? undefined
  }

  /** findBlock matches block type ids; item ids are a different registry. */
  private blockTypeId(name: string): number | undefined {
    const registry = this.bot.registry as unknown as { blocksByName?: Record<string, { id?: number }> }
    return registry.blocksByName?.[name]?.id
  }

  /**
   * Place on the top face of `support`. The internal options let the placement
   * skip the smooth head turn; a pillar jump only lasts a few ticks.
   */
  private async placeBehind(support: unknown): Promise<void> {
    const bot = this.bot as unknown as {
      _placeBlockWithOptions?: (reference: unknown, face: unknown, options: { forceLook: boolean; swingArm: string }) => Promise<void>
    }
    const face = new Vec3(0, 1, 0)
    if (typeof bot._placeBlockWithOptions === 'function') {
      await bot._placeBlockWithOptions(support, face, { forceLook: true, swingArm: 'right' })
      return
    }
    await this.bot.placeBlock(support as Parameters<Bot['placeBlock']>[0], face)
  }

  private async waitUntilGrounded(timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.stopRequested && this.bot.entity.onGround !== true && Date.now() < deadline) await delay(10)
  }

  /** Abortable delay so a stopped craft/pillar chain stops between recipes. */
  private async waitAbortable(ms: number): Promise<void> {
    const deadline = Date.now() + ms
    while (!this.stopRequested && Date.now() < deadline) {
      await delay(Math.min(25, Math.max(1, deadline - Date.now())))
    }
  }

  private ensureNotStopped(): void {
    if (this.stopRequested) {
      throw Object.assign(new Error('act was cancelled'), { code: 'ACT_CANCELLED' })
    }
  }

  /**
   * Craft one recipe at a time and verify the inventory delta.
   *
   * `bot.craft(recipe, N)` performs N window transactions; when a window gets
   * out of sync mineflayer waits for an `updateSlot` event that never arrives
   * and the whole batch is lost. Crafting one at a time, closing a stale window
   * and retrying once keeps the failure local and reports an honest incomplete.
   */
  private async craftRepeatedly(
    recipe: Parameters<Bot['craft']>[0],
    requested: number,
    table: Parameters<Bot['craft']>[2],
    itemType: number,
    name: string,
  ): Promise<JsonValue> {
    this.craftRunning = true
    try {
      await this.syncInventoryWindow()
      this.ensureNotStopped()
      const before = this.inventoryCountOfType(itemType)
      let crafted = 0
      let lastError: unknown
      for (let attempt = 0; attempt < requested; attempt += 1) {
        this.ensureNotStopped()
        // A craft fired immediately after the previous one is silently dropped by
        // the server; give the window a moment to settle and wait for the result
        // item to actually appear before starting the next one.
        if (crafted > 0) await this.waitAbortable(400)
        this.ensureNotStopped()
        const beforeThis = this.inventoryCountOfType(itemType)
        try {
          await this.craftOnce(recipe, table)
        } catch (error) {
          this.ensureNotStopped()
          lastError = error
          try {
            await this.closeCurrentWindow()
            this.ensureNotStopped()
            await this.craftOnce(recipe, table)
          } catch (retryError) {
            lastError = retryError
            break
          }
        }
        if (!(await this.waitForItemCount(itemType, beforeThis, 800))) {
          this.ensureNotStopped()
          await this.syncInventoryWindow()
          if (!(await this.waitForItemCount(itemType, beforeThis, 300))) {
            lastError = lastError ?? new Error('craft produced no item')
            break
          }
        }
        crafted += 1
      }
      this.ensureNotStopped()
      const produced = this.inventoryCountOfType(itemType) - before
      const expected = (recipe.result?.count ?? 1) * crafted
      if (crafted < requested || produced < expected) {
        throw Object.assign(
          new Error(
            `crafted ${crafted}/${requested} of ${name} (produced ${produced}, expected ${expected})`
            + (lastError === undefined ? '' : `: ${errorMessage(lastError)}`),
          ),
          { code: 'CRAFT_INCOMPLETE' },
        )
      }
      return { item: name, requested, crafted, produced }
    } finally {
      this.craftRunning = false
    }
  }

  private async craftOnce(recipe: Parameters<Bot['craft']>[0], table: Parameters<Bot['craft']>[2]): Promise<void> {
    await this.closeCurrentWindow()
    // After a container interaction mineflayer's inventory model can be stale,
    // and bot.craft then clicks the wrong source slots (observed: a button
    // instead of planks). Sync the window before every craft.
    await this.syncInventoryWindow()
    await this.bot.craft(recipe, 1, table)
  }

  private async syncInventoryWindow(): Promise<void> {
    const bot = this.bot as unknown as { _syncWindow?: (window: unknown) => Promise<void>; inventory: unknown }
    if (typeof bot._syncWindow !== 'function') return
    try {
      await bot._syncWindow(bot.inventory)
    } catch {
      // Best effort: the caller verifies the produced item delta anyway.
    }
  }

  private async closeCurrentWindow(): Promise<void> {
    const window = this.bot.currentWindow as unknown as AnyWindow | null
    if (window === null || window === undefined) return
    await closeWindowQuietly(window)
  }

  private inventoryCountOfType(itemType: number): number {
    const window = this.bot.inventory as unknown as AnyWindow
    // `window.count(itemType, metadata)` is the documented prismarine-windows
    // helper for counting items in the inventory section.
    if (typeof window.count === 'function') return window.count(itemType, null)
    return this.bot.inventory.items()
      .filter(item => item.type === itemType)
      .reduce((total, item) => total + item.count, 0)
  }

  private async waitForItemCount(itemType: number, before: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !this.stopRequested) {
      if (this.inventoryCountOfType(itemType) > before) return true
      await this.waitAbortable(50)
    }
    return !this.stopRequested && this.inventoryCountOfType(itemType) > before
  }

  private async transferContainer(block: Parameters<Bot['openFurnace']>[0]): Promise<JsonValue> {
    const action = typeof this.args.action === 'string' ? this.args.action : ''
    const name = typeof this.args.item === 'string' ? this.args.item.replace(/^minecraft:/u, '') : ''
    const count = typeof this.args.count === 'number' ? Math.max(1, Math.floor(this.args.count)) : null
    const itemType = name.length === 0 ? undefined : this.itemTypeId(name)
    if (name.length > 0 && itemType === undefined) {
      throw Object.assign(new Error(`unknown item: ${name}`), { code: 'CONTAINER_NO_ITEM' })
    }
    const window = await openContainerWindow(this.bot, block)
    try {
      switch (action) {
        case 'deposit':
          await window.deposit?.(itemType as number, null, count)
          break
        case 'withdraw':
          await window.withdraw?.(itemType as number, null, count)
          break
        case 'load-input':
          await window.putInput?.(itemType as number, null, count ?? 1)
          break
        case 'load-fuel':
          await window.putFuel?.(itemType as number, null, count ?? 1)
          break
        case 'take-input':
          await window.takeInput?.()
          break
        case 'take-fuel':
          await window.takeFuel?.()
          break
        case 'take-output':
          await window.takeOutput?.()
          break
        default:
          throw Object.assign(new Error(`unsupported container action: ${action}`), { code: 'CONTAINER_UNSUPPORTED' })
      }
    } finally {
      await closeWindowQuietly(window)
    }
    return { action, kind: block.name, item: name.length === 0 ? null : name, count }
  }

  private faceTarget(): void {
    const target = this.moveTarget
    const position = this.bot.entity?.position
    if (target === undefined || position === undefined) return
    const yaw = Math.atan2(-(target.x - position.x), -(target.z - position.z))
    this.lastLookAt = Date.now()
    void this.bot.look(yaw, 0, true).catch((error: unknown) => {
      this.failed = error instanceof Error ? error : new Error(String(error))
      this.bot.clearControlStates()
    })
  }

  private pollMoveTo(): void {
    const target = this.moveTarget
    const position = this.bot.entity?.position
    if (target === undefined || position === undefined) return
    const dx = target.x - position.x
    const dz = target.z - position.z
    const distance = Math.hypot(dx, dz)
    const now = Date.now()
    if (distance <= target.tolerance) {
      this.bot.clearControlStates()
      this.result = {
        x: position.x,
        y: position.y,
        z: position.z,
        distance,
        target: { x: target.x, z: target.z },
      }
      this.completed = true
      return
    }
    if (now - this.startedAt > target.timeoutMs) {
      this.failed = new Error(`moveTo timed out after ${target.timeoutMs}ms at distance ${distance.toFixed(2)}`)
      this.failedCode = 'MOVE_TO_TIMEOUT'
      this.bot.clearControlStates()
      return
    }
    if (distance <= this.lastDistance - 0.05) {
      this.lastDistance = distance
      this.lastProgressAt = now
    } else if (now - this.lastProgressAt > target.blockedMs) {
      this.failed = new Error(`moveTo made no progress for ${target.blockedMs}ms at distance ${distance.toFixed(2)}`)
      this.failedCode = 'MOVE_TO_BLOCKED'
      this.bot.clearControlStates()
      return
    }
    if (now - this.lastLookAt > 100) this.faceTarget()
    // A flat walker cannot climb a one-block step. Pulse jump while forward stays
    // held; the blockedMs watchdog still fires if the step is genuinely too high.
    if (now - this.lastProgressAt > 300 && now - this.lastJumpAt > 300) {
      this.lastJumpAt = now
      this.bot.setControlState('jump', true)
      setTimeout(() => {
        try {
          this.bot.setControlState('jump', false)
        } catch {
          // The connection may be gone; clearControlStates runs on end anyway.
        }
      }, 120)
    }
    this.bot.setControlState('forward', true)
  }
}

function isControl(value: string): value is BotControl {
  return value === 'forward' || value === 'back' || value === 'left' || value === 'right'
    || value === 'jump' || value === 'sprint' || value === 'sneak'
}

function actErrorCategory(code: string): 'environment' | 'runtime' | 'timeout' {
  if (code === 'GAME_PAUSED' || code === 'CONNECTION_LOST' || code === 'MOVE_TO_BLOCKED') return 'environment'
  if (code === 'PLACE_NO_ITEM' || code === 'PLACE_UNSUPPORTED' || code === 'ATTACK_NO_TARGET' || code === 'EQUIP_NO_ITEM' || code === 'USE_NO_ITEM') return 'environment'
  if (code === 'ACT_TIMEOUT' || code === 'MOVE_TO_TIMEOUT') return 'timeout'
  return 'runtime'
}

export type { QueryOutcome }





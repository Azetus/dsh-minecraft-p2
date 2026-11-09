import type { Bot, EquipmentDestination } from 'mineflayer'
import mineflayer from 'mineflayer'
import { Vec3 } from 'vec3'
import { MotionRun } from './motion/run.ts'
import { VanillaRun } from './motion/vanilla-run.ts'
import { MineflayerMotionWorld } from './motion/world.ts'
import { cellOf } from '../motion/model/block.ts'
import { defaultConstraints } from '../motion/model/types.ts'
import type { Cell } from '../motion/model/types.ts'
import { VanillaNodeReader } from '../motion/vanilla/classify.ts'
import { planVanillaPath } from '../motion/vanilla/search.ts'
import { attachBlockTags, blockTagsFor } from './block-tags.ts'
import { parseUnstickBlocks } from './unstick.ts'
import { REPLACEABLE } from '../motion/model/semantics/vanilla.ts'
import {
  countItem,
  diffPlacement,
  isPlaceSupport,
  isTargetOccupied,
  itemConsumed,
  retrySafe,
  samePlacePoint,
  snapshotPlaceNeighborhood,
} from './place-evidence.ts'

/**
 * The mineflayer module itself, re-exported for the body's authored-op bridge.
 * The body bundle must not import mineflayer statically: it reaches the
 * provider through a runtime dynamic import, and that file keeps the package
 * external so CommonJS `require` of node builtins keeps working.
 */
export const mineflayerModule: unknown = mineflayer

import type { LastDisconnect, PauseDiagnostics, ProviderRuntimeStatus, SuspensionState } from '../contracts/protocol.ts'
import type { JsonValue, ValueMeta } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import type {
  ActHandle,
  ActPoll,
  QueryOutcome,
  QueryPort,
} from './types.ts'

export type MineflayerProviderOptions = {
  actionTimeoutMs?: number
  /** How long the server age must stay unchanged before the provider treats it as paused. */
  serverIdleMs?: number
  /** How long a requested stop may stay unconfirmed before it counts as one release fault. */
  releaseFaultIntervalMs?: number
  /** Consecutive release faults before the provider drops the connection for a body rebuild. */
  releaseFaultLimit?: number
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
  // The tags packet can arrive before spawn (and before the registry exists),
  // so attach immediately and let the index map lazily.
  attachBlockTags(bot)
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

const PLACE_FACES: Record<string, readonly [number, number, number]> = {
  up: [0, 1, 0],
  down: [0, -1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
}

const EQUIP_DESTINATIONS: readonly EquipmentDestination[] = ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']

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

/** Tag-first replaceable check, aligned with the driver's target preflight. */
function isReplaceableTargetBlock(
  block: NonNullable<ReturnType<Bot['blockAt']>>,
  tags: ReadonlySet<string> | undefined,
): boolean {
  const name = block.name.replace(/^minecraft:/u, '')
  if (isAirName(name) || isFluidName(name)) return true
  if (tags !== undefined) {
    return tags.has('minecraft:replaceable') || tags.has('replaceable')
  }
  return REPLACEABLE.has(name)
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

/** Count one item in the container section; undefined when the window cannot tell. */
function countContainerItems(window: AnyWindow, name: string): number | undefined {
  if (typeof window.containerItems === 'function') {
    return window.containerItems()
      .filter(item => item.name === name)
      .reduce((sum, item) => sum + item.count, 0)
  }
  if (Array.isArray(window.slots)) {
    const inventoryStart = typeof window.inventoryStart === 'number' ? window.inventoryStart : window.slots.length
    return window.slots
      .slice(0, inventoryStart)
      .filter((item): item is { slot?: number; name: string; count: number } => item !== null && item !== undefined)
      .filter(item => item.name === name)
      .reduce((sum, item) => sum + item.count, 0)
  }
  return undefined
}

async function closeWindowQuietly(window: AnyWindow | null | undefined): Promise<void> {
  try {
    await window?.close?.()
  } catch {
    // The server may already have closed the window; that is not a failure here.
  }
}

/** A pause is `suspended`, never a failed action. */
export type ProviderSuspension = SuspensionState

/** Query/act adapter over one connected Mineflayer bot. */
export class MineflayerProvider {
  readonly providerId = PROVIDER_ID
  readonly providerVersion: string

  private current: ActHandle | undefined
  private disconnected: Error | undefined
  private lastDisconnect: LastDisconnect | undefined
  private paused = false
  private lastDeath: { at: number; position: { x: number; y: number; z: number } | null } | undefined
  private lastServerAge: number | undefined
  private lastServerAgeAt = 0
  private readonly pauseTimer: ReturnType<typeof setInterval>
  private readonly options: Required<MineflayerProviderOptions>
  private readonly suspensionListeners = new Set<(state: ProviderSuspension) => void>()
  private ageChanges = 0
  private timePackets = 0
  private lastTimerAt = 0
  private eventLoopLagMs = 0
  private suspendedSince = 0
  private packetsAtSuspend = 0
  private ageChangesAtSuspend = 0
  private releasePendingSince: number | undefined
  private releaseFaults = 0
  private resetRequested = false

  constructor(
    private readonly bot: Bot,
    options: MineflayerProviderOptions = {},
  ) {
    this.options = {
      actionTimeoutMs: options.actionTimeoutMs ?? 600_000,
      serverIdleMs: options.serverIdleMs ?? 1500,
      releaseFaultIntervalMs: options.releaseFaultIntervalMs ?? 5_000,
      releaseFaultLimit: options.releaseFaultLimit ?? 3,
      providerVersion: options.providerVersion ?? '0',
    }
    this.providerVersion = this.options.providerVersion
    this.lastTimerAt = Date.now()
    this.pauseTimer = setInterval(() => {
      const now = Date.now()
      // A late 250 ms timer is evidence that our event loop (or the process)
      // was blocked, which otherwise looks exactly like a paused server.
      const lag = Math.max(0, now - this.lastTimerAt - 250)
      this.eventLoopLagMs = Math.max(lag, Math.floor(this.eventLoopLagMs * 0.9))
      this.lastTimerAt = now
      this.refreshPauseState(now)
      this.refreshReleaseWatchdog(now)
    }, 250)
    this.pauseTimer.unref?.()
    bot.on('time', () => {
      this.timePackets += 1
    })
    bot.once('end', reason => {
      const text = reasonText(reason)
      this.recordDisconnect('end', `Mineflayer connection ended: ${text}`)
      this.markDisconnected(new Error(`Mineflayer connection ended: ${text}`))
    })
    bot.on('kicked', reason => {
      const text = reasonText(reason)
      this.recordDisconnect('kick', `Mineflayer kicked: ${text}`)
      this.markDisconnected(new Error(`Mineflayer kicked: ${text}`))
    })
    bot.on('death', () => {
      this.bot.clearControlStates()
      const position = this.bot.entity?.position
      this.lastDeath = {
        at: Date.now(),
        position: position === undefined ? null : { x: position.x, y: position.y, z: position.z },
      }
      const current = this.current as (ActHandle & {
        abort?: (error: Error, code?: string) => void
        deathCode?: () => string
      }) | undefined
      current?.abort?.(new Error('the bot died'), current.deathCode?.() ?? 'DEATH')
    })
    bot.on('error', error => {
      const disconnected = error instanceof Error ? error : new Error(String(error))
      this.recordDisconnect('error', disconnected.message)
      this.markDisconnected(disconnected)
    })
  }

  private markDisconnected(error: Error): void {
    clearInterval(this.pauseTimer)
    this.disconnected = error
    this.bot.clearControlStates()
    const current = this.current as (ActHandle & { abort?: (error: Error, code?: string) => void }) | undefined
    current?.abort?.(this.disconnected, 'CONNECTION_LOST')
  }

  /**
   * Keep the most specific cause. A kick arrives before the socket `end`, and
   * an explicit reset is more useful than the generic socket close that follows.
   */
  private recordDisconnect(kind: LastDisconnect['kind'], reason: string): void {
    const priority: Record<LastDisconnect['kind'], number> = { end: 1, error: 2, reset: 3, kick: 4 }
    if (this.lastDisconnect !== undefined && priority[this.lastDisconnect.kind] >= priority[kind]) return
    const now = Date.now()
    this.lastDisconnect = {
      at: now,
      kind,
      reason: reason.slice(0, 500),
      eventLoopLagMs: this.eventLoopLagMs,
      serverAge: this.serverAge(),
      paused: this.paused,
      ageIdleMs: this.lastServerAgeAt > 0 ? now - this.lastServerAgeAt : 0,
    }
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
      connected: this.disconnected === undefined && !this.resetRequested,
      paused: this.paused,
      serverAge,
      idleMs: this.paused && this.lastServerAgeAt > 0 ? Date.now() - this.lastServerAgeAt : 0,
      controlState: this.controlState(),
      controlRelease: current?.controlRelease() ?? null,
      lastDeathAt: this.lastDeath?.at ?? null,
      lastDeathPosition: this.lastDeath?.position ?? null,
      ...(this.lastDisconnect === undefined ? {} : { lastDisconnect: { ...this.lastDisconnect } }),
      pauseDiagnostics: this.pauseDiagnostics(),
    }
  }

  /** Subscribe to provider pause/resume transitions (one listener per port). */
  onSuspension(listener: (state: ProviderSuspension) => void): () => void {
    this.suspensionListeners.add(listener)
    return () => this.suspensionListeners.delete(listener)
  }

  pauseDiagnostics(now = Date.now()): PauseDiagnostics {
    const ageIdleMs = this.lastServerAgeAt > 0 ? now - this.lastServerAgeAt : 0
    const packetsDuringPause = this.timePackets - this.packetsAtSuspend
    const agesDuringPause = this.ageChanges - this.ageChangesAtSuspend
    let verdict: PauseDiagnostics['verdict'] = 'running'
    if (this.paused) {
      if (this.eventLoopLagMs > 1_000) verdict = 'event-loop-blocked'
      else if (agesDuringPause === 0 && packetsDuringPause > 0) verdict = 'server-paused'
      else if (agesDuringPause === 0 && packetsDuringPause === 0) verdict = 'client-stalled'
      else verdict = 'unknown'
    }
    return {
      ...(this.suspendedSince > 0 ? { suspendedSince: this.suspendedSince } : {}),
      ageChanges: this.ageChanges,
      timePackets: this.timePackets,
      eventLoopLagMs: this.eventLoopLagMs,
      ageIdleMs,
      verdict,
      lastAgeAt: this.lastServerAgeAt,
      lastAge: this.lastServerAge ?? null,
    }
  }

  /**
   * Release verdict for the operation broker. A disconnected client cannot
   * observe its effects, so the state stays `unknown` instead of claiming idle.
   */
  controlState(): 'idle' | 'active' | 'unknown' {
    if (this.disconnected !== undefined || this.resetRequested) return 'unknown'
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
      this.ageChanges += 1
      if (this.paused) {
        this.paused = false
        this.suspendedSince = 0
        this.emitSuspension(false, now)
      }
      return
    }
    if (!this.paused && now - this.lastServerAgeAt >= this.options.serverIdleMs) {
      this.paused = true
      this.suspendedSince = now
      this.packetsAtSuspend = this.timePackets
      this.ageChangesAtSuspend = this.ageChanges
      this.bot.clearControlStates()
      const current = this.current as (ActHandle & { abort?: (error: Error, code?: string) => void }) | undefined
      current?.abort?.(new Error('server ticks are paused'), 'GAME_PAUSED')
      this.emitSuspension(true, now)
    }
  }

  /**
   * A stop is only a request; if the provider cannot observe the effect for
   * `releaseFaultIntervalMs`, that is one release fault. `releaseFaultLimit`
   * consecutive faults drop the connection so the body rebuilds a new epoch
   * instead of dispatching into a half-released bot forever.
   */
  refreshReleaseWatchdog(now = Date.now()): void {
    if (this.disconnected !== undefined) return
    const current = this.current as (ActHandle & { stopPending?: () => boolean }) | undefined
    if (current === undefined || current.stopPending?.() !== true) {
      this.releasePendingSince = undefined
      this.releaseFaults = 0
      return
    }
    if (this.releasePendingSince === undefined) {
      this.releasePendingSince = now
      return
    }
    if (now - this.releasePendingSince < this.options.releaseFaultIntervalMs) return
    this.releasePendingSince = now
    this.releaseFaults += 1
    if (this.releaseFaults < this.options.releaseFaultLimit) return
    this.requestReset()
  }

  /** Drop the connection so the body's existing fault/rebuild path takes over. */
  private requestReset(): void {
    if (this.resetRequested || this.disconnected !== undefined) return
    this.resetRequested = true
    this.recordDisconnect('reset', 'p2: act release unconfirmed; requesting body rebuild')
    try {
      this.bot.quit('p2: act release unconfirmed; requesting body rebuild')
    } catch (error) {
      // A failed quit leaves the connection in an unknown state; report it as
      // lost instead of pretending the reset happened.
      this.disconnected = error instanceof Error ? error : new Error(String(error))
      const current = this.current as (ActHandle & { abort?: (error: Error, code?: string) => void }) | undefined
      current?.abort?.(this.disconnected, 'CONNECTION_LOST')
    }
  }

  private emitSuspension(suspended: boolean, at: number): void {
    const state: ProviderSuspension = {
      suspended,
      at,
      idleMs: suspended ? Math.max(0, at - this.lastServerAgeAt) : 0,
      serverAge: this.serverAge(),
      diagnostics: this.pauseDiagnostics(at),
    }
    for (const listener of this.suspensionListeners) listener(state)
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
    if (this.disconnected !== undefined || this.resetRequested) {
      const error = this.disconnected ?? new Error('provider reset requested; the connection is not authoritative')
      throw p2Error('CONNECTION_LOST', 'environment', error.message, { module: 'provider.mineflayer' })
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
    if (this.disconnected !== undefined || this.resetRequested) {
      const error = this.disconnected ?? new Error('provider reset requested; the connection is not authoritative')
      return {
        status: 'failed',
        error: p2Error('CONNECTION_LOST', 'environment', error.message, { module: 'provider.mineflayer' }),
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
    if (this.disconnected !== undefined || this.resetRequested) {
      const error = this.disconnected ?? new Error('provider reset requested; the connection is not authoritative')
      throw p2Error('CONNECTION_LOST', 'environment', error.message, { module: 'provider.mineflayer' })
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
    if (name !== 'stop' && this.current?.controlState?.() !== undefined && this.current.controlState() !== 'idle') {
      throw p2Error('STOP_UNCONFIRMED', 'runtime', 'previous act has not released control', { module: 'provider.mineflayer' })
    }
    const handle = new MineflayerActHandle(name, args, this.bot, this.options)
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
  private combatInterval: ReturnType<typeof setInterval> | undefined
  private combatRelease: (() => void) | undefined
  private combatShieldActive = false
  private readonly startedAt = Date.now()
  private motionRun: MotionRun | undefined
  private vanillaRun: VanillaRun | undefined
  private motionTarget: Cell | undefined
  private failureDetails: JsonValue | undefined

  constructor(
    private readonly name: string,
    private readonly args: Record<string, JsonValue>,
    private readonly bot: Bot,
    private readonly options: Required<MineflayerProviderOptions>,
  ) {
    this.run()
  }

  poll(): ActPoll {
    if (this.stopRequested && !this.cancelled) this.refreshRelease()
    if (this.cancelled) return { status: 'cancelled' }
    if (this.failed !== undefined) {
      return {
        status: 'failed',
        error: p2Error(this.failedCode, actErrorCategory(this.failedCode), this.failed.message, { module: 'provider.mineflayer', nodePath: this.name }, this.failureDetails),
      }
    }
    if (!this.completed && this.failed === undefined && this.motionRun !== undefined) {
      const result = this.motionRun.tick(Date.now())
      if (result.state === 'succeeded') {
        this.result = result.observed ?? this.position()
        this.completed = true
      } else if (result.state === 'failed') {
        this.failed = new Error(result.code ?? 'GOTO_ERROR')
        this.failedCode = result.code ?? 'GOTO_ERROR'
        this.failureDetails = this.withVanillaAlternative(result.code, result.observed)
      } else if (result.state === 'canceled') {
        this.cancelled = true
      }
    }
    if (!this.completed && this.failed === undefined && this.vanillaRun !== undefined) {
      const result = this.vanillaRun.tick(Date.now())
      if (result.state === 'succeeded') {
        this.result = result.observed ?? this.position()
        this.completed = true
      } else if (result.state === 'failed') {
        this.failed = new Error(result.code ?? 'VANILLA_ERROR')
        this.failedCode = result.code ?? 'VANILLA_ERROR'
        this.failureDetails = result.observed
      } else if (result.state === 'canceled') {
        this.cancelled = true
      }
    }
    if (!this.completed && this.name !== 'motion-goto'
      && Date.now() - this.startedAt > this.options.actionTimeoutMs) {
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
        error: p2Error(this.failedCode, actErrorCategory(this.failedCode), this.failed.message, { module: 'provider.mineflayer', nodePath: this.name }, this.failureDetails),
      }
    }
    if (this.motionRun !== undefined) {
      return { status: 'running', progress: this.motionRun.report() }
    }
    if (this.vanillaRun !== undefined) {
      return { status: 'running', progress: this.vanillaRun.report() }
    }
    return { status: 'running' }
  }

  stop(): void {
    if (this.stopRequested || this.completed) return
    this.stopRequested = true
    this.forceAbort()
    // A cancel flag alone never proves the effect is gone: confirm only what
    // the provider can still observe (pathfinder path, dig target, craft loop).
    this.refreshRelease()
  }

  /** Requested but not yet observed: the release watchdog's observation window. */
  stopPending(): boolean {
    return this.stopRequested && !this.cancelled && !this.completed
  }

  /**
   * Idempotent cleanup for every way an act can end abruptly. `stop()` and
   * `abort()` share it so a timeout, a death or a connection loss leave the
   * same observable state instead of an act-specific residue.
   */
  private forceAbort(): void {
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
    if (this.combatInterval !== undefined) {
      clearInterval(this.combatInterval)
      this.combatInterval = undefined
    }
    if (this.name === 'combat-step') {
      if (this.combatShieldActive) {
        attempt(() => this.bot.deactivateItem())
        this.combatShieldActive = false
      }
      this.combatRelease = undefined
    }
    if (this.name === 'dig') {
      attempt(() => this.bot.stopDigging())
      attempt(() => { (this.bot as unknown as { targetDigBlock: unknown }).targetDigBlock = null })
    }
    if (this.name === 'use' || this.name === 'fish') attempt(() => this.bot.deactivateItem())
    if (this.name === 'motion-goto') {
      if (this.motionRun !== undefined) {
        if (!this.motionRun.stop()) unknown = true
      }
      if (this.vanillaRun !== undefined) {
        if (!this.vanillaRun.stop()) unknown = true
      }
    }
    if (this.name === 'sleep') {
      // Documented way out of a bed; stop() must not leave the bot asleep.
      attempt(() => { void this.bot.wake() })
    }
    attempt(() => this.bot.clearControlStates())
    // A timed-out container/craft/trade act can leave a window open; release is
    // only confirmed once the window is gone.
    attempt(() => this.closeOpenWindow())
    // The client inventory model lags after a timeout; the next act reads the
    // world, so refresh it once here (best effort, not a release proof).
    attempt(() => { void this.syncInventoryWindow() })
    if (unknown) this.releaseUnknown = true
  }

  private closeOpenWindow(): void {
    const window = this.bot.currentWindow as unknown as { close?: () => Promise<void> } | null
    if (window === null || window === undefined) return
    void window.close?.().catch(() => {
      // The server may already have closed it; refreshRelease re-observes.
    })
  }

  /**
   * Attach a vanilla-mode alternative to a safe-planner refusal. The alternative
   * is *evidence only*: it says an unvalidated path exists (and how far it gets),
   * never that the target is safely reachable, and it is not executed.
   */
  private withVanillaAlternative(code: string | undefined, observed: JsonValue | undefined): JsonValue | undefined {
    if (code !== 'GOTO_NO_PATH' && code !== 'GOTO_SEARCH_TIMEOUT') return observed
    const target = this.motionTarget
    if (target === undefined) return observed
    try {
      const world = new MineflayerMotionWorld(this.bot)
      const reader = new VanillaNodeReader(world)
      const plan = planVanillaPath(reader, cellOf(world.self().pos), target, {
        maxNodes: 1024,
        maxDistance: 32,
        timeoutMs: 250,
      })
      const alternative: JsonValue = {
        planner: 'vanilla',
        unvalidated: true,
        available: plan.reached,
        waypoints: plan.waypoints.length,
        closest: Number.isFinite(plan.closest) ? plan.closest : null,
        ...(plan.goalAdjustedTo === undefined ? {} : { goalAdjustedTo: { ...plan.goalAdjustedTo } }),
      }
      const base: Record<string, JsonValue> = observed !== null && typeof observed === 'object' && !Array.isArray(observed)
        ? observed as Record<string, JsonValue>
        : { run: observed ?? null }
      return { ...base, alternative }
    } catch {
      return observed
    }
  }

  /**
   * Fold the observable control state into a release conclusion. Until this
   * succeeds the handle keeps reporting `running`/`active`, which is what makes
   * a lazy stop visible instead of a false "already stopped".
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
    if (this.name === 'dig') {
      const target = (this.bot as unknown as { targetDigBlock?: unknown }).targetDigBlock
      if (target !== null && target !== undefined) return false
    }
    if (this.name === 'craft' && this.craftRunning) return false
    if (this.name === 'sleep' && (this.bot as unknown as { isSleeping?: boolean }).isSleeping === true) return false
    const window = (this.bot as unknown as { currentWindow?: unknown }).currentWindow
    if (window !== null && window !== undefined) return false
    const getControlState = (this.bot as unknown as { getControlState?: (name: string) => boolean }).getControlState
    if (typeof getControlState === 'function') {
      for (const state of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'] as const) {
        if (getControlState.call(this.bot, state) === true) return false
      }
    }
    // A combat step may still be holding the shield; release is unconfirmed
    // until the client reports the item use ended.
    if ((this.bot as unknown as { usingHeldItem?: boolean }).usingHeldItem === true) return false
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

  /** Preserve the caller's explicit hazard permission in the terminal code. */
  deathCode(): string {
    return this.name === 'fatal-step' ? 'DIED_IN_ALLOWED_HAZARD' : 'DEATH'
  }

  abort(error: Error, code = 'ACT_FAILED'): void {
    if (this.cancelled || this.completed) return
    this.failed = error
    this.failedCode = code
    this.forceAbort()
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
        case 'fatal-step': {
          const x = typeof this.args.x === 'number' ? this.args.x : undefined
          const y = typeof this.args.y === 'number' ? this.args.y : undefined
          const z = typeof this.args.z === 'number' ? this.args.z : undefined
          if (x === undefined || y === undefined || z === undefined) throw new Error('fatal-step requires numeric x, y and z')
          void this.bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true).then(() => {
            if (this.stopRequested) return
            this.bot.setControlState('forward', true)
            this.timer = setTimeout(() => {
              try {
                this.bot.setControlState('forward', false)
              } catch {
                // Connection loss is observed by the lifecycle layer.
              }
              this.result = this.position()
              this.completed = true
            }, 700)
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = 'HAZARD_STEP_FAILED'
          })
          return
        }
        case 'motion-goto': {
          const { x, y, z } = this.args
          if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
            this.failed = new Error('motion-goto requires numeric x, y and z')
            this.failedCode = 'BAD_ARGS'
            return
          }
          const range = this.args.exact === true ? 0 : typeof this.args.range === 'number' ? this.args.range : 1
          const unstickDig = parseUnstickBlocks(this.args.unstickDig)
          if (unstickDig === null) {
            this.failed = new Error('unstickDig requires at most 2 integer coordinates with expected names')
            this.failedCode = 'BAD_ARGS'
            return
          }
          const timeout = Math.min(
            typeof this.args.timeoutMs === 'number' ? this.args.timeoutMs : 30_000,
            this.options.actionTimeoutMs,
          )
          if (this.args.planner === 'vanilla') {
            this.motionTarget = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
            this.vanillaRun = new VanillaRun(this.bot, this.motionTarget, {}, timeout)
            this.vanillaRun.start()
            return
          }
          const constraints = defaultConstraints('walk')
          if (this.args.allowParkour === true) constraints.allowParkour = true
          if (this.args.allowDiagonal === true) constraints.allowDiagonal = true
          if (this.args.allowPlace === true) constraints.allowPlace = true
          if (typeof this.args.material === 'string') constraints.material = this.args.material
          if (unstickDig !== undefined && unstickDig.length > 0) {
            constraints.allowBreak = true
            constraints.breakTargets = unstickDig
          }
          const arrival = this.args.exact === true
            ? { kind: 'exact' as const }
            : this.args.intent === 'interact' && range <= 1.5
              ? { kind: 'adjacent' as const }
              : { kind: 'near' as const, range }
          this.motionTarget = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
          this.motionRun = new MotionRun(
            this.bot,
            this.motionTarget,
            range,
            timeout,
            {
              constraints,
              arrival,
              ...(this.args.allowUnsupportedGoal === true ? { allowUnsupportedGoal: true } : {}),
            },
          )
          this.motionRun.start()
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
          const requestedFace = typeof this.args.face === 'string' ? this.args.face : 'up'
          if (PLACE_FACES[requestedFace] === undefined) {
            throw new Error(`unsupported place face: ${requestedFace}`)
          }
          const itemName = typeof this.args.item === 'string'
            ? this.args.item.replace(/^minecraft:/u, '')
            : ''
          if (itemName.length === 0) {
            this.failed = new Error('place requires an item name')
            this.failedCode = 'BAD_ARGS'
            return
          }
          const target = new Vec3(x, y, z)
          const supports: Record<string, boolean> = {}
          for (const [name, vector] of Object.entries(PLACE_FACES)) {
            const reference = new Vec3(x - vector[0], y - vector[1], z - vector[2])
            supports[name] = isPlaceSupport(this.bot.blockAt(reference))
          }
          const targetBlock = this.bot.blockAt(target)
          if (targetBlock === null) {
            this.failed = new Error(`place target ${x},${y},${z} is not loaded`)
            this.failedCode = 'OBSERVATION_UNAVAILABLE'
            this.failureDetails = { target: { x, y, z }, supports, requestedFace }
            return
          }
          // A target that already has the requested block is already done; no
          // item, equip or packet is needed.
          if (targetBlock.name === itemName) {
            this.result = {
              name: targetBlock.name,
              x,
              y,
              z,
              face: requestedFace,
              alreadyPlaced: true,
              placedAt: { x, y, z },
              placedCells: [{ x, y, z }],
            }
            this.completed = true
            return
          }
          // Placing into a colliding block is refused by the server. Stop before
          // touching the inventory or spending a packet. Tagged replaceable
          // blocks (grass, snow layer, ...) are still legal targets.
          const targetType = (targetBlock as unknown as { type?: number }).type
          const targetTags = typeof targetType === 'number'
            ? blockTagsFor(this.bot).tagsFor(targetType)
            : undefined
          if (isTargetOccupied(targetBlock) && !isReplaceableTargetBlock(targetBlock, targetTags)) {
            this.failed = new Error(`target ${x},${y},${z} is occupied by ${targetBlock.name}`)
            this.failedCode = 'PLACE_TARGET_OCCUPIED'
            this.failureDetails = {
              target: { x, y, z },
              block: targetBlock.name,
              supports,
              requestedFace,
            }
            return
          }
          // The driver selected one face. Honour it exactly: a provider-side
          // six-face fallback used to hide which face actually failed and could
          // consume one item across several attempts.
          const chosenVector = PLACE_FACES[requestedFace]
          if (chosenVector === undefined) throw new Error(`unsupported place face: ${requestedFace}`)
          const reference = new Vec3(x - chosenVector[0], y - chosenVector[1], z - chosenVector[2])
          const referenceBlock = this.bot.blockAt(reference)
          if (referenceBlock === null || !isPlaceSupport(referenceBlock)) {
            this.failed = new Error(`no support block on face ${requestedFace} of ${x},${y},${z}`)
            this.failedCode = 'PLACE_UNSUPPORTED'
            this.failureDetails = {
              target: { x, y, z },
              face: requestedFace,
              requestedFace,
              supports,
              reference: { x: reference.x, y: reference.y, z: reference.z },
              // No packet was sent: another face can be tried safely.
              retrySafe: true,
            }
            return
          }
          const chosenFace = requestedFace
          const chosenReference = referenceBlock
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
            if (held === null || held === undefined || held.name !== itemName) {
              throw Object.assign(new Error(`no ${itemName} is held for placement`), { code: 'PLACE_NO_ITEM' })
            }
            const before = snapshotPlaceNeighborhood(
              point => this.bot.blockAt(new Vec3(point.x, point.y, point.z)),
              { x, y, z },
            )
            const itemCountBefore = countItem(this.bot.inventory.items(), itemName)
            const wasSneaking = typeof this.bot.getControlState === 'function'
              && this.bot.getControlState('sneak')
            let placeError: unknown
            try {
              // Interactive reference blocks (crafting table, chest, furnace,
              // ...) consume a plain right-click to open their UI. Sneaking is
              // the vanilla way to place against them instead.
              if (!wasSneaking && typeof this.bot.setControlState === 'function') {
                this.bot.setControlState('sneak', true)
              }
              await this.bot.placeBlock(chosenReference, new Vec3(chosenVector[0], chosenVector[1], chosenVector[2]))
            } catch (error) {
              placeError = error
            } finally {
              if (!wasSneaking && typeof this.bot.setControlState === 'function') {
                this.bot.setControlState('sneak', false)
              }
            }
            await this.syncInventoryWindow()
            const after = snapshotPlaceNeighborhood(
              point => this.bot.blockAt(new Vec3(point.x, point.y, point.z)),
              { x, y, z },
            )
            const diff = diffPlacement(before, after, itemName)
            const itemCountAfter = countItem(this.bot.inventory.items(), itemName)
            const consumed = itemConsumed(itemCountBefore, itemCountAfter)
            const targetAfter = this.bot.blockAt(target)
            const targetPlaced = diff.placedCells.some(cell => samePlacePoint(cell, { x, y, z }))
              || (targetAfter !== null && targetAfter.name === itemName)
            if (placeError === undefined && targetPlaced) {
              return {
                name: itemName,
                x,
                y,
                z,
                face: chosenFace,
                placedAt: { x, y, z },
                placedCells: diff.placedCells.length === 0 ? [{ x, y, z }] : diff.placedCells,
                itemCountBefore,
                itemCountAfter,
                itemConsumed: consumed,
                ...(diff.changedCells.length === 0 ? {} : { changedCells: diff.changedCells }),
              }
            }
            const message = placeError instanceof Error
              ? placeError.message
              : placeError === undefined
                ? `server did not place ${itemName} at ${x},${y},${z}`
                : String(placeError)
            const code = diff.placedCells.length > 0 && !targetPlaced
              ? 'PLACE_OFF_TARGET'
              : consumed === true ? 'PLACE_ITEM_CONSUMED' : 'PLACE_FAILED'
            throw Object.assign(new Error(message), {
              code,
              details: {
                target: { x, y, z },
                face: chosenFace,
                requestedFace,
                providerCode: code,
                providerMessage: message.slice(0, 200),
                supports,
                placedAt: diff.placedCells[0] ?? null,
                placedCells: diff.placedCells,
                changedCells: diff.changedCells,
                itemCountBefore,
                itemCountAfter,
                itemConsumed: consumed,
                retrySafe: retrySafe({ message, consumed, placedCells: diff.placedCells }),
              },
            })
          })().then(result => {
            this.result = result
            this.completed = true
          }).catch((error: unknown) => {
            const failed = error instanceof Error ? error : new Error(String(error))
            this.failed = failed
            this.failedCode = typeof (error as { code?: unknown }).code === 'string'
              ? (error as { code: string }).code
              : 'PLACE_FAILED'
            // The driver needs the face and the provider's own error text to
            // explain a placement that did not read back; keep it structured.
            const details = (error as { details?: JsonValue }).details
            this.failureDetails = details ?? {
              face: chosenFace,
              providerCode: this.failedCode,
              providerMessage: failed.message.slice(0, 200),
              supports,
              requestedFace,
            }
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
            const equipped = destination === 'hand'
              ? this.bot.heldItem
              : destination === 'off-hand' ? this.bot.inventory.slots[45] : undefined
            return {
              item: item.name,
              destination,
              held: held === null || held === undefined ? null : held.name,
              equipped: equipped === null || equipped === undefined ? null : equipped.name,
            }
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
          void (async () => {
            await this.syncInventoryWindow()
            const before = destination === 'hand'
              ? this.bot.heldItem
              : destination === 'off-hand' ? this.bot.inventory.slots[45] : undefined
            await this.bot.unequip(destination as EquipmentDestination)
            await this.syncInventoryWindow()
            const after = destination === 'hand'
              ? this.bot.heldItem
              : destination === 'off-hand' ? this.bot.inventory.slots[45] : undefined
            return {
              destination,
              item: before === null || before === undefined ? null : before.name,
              held: this.bot.heldItem === null || this.bot.heldItem === undefined ? null : this.bot.heldItem.name,
              equipped: after === null || after === undefined ? null : after.name,
            }
          })().then(result => {
            this.result = result
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
        case 'combat-step': {
          const x = typeof this.args.x === 'number' ? this.args.x : undefined
          const y = typeof this.args.y === 'number' ? this.args.y : undefined
          const z = typeof this.args.z === 'number' ? this.args.z : undefined
          const faceX = typeof this.args.faceX === 'number' ? this.args.faceX : undefined
          const faceZ = typeof this.args.faceZ === 'number' ? this.args.faceZ : undefined
          if (x === undefined || y === undefined || z === undefined || faceX === undefined || faceZ === undefined) {
            this.failed = new Error('combat-step requires numeric x/y/z and faceX/faceZ')
            this.failedCode = 'BAD_ARGS'
            return
          }
          const from = this.bot.entity.position
          const cell = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
          const chebyshev = Math.max(
            Math.abs(cell.x - Math.floor(from.x)),
            Math.abs(cell.z - Math.floor(from.z)),
          )
          if (chebyshev !== 1) {
            this.failed = new Error(`combat-step target is not adjacent (chebyshev ${chebyshev})`)
            this.failedCode = 'COMBAT_STEP_INVALID_CELL'
            return
          }
          const feetDelta = y - from.y
          if (feetDelta > 0.6 || feetDelta < -1.6) {
            this.failed = new Error(`combat-step height ${feetDelta.toFixed(2)} is not supported`)
            this.failedCode = 'COMBAT_STEP_UNSUPPORTED_HEIGHT'
            return
          }
          const faceYaw = Math.atan2(-(faceX - from.x), -(faceZ - from.z))
          const faceDirX = -Math.sin(faceYaw)
          const faceDirZ = -Math.cos(faceYaw)
          const rightDirX = Math.cos(faceYaw)
          const rightDirZ = -Math.sin(faceYaw)
          const toX = cell.x + 0.5 - from.x
          const toZ = cell.z + 0.5 - from.z
          const length = Math.hypot(toX, toZ) || 1
          const forwardComponent = (toX / length) * faceDirX + (toZ / length) * faceDirZ
          const rightComponent = (toX / length) * rightDirX + (toZ / length) * rightDirZ
          const controls: Array<'forward' | 'back' | 'left' | 'right'> = []
          if (forwardComponent > 0.25) controls.push('forward')
          else if (forwardComponent < -0.25) controls.push('back')
          if (rightComponent > 0.25) controls.push('right')
          else if (rightComponent < -0.25) controls.push('left')
          if (controls.length === 0) controls.push('forward')
          const holdShield = this.args.shield === true
          const timeoutMs = typeof this.args.timeoutMs === 'number'
            ? Math.max(100, Math.min(3_000, this.args.timeoutMs))
            : 900
          const startedAt = Date.now()
          const startPos = { x: from.x, y: from.y, z: from.z }
          let lastPos = { x: from.x, y: from.y, z: from.z }
          let lastProgressAt = startedAt
          let shieldUsed = false
          const release = (): void => {
            try { this.bot.clearControlStates() } catch { /* connection may be gone */ }
            if (this.combatShieldActive) {
              try { this.bot.deactivateItem() } catch { /* connection may be gone */ }
              this.combatShieldActive = false
            }
            this.combatRelease = undefined
          }
          const finish = (failed?: string): void => {
            if (this.completed || this.failed !== undefined) return
            if (this.combatInterval !== undefined) {
              clearInterval(this.combatInterval)
              this.combatInterval = undefined
            }
            if (this.timer !== undefined) {
              clearTimeout(this.timer)
              this.timer = undefined
            }
            release()
            const pos = this.bot.entity.position
            const observed = {
              from: startPos,
              to: { x: pos.x, y: pos.y, z: pos.z },
              shieldUsed,
              elapsedMs: Date.now() - startedAt,
            }
            if (failed !== undefined) {
              this.failed = new Error(`combat-step ${failed}`)
              this.failedCode = failed
              return
            }
            this.result = observed
            this.completed = true
          }
          this.combatRelease = release
          const startControls = (): void => {
            if (this.completed || this.failed !== undefined) return
            for (const control of controls) this.bot.setControlState(control, true)
            this.combatInterval = setInterval(() => {
              if (this.completed || this.failed !== undefined) return
              const pos = this.bot.entity.position
              const moved = Math.hypot(pos.x - lastPos.x, pos.y - lastPos.y, pos.z - lastPos.z)
              if (moved > 0.05) {
                lastPos = { x: pos.x, y: pos.y, z: pos.z }
                lastProgressAt = Date.now()
              }
              if (Math.hypot(pos.x - (cell.x + 0.5), pos.z - (cell.z + 0.5)) <= 0.5
                && Math.abs(pos.y - y) <= 0.7) {
                finish()
                return
              }
              if (Date.now() - lastProgressAt > 300) {
                finish('COMBAT_STEP_NO_PROGRESS')
                return
              }
              const block = this.bot.blockAt(new Vec3(cell.x, cell.y, cell.z))
              if (block !== null && ['lava', 'water', 'fire', 'soul_fire'].includes(block.name)) {
                finish('COMBAT_STEP_UNSAFE')
              }
            }, 50)
            this.timer = setTimeout(() => finish('COMBAT_STEP_TIMEOUT'), timeoutMs)
          }
          void this.bot.look(faceYaw, 0, true).then(() => {
            if (this.completed || this.failed !== undefined) return
            if (holdShield) {
              const offhand = this.bot.inventory.slots[45]
              if (offhand !== null && offhand !== undefined && /shield/u.test(offhand.name)) {
                try {
                  this.bot.activateItem(true)
                  shieldUsed = true
                  this.combatShieldActive = true
                } catch {
                  shieldUsed = false
                }
              }
            }
            // Let the server see the block state before the body starts moving.
            if (shieldUsed) this.timer = setTimeout(startControls, 50)
            else startControls()
          }).catch((error: unknown) => {
            release()
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = 'COMBAT_STEP_LOOK_FAILED'
          })
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
          void this.craftFlow(itemType, name, count).then(result => {
            this.result = result
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = typeof (error as { code?: unknown }).code === 'string'
              ? (error as { code: string }).code
              : 'CRAFT_FAILED'
            this.failureDetails = (error as { details?: JsonValue }).details
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
      if (this.motionRun !== undefined) {
        this.failedCode = this.motionRun.stop() ? 'GOTO_ERROR' : 'STOP_UNCONFIRMED'
        this.releaseUnknown = this.failedCode === 'STOP_UNCONFIRMED'
        this.failureDetails = this.motionRun.report()
      }
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
   * Abortable delay so a stopped craft chain stops between recipes.
   */
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
   * Resolve the recipe after refreshing the inventory model, preferring a
   * no-table recipe so a nearby table never narrows the candidate set. Falls
   * back to a table recipe only when one exists and a table is actually found.
   */
  private async craftFlow(itemType: number, name: string, count: number): Promise<JsonValue> {
    await this.syncInventoryWindow()
    this.ensureNotStopped()
    const table = this.craftTable()
    const all = this.bot.recipesAll(itemType, null, true)
    let recipe = this.bot.recipesFor(itemType, null, 1, null)[0]
    let usedTable = false
    if (recipe === undefined && table !== undefined) {
      recipe = this.bot.recipesFor(itemType, null, 1, table)[0]
      usedTable = recipe !== undefined
    }
    if (recipe === undefined) {
      const requiresTable = all.length > 0 && all.every(entry => entry.requiresTable)
      const code = requiresTable && table === undefined ? 'CRAFT_NO_TABLE' : 'CRAFT_NO_INGREDIENTS'
      const detail = requiresTable && table === undefined
        ? `crafting ${name} requires a crafting table`
        : `no craftable recipe for ${name}`
      throw Object.assign(new Error(detail), {
        code,
        details: {
          item: name,
          recipeCount: all.length,
          requiresTable,
          tableFound: table !== undefined,
        },
      })
    }
    const result = await this.craftRepeatedly(
      recipe,
      count,
      usedTable ? table : undefined,
      itemType,
      name,
    )
    return {
      ...result,
      usedTable,
      requiresTable: recipe.requiresTable === true,
      recipeCount: all.length,
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
  ): Promise<Record<string, JsonValue>> {
    this.craftRunning = true
    try {
      await this.syncInventoryWindow()
      this.ensureNotStopped()
      const before = this.inventoryCountOfType(itemType)
      const perCraft = recipe.result?.count ?? 1
      const neededCrafts = Math.max(1, Math.ceil(requested / perCraft))
      let crafted = 0
      let lastError: unknown
      for (let attempt = 0; attempt < neededCrafts; attempt += 1) {
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
      const expected = perCraft * crafted
      if (produced < requested || produced < expected) {
        throw Object.assign(
          new Error(
            `crafted ${crafted}/${neededCrafts} operations of ${name} (produced ${produced}, requested ${requested})`
            + (lastError === undefined ? '' : `: ${errorMessage(lastError)}`),
          ),
          {
            code: 'CRAFT_INCOMPLETE',
            details: { item: name, requested, neededCrafts, crafted, produced, expected },
          },
        )
      }
      return { item: name, requested, neededCrafts, crafted, produced }
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
    if (itemType === undefined) {
      throw Object.assign(new Error(`unknown item: ${name}`), { code: 'CONTAINER_NO_ITEM' })
    }
    const window = await openContainerWindow(this.bot, block)
    const playerBefore = this.inventoryCountOfType(itemType)
    const containerBefore = countContainerItems(window, name)
    let containerAfter: number | undefined
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
      // Window slot updates are asynchronous; give the server one bounded tick
      // before taking the container-side readback.
      await this.waitAbortable(150)
      containerAfter = countContainerItems(window, name)
    } finally {
      await closeWindowQuietly(window)
    }
    // The player inventory model converges after the window closes.
    await this.syncInventoryWindow()
    const playerAfter = this.inventoryCountOfType(itemType)
    return {
      action,
      kind: block.name,
      item: name.length === 0 ? null : name,
      count,
      playerBefore,
      playerAfter,
      containerBefore: containerBefore ?? null,
      containerAfter: containerAfter ?? null,
    }
  }
}

function reasonText(reason: unknown): string {
  if (typeof reason === 'string') return reason.slice(0, 500)
  if (reason !== null && typeof reason === 'object') {
    const text = (reason as { toString?: () => string }).toString?.()
    if (typeof text === 'string' && text !== '[object Object]') return text.slice(0, 500)
    try {
      return JSON.stringify(reason).slice(0, 500)
    } catch {
      // Fall through to the generic string form.
    }
  }
  return String(reason).slice(0, 500)
}

function actErrorCategory(code: string): 'environment' | 'runtime' | 'timeout' {
  if (code === 'GAME_PAUSED' || code === 'CONNECTION_LOST' || code === 'MOVE_TO_BLOCKED') return 'environment'
  if (code === 'PLACE_NO_ITEM' || code === 'PLACE_UNSUPPORTED' || code === 'PLACE_TARGET_OCCUPIED'
    || code === 'PLACE_OFF_TARGET' || code === 'PLACE_ITEM_CONSUMED'
    || code === 'ATTACK_NO_TARGET' || code === 'EQUIP_NO_ITEM' || code === 'USE_NO_ITEM') return 'environment'
  if (code === 'ACT_TIMEOUT' || code === 'MOVE_TO_TIMEOUT') return 'timeout'
  return 'runtime'
}

export type { QueryOutcome }





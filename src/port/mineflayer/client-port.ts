import type { Bot } from 'mineflayer'
import { Vec3 as Vec3Class } from 'vec3'

import { p2Error } from '../../contracts/protocol.ts'
import type { JsonValue, P2Error } from '../../contracts/types.ts'
import type { ActHandle, ActPoll } from '../../provider/runtime.ts'
import type { Capability, ClientAction } from '../capabilities.ts'
import { checkCapability } from '../capabilities.ts'
import type { ClientEvent, ClientPort, ContainerTransferAction, MoveOptions } from '../client-port.ts'
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
} from '../types.ts'
import { PortErrorCodes, actFailed, actOk, actUnknown } from '../types.ts'
import { WriteGate, staleWriteResult, type WriteToken } from '../write-token.ts'

/** The act half of the provider; the port only starts bounded actions. */
export type MineflayerActSource = {
  capabilities: readonly string[]
  start(name: string, args: Record<string, JsonValue>): ActHandle
}

export type MineflayerPortOptions = {
  /** Monotonic clock; tests may substitute one. */
  now?: () => number
  pollIntervalMs?: number
  /** Stable world id from config; dimension is appended by the port. */
  worldId?: string
  /** Hard caps may be lowered (never raised) by the body's configuration. */
  timeouts?: Partial<Record<ClientAction, number>>
}

/** Hard cap per action; the driver's budget can only lower it. */
const ACTION_TIMEOUTS = {
  moveTo: 30_000,
  lookAt: 5_000,
  dig: 15_000,
  place: 10_000,
  useItem: 5_000,
  equip: 5_000,
  useOn: 5_000,
  attack: 2_000,
  sleep: 30_000,
  screen: 5_000,
  containerTransfer: 10_000,
} as const

type BlockLike = {
  name: string
  boundingBox?: string
  shapes?: number[][]
  material?: string
  diggable?: boolean
  hardness?: number
  harvestTools?: Record<string, boolean>
  getProperties?: () => Record<string, string | number | boolean>
}

type EntityLike = {
  id?: number
  name?: string
  username?: string
  type?: string
  kind?: string
  position?: { x: number; y: number; z: number }
  width?: number
  height?: number
  metadata?: Record<number, unknown>
}

type WaitResult =
  | { kind: 'done'; poll: ActPoll }
  | { kind: 'timeout'; released: boolean; observed?: JsonValue }

/**
 * ClientPort over one mineflayer bot. Reads come from the live bot; writes go
 * through the provider's bounded act handles so the hard-won control release
 * and readback behaviour is reused instead of duplicated.
 */
export class MineflayerClientPort implements ClientPort {
  private readonly gate = new WriteGate()
  private readonly running = new Set<{ handle: ActHandle; epoch: number }>()
  private readonly listeners = new Map<ClientEvent, Set<(payload: JsonValue) => void>>()
  private readonly capabilityList: Capability[]
  private readonly timeouts: Record<ClientAction, number>
  private readonly now: () => number
  private readonly pollIntervalMs: number
  private readonly worldId: string

  constructor(
    private readonly bot: Bot,
    private readonly acts: MineflayerActSource,
    options: MineflayerPortOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now())
    this.pollIntervalMs = options.pollIntervalMs ?? 20
    this.worldId = options.worldId ?? 'unknown'
    this.capabilityList = portCapabilities(acts.capabilities)
    this.timeouts = { ...ACTION_TIMEOUTS, ...options.timeouts }
    this.wireEvents()
  }

  self(): SelfInfo {
    const entity = this.bot.entity as unknown as {
      position?: { x: number; y: number; z: number }
      yaw?: number
      pitch?: number
      onGround?: boolean
      isInWater?: boolean
      isInLava?: boolean
      width?: number
      height?: number
    } | undefined
    const position = entity?.position
    if (entity === undefined || position === undefined) throw unavailable('bot position is not available')

    return {
      pos: { x: position.x, y: position.y, z: position.z },
      yaw: entity.yaw ?? 0,
      pitch: entity.pitch ?? 0,
      health: this.bot.health,
      food: this.bot.food,
      onGround: entity.onGround === true,
      inWater: entity.isInWater === true,
      inLava: entity.isInLava === true,
      ...(typeof entity.width === 'number' ? { width: entity.width } : {}),
      ...(typeof entity.height === 'number' ? { height: entity.height } : {}),
    }
  }

  blockAt(p: Vec3): BlockInfo | null {
    const block = this.bot.blockAt(new Vec3Class(p.x, p.y, p.z)) as unknown as BlockLike | null
    return block === null ? null : blockInfo(block, this.bot.registry)
  }

  identity(): { worldId: string; characterId: string } {
    const dimension = (this.bot.game as unknown as { dimension?: string }).dimension ?? 'unknown'
    const player = this.bot.player as unknown as { uuid?: string; username?: string } | undefined
    return {
      worldId: `${this.worldId}:${dimension}`,
      characterId: player?.uuid ?? player?.username ?? this.bot.username,
    }
  }

  async containerAt(p: Vec3): Promise<ContainerCheckResult> {    const block = this.bot.blockAt(new Vec3Class(p.x, p.y, p.z)) as unknown as BlockLike | null
    if (block === null) return { state: 'unknown', code: 'CHECK_NOT_LOADED' }
    const info = blockInfo(block, this.bot.registry)
    if (!info.loaded) return { state: 'unknown', code: 'CHECK_NOT_LOADED' }
    type ContainerWindow = {
      containerItems?: () => Array<{ slot?: number; name: string; count: number }>
      slots?: Array<{ slot?: number; name: string; count: number } | null>
      close?: () => Promise<void>
      fuel?: number
      progress?: number
    }
    let window: ContainerWindow | undefined
    try {
      const open = block.name.includes('furnace')
        ? this.bot.openFurnace(block as never)
        : this.bot.openContainer(block as never)
      window = await Promise.race([
        open as unknown as Promise<ContainerWindow>,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('container open timed out')), 5_000)
        }),
      ])
      const raw = typeof window.containerItems === 'function'
        ? window.containerItems()
        : (window.slots ?? []).filter((item): item is { slot?: number; name: string; count: number } =>
            item !== null && item !== undefined)
      const items = raw.map((item, index) => ({
        slot: typeof item.slot === 'number' ? item.slot : index,
        name: item.name,
        count: item.count,
      }))
      const result: ContainerCheckResult = {
        state: 'ok',
        block: info.name,
        items,
        ...(typeof window.fuel === 'number' ? { fuel: window.fuel } : {}),
        ...(typeof window.progress === 'number' ? { progress: window.progress } : {}),
      }
      await window.close?.()
      return result
    } catch (error) {
      try {
        await window?.close?.()
      } catch {
        // Closing is best effort after a failed open.
      }
      return {
        state: 'failed',
        code: 'CHECK_OPEN_FAILED',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  biomeAt(p: Vec3): BiomeInfo | null {
    const block = this.bot.blockAt(new Vec3Class(p.x, p.y, p.z)) as unknown as {
      biome?: { id?: number; name?: string }
    } | null
    const biome = block?.biome
    if (biome === undefined) return null
    const id = typeof biome.id === 'number' ? biome.id : -1
    const registered = (this.bot.registry as unknown as { biomes?: Record<string, { name?: string }> }).biomes?.[String(id)]
    const name = typeof biome.name === 'string' && biome.name.length > 0
      ? biome.name
      : registered?.name ?? `biome_${id}`
    return { id, name }
  }

  blocksIn(box: Box, filter?: string[]): BlockInfo[] {
    const result: BlockInfo[] = []
    const minX = Math.floor(box.min.x)
    const minY = Math.floor(box.min.y)
    const minZ = Math.floor(box.min.z)
    const maxX = Math.floor(box.max.x)
    const maxY = Math.floor(box.max.y)
    const maxZ = Math.floor(box.max.z)
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
          const block = this.bot.blockAt(new Vec3Class(x, y, z)) as unknown as BlockLike | null
          if (block === null) {
            // Unknown stays visible: an unloaded cell is never folded into air.
            result.push({ name: '', loaded: false, pos: { x, y, z } })
            continue
          }
          if (filter !== undefined && !filter.includes(block.name)) continue
          result.push({ ...blockInfo(block, this.bot.registry), pos: { x, y, z } })
        }
      }
    }
    return result
  }

  inventory(): Item[] {
    return this.bot.inventory.items().map(item => ({
      slot: item.slot ?? -1,
      name: item.name,
      count: item.count,
    }))
  }

  entities(box: Box): EntityInfo[] {
    const result: EntityInfo[] = []
    for (const entity of Object.values(this.bot.entities) as unknown as EntityLike[]) {
      const position = entity.position
      if (position === undefined) continue
      if (position.x < box.min.x || position.x > box.max.x) continue
      if (position.y < box.min.y || position.y > box.max.y) continue
      if (position.z < box.min.z || position.z > box.max.z) continue
      const item = resolveDroppedItem(this.bot.registry, entity)
      result.push({
        id: String(entity.id ?? -1),
        name: entity.username ?? entity.name ?? entity.type ?? 'unknown',
        position: { x: position.x, y: position.y, z: position.z },
        ...(typeof entity.width === 'number' ? { width: entity.width } : {}),
        ...(typeof entity.height === 'number' ? { height: entity.height } : {}),
        ...(entity.type === undefined ? {} : { type: entity.type }),
        ...(entity.kind === undefined ? {} : { kind: entity.kind }),
        ...(entity.username === undefined ? {} : { username: entity.username }),
        ...(item === undefined ? {} : { item }),
      })
    }
    return result
  }

  async screen(): Promise<ScreenInfo | null> {
    // The mineflayer provider has no screen snapshot support yet; the declared
    // capability list omits observe.screen, so `null` is not a silent success.
    return null
  }

  time(): { timeOfDay: number; worldAge: number } {
    const time = this.bot.time as unknown as { timeOfDay?: number | bigint; age?: number | bigint } | undefined
    const timeOfDay = numberOrUndefined(time?.timeOfDay)
    const worldAge = numberOrUndefined(time?.age)
    if (timeOfDay === undefined || worldAge === undefined) throw unavailable('server time is not available')
    return { timeOfDay, worldAge }
  }

  beginWrite(token: WriteToken): void {
    const epoch = this.gate.begin(token)
    for (const entry of [...this.running]) {
      if (entry.epoch !== epoch) this.stopHandle(entry.handle)
    }
  }

  endWrite(token: WriteToken): void {
    this.gate.end(token)
    for (const entry of [...this.running]) this.stopHandle(entry.handle)
  }

  async moveTo(target: Vec3 | Landmark, opts: MoveOptions = {}): Promise<ActResult> {
    const denied = this.deny('moveTo')
    if (denied !== undefined) return denied
    if (!isVec3(target)) return actFailed('INVALID_TARGET', 0)

    const range = opts.exact === true ? 0 : opts.range ?? 1
    if (![target.x, target.y, target.z, range, opts.timeoutMs ?? 1].every(Number.isFinite)
      || range < 0 || range > 8 || (opts.timeoutMs ?? 1) <= 0) return actFailed('INVALID_TARGET', 0)
    const timeoutMs = Math.min(opts.timeoutMs ?? this.timeouts.moveTo, this.timeouts.moveTo)
    return await this.run('goto', {
      x: target.x,
      y: target.y,
      z: target.z,
      range,
      timeoutMs,
      ...(opts.exact === undefined ? {} : { exact: opts.exact }),
      ...(opts.approach === undefined ? {} : { approach: opts.approach }),
      ...(opts.unstickDig === undefined ? {} : { unstickDig: opts.unstickDig }),
      ...(opts.intent === undefined ? {} : { intent: opts.intent }),
      ...(opts.hazards === undefined ? {} : { hazards: opts.hazards }),
    }, timeoutMs)
  }

  async lookAt(p: Vec3): Promise<ActResult> {
    return await this.action('lookAt', 'lookAt', { x: p.x, y: p.y, z: p.z })
  }

  async dig(p: Vec3): Promise<ActResult> {
    return await this.action('dig', 'dig', { x: p.x, y: p.y, z: p.z })
  }

  async place(p: Vec3, face: Face, item: string): Promise<ActResult> {
    const denied = this.deny('place')
    if (denied !== undefined) return denied

    const equipped = await this.ensureHeld(item)
    if (equipped !== undefined) return equipped
    return await this.run('place', { x: p.x, y: p.y, z: p.z, face, item }, this.timeouts.place)
  }

  async pillarUp(item: string, levels: number): Promise<ActResult> {
    const denied = this.deny('place')
    if (denied !== undefined) return denied
    if (!Number.isInteger(levels) || levels < 1 || levels > 8) return actFailed('INVALID_TARGET', 0)
    const equipped = await this.ensureHeld(item)
    if (equipped !== undefined) return equipped
    return await this.run('pillar', { count: levels }, this.timeouts.place + levels * 3_000)
  }

  async useItem(opts: { durationMs?: number } = {}): Promise<ActResult> {
    return await this.action(
      'useItem',
      'use',
      opts.durationMs === undefined ? {} : { durationMs: opts.durationMs },
    )
  }

  async equip(item: string): Promise<ActResult> {
    return await this.action('equip', 'equip', { item })
  }

  async craft(item: string, count = 1): Promise<ActResult> {
    const denied = this.deny('place')
    if (denied !== undefined) return denied
    return await this.run('craft', { item, count }, this.timeouts.place)
  }

  async useOn(p: Vec3): Promise<ActResult> {
    return await this.action('useOn', 'activate', { x: p.x, y: p.y, z: p.z })
  }

  async attack(entityId: string): Promise<ActResult> {
    const id = Number(entityId)
    if (!Number.isInteger(id)) return actFailed('INVALID_TARGET', 0)
    return await this.action('attack', 'attack', { entityId: id })
  }

  async sleep(bed: Vec3): Promise<ActResult> {
    return await this.action('sleep', 'sleep', { x: bed.x, y: bed.y, z: bed.z })
  }

  async containerTransfer(
    p: Vec3,
    action: ContainerTransferAction,
    item?: string,
    count?: number,
  ): Promise<ActResult> {
    return await this.action('containerTransfer', 'container-transfer', {
      x: p.x,
      y: p.y,
      z: p.z,
      action,
      ...(item === undefined ? {} : { item }),
      ...(count === undefined ? {} : { count }),
    })
  }

  say(text: string): void {
    this.bot.chat(text)
  }

  on(event: ClientEvent, cb: (payload: JsonValue) => void): void {
    let listeners = this.listeners.get(event)
    if (listeners === undefined) {
      listeners = new Set()
      this.listeners.set(event, listeners)
    }
    listeners.add(cb)
  }

  capabilities(): Capability[] {
    return [...this.capabilityList]
  }

  private deny(action: ClientAction): ActResult | undefined {
    const error = checkCapability(this.capabilityList, action)
    return error === undefined ? undefined : actFailed(error.code, 0)
  }

  private async action(
    action: 'lookAt' | 'dig' | 'useItem' | 'equip' | 'useOn' | 'attack' | 'sleep' | 'containerTransfer',
    name: string,
    args: Record<string, JsonValue>,
  ): Promise<ActResult> {
    const denied = this.deny(action)
    if (denied !== undefined) return denied
    return await this.run(name, args, this.timeouts[action])
  }

  /** Equip `item` when the held item is different; never place a wrong item. */
  private async ensureHeld(item: string): Promise<ActResult | undefined> {
    const startedAt = this.now()
    const held = this.bot.heldItem as unknown as { name?: string } | null
    if (held !== null && held !== undefined && held.name === item) return undefined

    const equipped = await this.run('equip', { item }, this.timeouts.place)
    if (equipped.state !== 'ok') return equipped
    const after = this.bot.heldItem as unknown as { name?: string } | null
    if (after === null || after === undefined || after.name !== item) {
      return actFailed('EQUIP_FAILED', this.now() - startedAt)
    }
    return undefined
  }

  /** Start one provider act, wait for a terminal poll with a hard timeout. */
  private async run(name: string, args: Record<string, JsonValue>, timeoutMs: number): Promise<ActResult> {
    const startedAt = this.now()
    const epoch = this.gate.currentEpoch()
    if (epoch === undefined) return staleWriteResult(0)

    let handle: ActHandle
    try {
      handle = this.acts.start(name, args)
    } catch (error) {
      return actFailed(errorCode(error), this.now() - startedAt)
    }

    const entry = { handle, epoch }
    this.running.add(entry)
    try {
      if (name === 'goto') this.emit('move.started', { target: args, from: this.self().pos, epoch })
      const waited = await this.poll(handle, timeoutMs, name === 'goto' ? epoch : undefined)
      // Release uncertainty must survive revocation; otherwise the next driver
      // would see an ordinary stale result and assume it is safe to dispatch.
      if ((waited.kind === 'timeout' && !waited.released)
        || (waited.kind === 'done' && waited.poll.status === 'failed' && waited.poll.error.code === 'STOP_UNCONFIRMED')) {
        const observed = waited.kind === 'timeout' ? waited.observed : waited.poll.status === 'failed' ? waited.poll.error.details : undefined
        if (name === 'goto' && this.gate.isCurrent(epoch)) {
          this.emit('move.finished', { epoch, state: 'unknown', code: 'STOP_UNCONFIRMED', observed: observed ?? null })
        }
        return actUnknown('STOP_UNCONFIRMED', this.now() - startedAt, observed)
      }
      // A result produced after the authority moved on is stale, not success.
      if (!this.gate.isCurrent(epoch)) return actFailed(PortErrorCodes.STALE_WRITE, this.now() - startedAt)
      if (waited.kind === 'timeout') {
        if (name === 'goto') this.emit('move.finished', { epoch, state: 'unknown', code: 'CLIENT_TIMEOUT', observed: waited.observed ?? null })
        return actUnknown(PortErrorCodes.CLIENT_TIMEOUT, this.now() - startedAt, waited.observed)
      }

      const poll = waited.poll
      if (poll.status === 'succeeded') {
        if (name === 'goto') this.emit('move.finished', { epoch, state: 'ok', observed: poll.result ?? null })
        return actOk(this.now() - startedAt, poll.result)
      }
      if (poll.status === 'failed') {
        if (name === 'goto') {
          const unknown = /TIMEOUT|SEARCH_LIMIT|STOP_UNCONFIRMED/u.test(poll.error.code)
          const data = { epoch, state: unknown ? 'unknown' : 'failed', code: poll.error.code, observed: poll.error.details ?? null }
          if (poll.error.code === 'GOTO_STUCK') this.emit('move.stuck', data)
          if (['GOTO_NO_PATH', 'GOTO_INVALID_TARGET', 'GOTO_TARGET_UNLOADED'].includes(poll.error.code)) this.emit('move.no_path', data)
          this.emit('move.finished', data)
        }
        if (name === 'goto' && /TIMEOUT|SEARCH_LIMIT|STOP_UNCONFIRMED/u.test(poll.error.code)) {
          return actUnknown(poll.error.code, this.now() - startedAt, poll.error.details)
        }
        return actFailed(poll.error.code, this.now() - startedAt, poll.error.details)
      }
      return actFailed('ACT_CANCELLED', this.now() - startedAt)
    } finally {
      this.running.delete(entry)
    }
  }

  private async poll(handle: ActHandle, timeoutMs: number, moveEpoch?: number): Promise<WaitResult> {
    const deadline = this.now() + timeoutMs
    let lastProgressAt = Number.NEGATIVE_INFINITY
    let lastActionSeq = 0
    while (true) {
      const poll = handle.poll()
      if (moveEpoch !== undefined && this.gate.isCurrent(moveEpoch)) {
        const observed = poll.status === 'running' ? poll.progress : poll.status === 'succeeded' ? poll.result
          : poll.status === 'failed' ? poll.error.details : undefined
        const actions = (observed as { actions?: Array<{ seq: number; kind: string }> } | undefined)?.actions
        if (Array.isArray(actions)) for (const action of actions) {
          if (action.seq <= lastActionSeq) continue
          lastActionSeq = action.seq
          if (action.kind === 'door' || action.kind === 'unstick-dig') this.emit(`move.${action.kind}`, { epoch: moveEpoch, ...action })
        }
      }
      if (moveEpoch !== undefined && !this.gate.isCurrent(moveEpoch)) {
        this.stopHandle(handle)
        if (handle.controlState?.() !== 'idle' && handle.poll().status !== 'cancelled') {
          return { kind: 'done', poll: { status: 'failed', error: p2Error('STOP_UNCONFIRMED', 'runtime', 'navigation release not confirmed') } }
        }
        return { kind: 'done', poll: { status: 'cancelled' } }
      }
      if (poll.status !== 'running') return { kind: 'done', poll }
      if (moveEpoch !== undefined && this.gate.isCurrent(moveEpoch) && poll.progress !== undefined
        && this.now() - lastProgressAt >= 1_000) {
        lastProgressAt = this.now()
        this.emit('move.progress', { epoch: moveEpoch, observed: poll.progress })
      }
      if (this.now() >= deadline) {
        this.stopHandle(handle)
        return {
          kind: 'timeout',
          released: moveEpoch === undefined || handle.controlState?.() === 'idle' || handle.poll().status === 'cancelled',
          ...(poll.progress === undefined ? {} : { observed: poll.progress }),
        }
      }
      await sleep(this.pollIntervalMs)
    }
  }

  private stopHandle(handle: ActHandle): void {
    try {
      handle.stop()
    } catch {
      // A failed stop means release is unconfirmed; the caller already sees the
      // failed/stale result, so this must not mask it with a second error.
    }
  }

  private wireEvents(): void {
    this.bot.on('chat', (username, message) => {
      if (username === this.bot.username) return
      this.emit('chat', { username, message })
    })
    this.bot.on('blockUpdate', (_oldBlock, newBlock) => {
      const position = newBlock?.position
      if (position === undefined) return
      this.emit('blockUpdated', { x: position.x, y: position.y, z: position.z, name: newBlock.name })
    })
    this.bot.on('health', () => this.emit('damaged', { health: this.bot.health }))
    this.bot.on('death', () => this.emit('died', {}))
    this.bot.on('playerCollect', collector => {
      if (collector === this.bot.entity) this.emit('inventoryChanged', {})
    })
    this.bot.on('windowOpen', window => {
      const kind = (window as unknown as { type?: string }).type
      this.emit('screenOpened', { kind: typeof kind === 'string' ? kind : 'unknown' })
    })
  }

  private emit(event: ClientEvent, payload: JsonValue): void {
    const listeners = this.listeners.get(event)
    if (listeners === undefined) return
    for (const listener of listeners) listener(payload)
  }
}

/** Map the provider's declared operations onto behavioural capabilities. */
export function portCapabilities(providerCapabilities: readonly string[]): Capability[] {
  const capabilities: Capability[] = []
  if (providerCapabilities.includes('pathfind')) capabilities.push('navigate')
  if (providerCapabilities.includes('dig')
    && providerCapabilities.includes('place')
    && providerCapabilities.includes('use')
    && providerCapabilities.includes('interact')) {
    capabilities.push('interact')
  }
  if (providerCapabilities.includes('attack')) capabilities.push('combat')
  return capabilities
}

function blockInfo(block: BlockLike, registry?: unknown): BlockInfo {
  const properties = typeof block.getProperties === 'function' ? block.getProperties() : {}
  const state: Record<string, string> = {}
  for (const [key, value] of Object.entries(properties)) state[key] = String(value)
  const solid = typeof block.boundingBox === 'string' ? block.boundingBox !== 'empty' : undefined
  const harvestTools = block.harvestTools === undefined
    ? undefined
    : Object.keys(block.harvestTools).map(id => itemName(registry, id))
  const base = {
    name: block.name,
    loaded: true as const,
    ...(solid === undefined ? {} : { solid }),
    ...(block.shapes === undefined ? {} : { collision: block.shapes.map(shape => [...shape]) }),
    ...(block.material === undefined ? {} : { material: block.material }),
    ...(block.diggable === undefined ? {} : { diggable: block.diggable }),
    ...(block.hardness === undefined ? {} : { hardness: block.hardness }),
    ...(harvestTools === undefined ? {} : { harvestTools }),
  }
  return Object.keys(state).length === 0 ? base : { ...base, state }
}

function itemName(registry: unknown, id: string): string {
  const items = (registry as { items?: Record<string, { name?: string }> } | undefined)?.items
  return (items?.[String(id)]?.name ?? `item_${id}`).replace(/^minecraft:/u, '')
}

function resolveDroppedItem(
  registry: unknown,
  entity: EntityLike,
): { name: string; count: number } | undefined {
  if (entity.name !== 'item' && entity.name !== 'item_stack') return undefined
  const stack = entity.metadata?.[8]
  if (typeof stack !== 'object' || stack === null) return undefined
  const itemId = (stack as { itemId?: unknown }).itemId
  const count = (stack as { itemCount?: unknown }).itemCount
  if (typeof itemId !== 'number') return undefined
  const items = (registry as { items?: Record<string, { name?: string }> }).items
  const name = items?.[String(itemId)]?.name ?? `item_${itemId}`
  return { name, count: typeof count === 'number' ? count : 1 }
}

function isVec3(value: Vec3 | Landmark): value is Vec3 {
  return !('name' in value)
}

function numberOrUndefined(value: number | bigint | undefined): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : 'ACT_START_FAILED'
}

function unavailable(message: string): P2Error {
  return p2Error('OBSERVATION_UNAVAILABLE', 'environment', message, { module: 'port.mineflayer' })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

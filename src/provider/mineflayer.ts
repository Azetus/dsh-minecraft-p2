import type { Bot, EquipmentDestination } from 'mineflayer'
import mineflayer from 'mineflayer'
import { Vec3 } from 'vec3'

import {
  act,
  assign,
  defineBehavior,
  lit,
  sequence,
} from '../authoring/index.ts'
import type { BehaviorDefinition } from '../contracts/ir.ts'
import type { ProviderRuntimeStatus } from '../contracts/protocol.ts'
import type { JsonValue, ValueMeta } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import { BehaviorExecutor } from '../core/executor.ts'
import type {
  ActHandle,
  ActPoll,
  ActPort,
  QueryOutcome,
  QueryPort,
} from '../core/node-runtime.ts'

export type MineflayerProviderOptions = {
  actionTimeoutMs?: number
  moveDurationMs?: number
  /** How long the server age must stay unchanged before the provider treats it as paused. */
  serverIdleMs?: number
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

function meta(source: ValueMeta['source'], scope: string, sampledAt = Date.now()): ValueMeta {
  return { source, scope, sampledAt, validUntil: sampledAt + 1000 }
}

function isAirName(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

function clampNumber(value: JsonValue | undefined, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/** Query/act adapter over one connected Mineflayer bot. */
export class MineflayerProvider implements ActPort {
  private current: ActHandle | undefined
  private disconnected: Error | undefined
  private paused = false
  private lastServerAge: number | undefined
  private lastServerAgeAt = 0
  private readonly pauseTimer: ReturnType<typeof setInterval>
  private readonly options: Required<MineflayerProviderOptions>

  constructor(
    private readonly bot: Bot,
    options: MineflayerProviderOptions = {},
  ) {
    this.options = {
      actionTimeoutMs: options.actionTimeoutMs ?? 600_000,
      moveDurationMs: options.moveDurationMs ?? 700,
      serverIdleMs: options.serverIdleMs ?? 1500,
    }
    this.pauseTimer = setInterval(() => this.refreshPauseState(), 250)
    this.pauseTimer.unref?.()
    bot.once('end', reason => {
      clearInterval(this.pauseTimer)
      this.disconnected = new Error(`Mineflayer connection ended: ${String(reason)}`)
      this.bot.clearControlStates()
      const current = this.current as (ActHandle & { abort?: (error: Error, code?: string) => void }) | undefined
      current?.abort?.(this.disconnected, 'CONNECTION_LOST')
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
    return {
      paused: this.paused,
      serverAge,
      idleMs: this.paused && this.lastServerAgeAt > 0 ? Date.now() - this.lastServerAgeAt : 0,
    }
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
          return {
            status: 'ok',
            value: { x: position.x, y: position.y, z: position.z, dimension: this.bot.game?.dimension ?? null },
            meta: this.queryMeta('mineflayer.position', sampledAt),
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
          const entities = Object.values(this.bot.entities)
            .filter(entity => objectTypeFilter === undefined || (entity as unknown as { objectType?: string }).objectType === objectTypeFilter)
            .filter(entity => nameFilter === undefined || entity.name === nameFilter)
            .map(entity => {
            const metadataItem = (entity as unknown as { metadata?: Record<number, unknown> }).metadata?.[8]
            const item = typeof metadataItem === 'object' && metadataItem !== null
              && typeof (metadataItem as { itemId?: unknown }).itemId === 'number'
              ? {
                  itemId: (metadataItem as { itemId: number }).itemId,
                  count: typeof (metadataItem as { itemCount?: unknown }).itemCount === 'number'
                    ? (metadataItem as { itemCount: number }).itemCount
                    : 1,
                }
              : null
            return {
              id: entity.id,
              name: entity.name ?? null,
              displayName: (entity as unknown as { displayName?: string }).displayName ?? null,
              type: entity.type ?? null,
              objectType: (entity as unknown as { objectType?: string }).objectType ?? null,
              item,
              position: entity.position === undefined
                ? null
                : { x: entity.position.x, y: entity.position.y, z: entity.position.z },
            }
          })
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
          const registry = (this.bot.registry?.blocksByName ?? {}) as unknown as Record<string, { id: number } | undefined>
          const ids = names
            .map(name => registry[name]?.id)
            .filter((id): id is number => typeof id === 'number')
          if (names.length > 0 && ids.length === 0) {
            return { status: 'ok', value: [], meta: this.queryMeta('mineflayer.blocks', sampledAt) }
          }
          const matching = ids.length > 0 ? ids : (block: { name: string }) => !isAirName(block.name)
          const found = this.bot.findBlocks({ matching, maxDistance: radius, count: Math.min(128, count * 2) })
          const position = this.bot.entity?.position
          const blocks = found
            .filter(point => (yMin === undefined || point.y >= yMin) && (yMax === undefined || point.y <= yMax))
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
    const handle = new MineflayerActHandle(name, args, this.bot, this.options)
    this.current = handle
    return handle
  }
}

class MineflayerActHandle implements ActHandle {
  private result: JsonValue | undefined
  private failed: Error | undefined
  private failedCode = 'ACT_FAILED'
  private cancelled = false
  private completed = false
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

  constructor(
    private readonly name: string,
    private readonly args: Record<string, JsonValue>,
    private readonly bot: Bot,
    private readonly options: Required<MineflayerProviderOptions>,
  ) {
    this.run()
  }

  poll(): ActPoll {
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
    if (this.cancelled || this.completed) return
    this.cancelled = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.name === 'dig') {
      try { this.bot.stopDigging() } catch { /* the connection may already be gone */ }
    }
    if (this.name === 'use') {
      try { this.bot.deactivateItem() } catch { /* the connection may already be gone */ }
    }
    this.bot.clearControlStates()
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
        case 'move': {
          const direction = typeof this.args.direction === 'string'
            ? this.args.direction
            : 'forward'
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
          const held = this.bot.heldItem
          if (held === null || held === undefined) {
            this.failed = new Error('no item is held for placement')
            this.failedCode = 'PLACE_NO_ITEM'
            return
          }
          void this.bot.placeBlock(referenceBlock, new Vec3(vector[0], vector[1], vector[2])).then(() => {
            const placed = this.bot.blockAt(target)
            this.result = { name: placed?.name ?? held.name, x, y, z }
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = 'PLACE_FAILED'
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
          const item = this.bot.inventory.items().find(entry => entry.name === itemName)
          if (item === undefined) {
            this.failed = new Error(`no ${itemName} in inventory`)
            this.failedCode = 'EQUIP_NO_ITEM'
            return
          }
          void this.bot.equip(item, destination as EquipmentDestination).then(() => {
            this.result = { item: item.name, destination }
            this.completed = true
          }).catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error))
            this.failedCode = 'EQUIP_FAILED'
          })
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

export function g2Definition(moveDurationMs = 700): BehaviorDefinition {
  return defineBehavior({
    id: 'm3-g2-mapped',
    description: 'P2 act mapping for look/move/jump/stop',
    mode: 'finite',
    parameters: {},
    locals: { phase: { type: 'string' } },
    root: sequence(
      'root',
      act('look', 'look', { yaw: lit(Math.PI / 2), pitch: lit(0.2) }),
      act('move', 'move', { direction: lit('forward'), durationMs: lit(moveDurationMs) }),
      act('jump', 'jump', {}),
      act('stop', 'stop', {}),
      assign('phase-done', 'phase', lit('done')),
    ),
    completion: { kind: 'predicate', condition: { kind: 'expr', expr: { kind: 'binary', op: 'eq', left: { kind: 'local', name: 'phase' }, right: { kind: 'literal', value: 'done' } } } },
  })
}

export type MappedG2Result = {
  status: string
  ticks: number
  positions: Array<{ x: number; y: number; z: number } | null>
  health: number | null
  food: number | null
  controls: Record<string, boolean>
  settledPosition: { x: number; y: number; z: number } | null
  settledDelta: { dx: number; dy: number; dz: number } | null
}

/** Drive the P2 executor with real Mineflayer acts; no mining/placing/attacking. */
export async function runMappedG2(bot: Bot, options: MineflayerProviderOptions = {}): Promise<MappedG2Result> {
  const provider = new MineflayerProvider(bot, options)
  const definition = g2Definition(options.moveDurationMs)
  const executor = new BehaviorExecutor({
    definition,
    params: {},
    query: provider.queryPort(),
    act: provider,
  })
  const positions: Array<{ x: number; y: number; z: number } | null> = []
  let ticks = 0
  while (executor.currentStatus === 'running' && ticks < 120) {
    executor.tick(Date.now())
    ticks += 1
    const p = bot.entity?.position
    positions.push(p === undefined ? null : { x: p.x, y: p.y, z: p.z })
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (executor.currentStatus === 'running') executor.stop()
  const finalPosition = bot.entity?.position
  const controls = {
    forward: bot.getControlState('forward'),
    back: bot.getControlState('back'),
    left: bot.getControlState('left'),
    right: bot.getControlState('right'),
    jump: bot.getControlState('jump'),
    sprint: bot.getControlState('sprint'),
    sneak: bot.getControlState('sneak'),
  }
  await new Promise(resolve => setTimeout(resolve, 500))
  const settled = bot.entity?.position
  return {
    status: executor.currentStatus,
    ticks,
    positions,
    health: bot.health ?? null,
    food: bot.food ?? null,
    controls,
    settledPosition: settled === undefined ? null : { x: settled.x, y: settled.y, z: settled.z },
    settledDelta: finalPosition === undefined || settled === undefined
      ? null
      : { dx: settled.x - finalPosition.x, dy: settled.y - finalPosition.y, dz: settled.z - finalPosition.z },
  }
}

export type { QueryOutcome }

import type { Bot } from 'mineflayer'
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

function meta(source: ValueMeta['source'], scope: string, sampledAt = Date.now()): ValueMeta {
  return { source, scope, sampledAt, validUntil: sampledAt + 1000 }
}

function nowMeta(): ValueMeta {
  return meta('query', 'mineflayer')
}

/** Query/act adapter over one connected Mineflayer bot. */
export class MineflayerProvider implements ActPort {
  private current: ActHandle | undefined
  private disconnected: Error | undefined
  private readonly options: Required<MineflayerProviderOptions>

  constructor(
    private readonly bot: Bot,
    options: MineflayerProviderOptions = {},
  ) {
    this.options = {
      actionTimeoutMs: options.actionTimeoutMs ?? 5000,
      moveDurationMs: options.moveDurationMs ?? 700,
    }
    bot.once('end', reason => {
      this.disconnected = new Error(`Mineflayer connection ended: ${String(reason)}`)
      this.bot.clearControlStates()
      const current = this.current as (ActHandle & { abort?: (error: Error) => void }) | undefined
      current?.abort?.(this.disconnected)
    })
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
            value: { x: position.x, y: position.y, z: position.z },
            meta: meta('query', 'mineflayer.position', sampledAt),
          }
        }
        case 'inventory': {
          return {
            status: 'ok',
            value: this.bot.inventory.items().map(item => ({ name: item.name, count: item.count })),
            meta: meta('query', 'mineflayer.inventory', sampledAt),
          }
        }
        case 'entities': {
          const entities = Object.values(this.bot.entities).map(entity => ({
            id: entity.id,
            name: entity.name ?? null,
            type: entity.type ?? null,
            position: entity.position === undefined
              ? null
              : { x: entity.position.x, y: entity.position.y, z: entity.position.z },
          }))
          return {
            status: 'ok',
            value: entities,
            meta: meta('query', 'mineflayer.entities', sampledAt),
          }
        }
        case 'time': {
          return {
            status: 'ok',
            value: {
              timeOfDay: typeof this.bot.time?.timeOfDay === 'bigint'
                ? Number(this.bot.time.timeOfDay)
                : this.bot.time?.timeOfDay ?? null,
              difficulty: this.bot.game?.difficulty ?? null,
            },
            meta: meta('query', 'mineflayer.time', sampledAt),
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
            meta: meta('query', 'mineflayer.block', sampledAt),
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
    if (this.current !== undefined && this.current.poll().status === 'running') {
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
  private cancelled = false
  private completed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly startedAt = Date.now()
  private wasAirborne = false

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
        error: p2Error('ACT_FAILED', 'runtime', this.failed.message, { module: 'provider.mineflayer', nodePath: this.name }),
      }
    }
    if (!this.completed && this.name === 'jump') {
      if (this.bot.entity?.onGround === false) this.wasAirborne = true
      if (this.wasAirborne && this.bot.entity?.onGround === true) {
        this.result = this.position()
        this.completed = true
      }
    }
    if (!this.completed && Date.now() - this.startedAt > this.options.actionTimeoutMs) {
      this.failed = new Error(`act ${this.name} timed out`)
    }
    if (this.completed) {
      return this.result === undefined
        ? { status: 'succeeded', meta: meta('act', `mineflayer.${this.name}`) }
        : { status: 'succeeded', result: this.result, meta: meta('act', `mineflayer.${this.name}`) }
    }
    if (this.failed !== undefined) {
      return {
        status: 'failed',
        error: p2Error('ACT_TIMEOUT', 'timeout', this.failed.message, { module: 'provider.mineflayer', nodePath: this.name }),
      }
    }
    return { status: 'running' }
  }

  stop(): void {
    if (this.cancelled || this.completed) return
    this.cancelled = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.bot.clearControlStates()
  }

  abort(error: Error): void {
    if (this.cancelled || this.completed) return
    this.failed = error
    if (this.timer !== undefined) clearTimeout(this.timer)
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
        case 'stop': {
          this.bot.clearControlStates()
          this.result = this.position()
          this.completed = true
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
}

function isControl(value: string): value is BotControl {
  return value === 'forward' || value === 'back' || value === 'left' || value === 'right'
    || value === 'jump' || value === 'sprint' || value === 'sneak'
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

import { EventEmitter } from 'node:events'

import { p2Error } from '../../src/contracts/protocol.ts'
import type { JsonValue } from '../../src/contracts/types.ts'
import type { ActHandle, ActPoll } from '../../src/provider/runtime.ts'
import type { MineflayerActSource } from '../../src/port/mineflayer/index.ts'
import type { WriteToken } from '../../src/port/index.ts'

/**
 * Boundary fakes for the mineflayer ClientPort. They provide only the inputs
 * the port contract defines (blocks, entities, provider acts); they do not
 * simulate the game.
 */

export type FakeBlock = {
  name: string
  /** Mineflayer block type id, used by findBlocks. */
  type?: number
  material?: string
  diggable?: boolean
  hardness?: number
  harvestTools?: Record<string, boolean>
  getProperties?: () => Record<string, string | number | boolean>
}

export class FakeBot extends EventEmitter {
  entity:
    | {
        position: { x: number; y: number; z: number }
        yaw: number
        pitch: number
        onGround: boolean
        isInWater: boolean
        isInLava: boolean
      }
    | undefined = {
      position: { x: 0, y: 64, z: 0 },
      yaw: 1,
      pitch: 2,
      onGround: true,
      isInWater: false,
      isInLava: false,
    }

  health = 20
  food = 18
  registry = {
    items: {
      '820': { name: 'wooden_pickaxe' },
      '825': { name: 'stone_pickaxe' },
    } as Record<string, { name: string }>,
    blocksByName: {
      stone: { id: 1 },
      crafting_table: { id: 182 },
      oak_door: { id: 64 },
    } as Record<string, { id: number }>,
  }
  heldItem: { name: string; count: number } | null = { name: 'stone', count: 1 }
  time: { timeOfDay: number | bigint; age: number | bigint } = { timeOfDay: 6000n, age: 1234n }
  entities: Record<number, { id: number; name?: string; position?: { x: number; y: number; z: number } }> = {
    1: { id: 1, name: 'cow', position: { x: 1, y: 64, z: 1 } },
    2: { id: 2, name: 'far', position: { x: 40, y: 64, z: 40 } },
    3: { id: 3, position: { x: 2, y: 64, z: 2 } },
  }

  readonly blocks = new Map<string, FakeBlock>()
  readonly chats: string[] = []
  readonly findCalls: Array<{
    point?: { x: number; y: number; z: number }
    matching: number | number[]
    maxDistance?: number
    count?: number
  }> = []

  inventory = {
    items: (): Array<{ slot?: number; name: string; count: number }> => [
      { slot: 36, name: 'dirt', count: 3 },
    ],
  }

  blockAt(position: { x: number; y: number; z: number }): FakeBlock | null {
    return this.blocks.get(`${position.x},${position.y},${position.z}`) ?? null
  }

  /** Minimal stand-in for mineflayer's id-array/section-palette search. */
  findBlocks(options: {
    point?: { x: number; y: number; z: number }
    matching: number | number[]
    maxDistance?: number
    count?: number
  }): Array<{ x: number; y: number; z: number }> {
    this.findCalls.push({ ...options })
    const point = options.point ?? this.entity?.position
    if (point === undefined) return []
    const ids = Array.isArray(options.matching) ? options.matching : [options.matching]
    const maxDistance = options.maxDistance ?? 16
    const count = options.count ?? 1
    const found: Array<{ x: number; y: number; z: number; distance: number }> = []
    for (const [key, block] of this.blocks) {
      if (block.type === undefined || !ids.includes(block.type)) continue
      const [x, y, z] = key.split(',').map(Number) as [number, number, number]
      const distance = Math.hypot(x - point.x, y - point.y, z - point.z)
      if (distance > maxDistance) continue
      found.push({ x, y, z, distance })
    }
    found.sort((left, right) => left.distance - right.distance)
    return found.slice(0, count).map(({ x, y, z }) => ({ x, y, z }))
  }

  chat(text: string): void {
    this.chats.push(text)
  }
}

export type FakeCall = { name: string; args: Record<string, JsonValue> }

export type FakeMode = 'succeed' | 'running' | 'fail' | 'disconnected'

export class FakeHandle implements ActHandle {
  stopped = false

  constructor(
    private readonly mode: Exclude<FakeMode, 'disconnected'>,
    private readonly failCode: string,
    readonly result?: JsonValue,
    private readonly releaseOnStop = true,
  ) {}

  poll(): ActPoll {
    if (this.stopped && this.releaseOnStop) return { status: 'cancelled' }
    if (this.mode === 'running') return { status: 'running' }
    if (this.mode === 'fail') {
      return { status: 'failed', error: p2Error(this.failCode, 'environment', 'act failed') }
    }
    return this.result === undefined ? { status: 'succeeded' } : { status: 'succeeded', result: this.result }
  }

  stop(): void {
    this.stopped = true
  }

  controlState(): 'idle' | 'active' {
    if (!this.stopped) return 'active'
    return this.releaseOnStop ? 'idle' : 'active'
  }

  controlRelease(): 'confirmed' | null {
    return this.stopped && this.releaseOnStop ? 'confirmed' : null
  }
}

export class FakeActSource implements MineflayerActSource {
  readonly calls: FakeCall[] = []
  readonly handles: FakeHandle[] = []
  mode: FakeMode = 'succeed'
  failCode = 'DIG_NO_BLOCK'
  /** Set false to model a stop request the provider cannot prove has landed. */
  releaseOnStop = true
  onStart: ((name: string, args: Record<string, JsonValue>) => void) | undefined

  constructor(readonly capabilities: readonly string[] = ['motion', 'dig', 'place', 'use', 'interact', 'attack']) {}

  start(name: string, args: Record<string, JsonValue>): ActHandle {
    if (this.mode === 'disconnected') {
      throw p2Error('CONNECTION_LOST', 'environment', 'the connection ended', { module: 'fake.provider' })
    }
    this.calls.push({ name, args })
    this.onStart?.(name, args)
    const handle = new FakeHandle(this.mode, this.failCode, { name }, this.releaseOnStop)
    this.handles.push(handle)
    return handle
  }
}

export function writeToken(seq: number): WriteToken {
  return { runId: 'run-1', jobId: `job-${seq}`, seq }
}

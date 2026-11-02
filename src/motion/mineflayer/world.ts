import type { Bot } from 'mineflayer'
import { Vec3 as Vec3Class } from 'vec3'

import { blockTagsFor, type BlockTagIndex } from '../../port/mineflayer/block-tags.ts'
import type {
  Box,
  Cell,
  CollisionBox,
  EntityView,
  InputControl,
  MotionWorld,
  RawBlock,
  SelfView,
} from '../model/types.ts'

type BlockLike = {
  type?: number
  name: string
  boundingBox?: string
  shapes?: number[][]
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
}

/**
 * `MotionWorld` over one live mineflayer bot. Collision always comes from
 * `block.shapes`; no name table is consulted here. Reads are synchronous, and
 * actions are fire-and-forget: the model observes the result on a later tick.
 */
export class MineflayerMotionWorld implements MotionWorld {
  private readonly tags: BlockTagIndex

  constructor(private readonly bot: Bot) {
    this.tags = blockTagsFor(bot)
  }

  self(): SelfView {
    const entity = this.bot.entity as unknown as {
      position?: { x: number; y: number; z: number }
      velocity?: { x: number; y: number; z: number }
      yaw?: number
      pitch?: number
      onGround?: boolean
    } | undefined
    const position = entity?.position
    if (entity === undefined || position === undefined) throw new Error('bot position is not available')
    const getControl = (this.bot as unknown as { getControlState?: (name: string) => boolean }).getControlState
    const control = (name: string): boolean => typeof getControl === 'function'
      ? getControl.call(this.bot, name) === true
      : false
    return {
      pos: { x: position.x, y: position.y, z: position.z },
      velocity: entity.velocity ?? { x: 0, y: 0, z: 0 },
      yaw: typeof entity.yaw === 'number' ? entity.yaw : 0,
      pitch: typeof entity.pitch === 'number' ? entity.pitch : 0,
      onGround: entity.onGround === true,
      sneaking: control('sneak'),
      sprinting: control('sprint'),
      health: typeof this.bot.health === 'number' ? this.bot.health : 20,
    }
  }

  blockAt(p: Cell): RawBlock | null {
    const block = this.bot.blockAt(new Vec3Class(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) as unknown as BlockLike | null
    if (block === null) return null
    const properties = typeof block.getProperties === 'function' ? block.getProperties() : {}
    const state: Record<string, string> = {}
    for (const [key, value] of Object.entries(properties)) state[key] = String(value)
    const serverTags = typeof block.type === 'number' ? this.tags.tagsFor(block.type) : undefined
    return {
      loaded: true,
      name: block.name,
      state,
      ...(block.shapes === undefined ? {} : { collision: block.shapes as unknown as readonly CollisionBox[] }),
      ...(serverTags === undefined ? {} : { serverTags }),
    }
  }

  entities(box: Box): readonly EntityView[] {
    const result: EntityView[] = []
    for (const entity of Object.values(this.bot.entities) as unknown as EntityLike[]) {
      const position = entity.position
      if (position === undefined) continue
      if (position.x < box.min.x || position.x > box.max.x) continue
      if (position.y < box.min.y || position.y > box.max.y) continue
      if (position.z < box.min.z || position.z > box.max.z) continue
      result.push({
        id: String(entity.id ?? -1),
        name: entity.username ?? entity.name ?? entity.type ?? 'unknown',
        position: { x: position.x, y: position.y, z: position.z },
        ...(typeof entity.width === 'number' ? { width: entity.width } : {}),
        ...(typeof entity.height === 'number' ? { height: entity.height } : {}),
        ...(entity.kind === undefined ? {} : { kind: entity.kind }),
      })
    }
    return result
  }

  tick(): number {
    const age = this.bot.time?.age
    if (typeof age === 'number') return age
    if (typeof age === 'bigint') return Number(age)
    return 0
  }

  onTick(cb: () => void): () => void {
    this.bot.on('physicsTick', cb)
    return () => this.bot.removeListener('physicsTick', cb)
  }

  setInput(control: InputControl, on: boolean): void {
    this.bot.setControlState(control, on)
  }

  look(yaw: number, pitch: number): void {
    void this.bot.look(yaw, pitch, true).catch(() => {
      // A look that cannot complete is observed by the next tick, not retried here.
    })
  }

  useOn(p: Cell): void {
    const block = this.bot.blockAt(new Vec3Class(p.x, p.y, p.z))
    if (block !== null) void this.bot.activateBlock(block).catch(() => {})
  }

  place(p: Cell, item: string): void {
    void this.placeAt(p, item).catch(() => {})
  }

  dig(p: Cell): void {
    const block = this.bot.blockAt(new Vec3Class(p.x, p.y, p.z))
    if (block !== null) void this.bot.dig(block).catch(() => {})
  }

  attack(entityId: string): void {
    const entity = this.bot.entities[Number(entityId)]
    if (entity !== undefined) this.bot.attack(entity)
  }

  releaseAll(): void {
    this.bot.clearControlStates()
    try {
      this.bot.deactivateItem()
    } catch {
      // No active item is a normal release path.
    }
    try {
      this.bot.stopDigging()
    } catch {
      // No active dig is a normal release path.
    }
  }

  /** Placement primitive for P3; returns after the server-visible readback tick. */
  private async placeAt(p: Cell, item: string): Promise<void> {
    const registry = this.bot.registry as unknown as {
      itemsByName?: Record<string, { id?: number }>
    }
    const itemType = registry.itemsByName?.[item]?.id
    if (itemType === undefined) return
    await this.bot.equip(itemType, 'hand')
    const directions: Array<[number, number, number]> = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
    for (const [dx, dy, dz] of directions) {
      const reference = this.bot.blockAt(new Vec3Class(p.x + dx, p.y + dy, p.z + dz))
      if (reference === null) continue
      const shapes = (reference as unknown as BlockLike).shapes
      if (shapes === undefined || shapes.length === 0) continue
      await this.bot.placeBlock(reference, new Vec3Class(-dx, -dy, -dz))
      return
    }
  }
}

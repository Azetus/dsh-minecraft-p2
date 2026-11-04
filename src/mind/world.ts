import type { BlockInfo, Box, EntityInfo, Item, SelfInfo, Vec3 } from '../port/index.ts'
import type { WorldView } from './types.ts'

export type SnapshotData = {
  self: SelfInfo
  time: { timeOfDay: number; worldAge: number }
  entities: EntityInfo[]
  blocks: BlockInfo[]
  inventory: Item[]
  stale?: boolean
}

/** Immutable one-evaluation view built from one `Sensors` sample. */
export class SnapshotWorld implements WorldView {
  readonly self: SelfInfo
  readonly time: { timeOfDay: number; worldAge: number }
  readonly inventory: Item[]
  readonly stale?: boolean
  private readonly blocks = new Map<string, BlockInfo>()
  private readonly entityList: EntityInfo[]
  private readonly entityIndex = new Map<string, number>()

  constructor(data: SnapshotData) {
    this.self = data.self
    this.time = data.time
    this.inventory = data.inventory
    this.entityList = data.entities
    this.entityList.forEach((entity, index) => this.entityIndex.set(entity.id, index))
    if (data.stale !== undefined) this.stale = data.stale
    for (const block of data.blocks) {
      if (block.pos !== undefined) this.blocks.set(blockKey(block.pos), block)
    }
  }

  blockAt(p: Vec3): BlockInfo | null {
    return this.blocks.get(blockKey(p)) ?? null
  }

  /** Merge a targeted observation into this snapshot. */
  addBlocks(blocks: BlockInfo[]): void {
    for (const block of blocks) {
      if (block.pos !== undefined) this.blocks.set(blockKey(block.pos), block)
    }
  }

  blocksIn(box: Box, filter?: string[]): BlockInfo[] {
    const result: BlockInfo[] = []
    for (const block of this.blocks.values()) {
      const p = block.pos as Vec3
      if (!inside(p, box)) continue
      // Unknown cells stay visible even when a name filter is used.
      if (filter !== undefined && block.loaded && !filter.includes(block.name)) continue
      result.push(block)
    }
    return result
  }

  entitiesIn(box: Box): EntityInfo[] {
    return this.entityList.filter(entity => inside(entity.position, box))
  }

  /** Merge a targeted entity observation; updates an existing id in place. */
  addEntities(entities: EntityInfo[]): void {
    for (const entity of entities) {
      const index = this.entityIndex.get(entity.id)
      if (index === undefined) {
        this.entityIndex.set(entity.id, this.entityList.length)
        this.entityList.push(entity)
      } else {
        this.entityList[index] = entity
      }
    }
  }
}

export function blockKey(p: Vec3): string {
  return `${p.x},${p.y},${p.z}`
}

export function inside(p: Vec3, box: Box): boolean {
  return p.x >= box.min.x && p.x <= box.max.x
    && p.y >= box.min.y && p.y <= box.max.y
    && p.z >= box.min.z && p.z <= box.max.z
}

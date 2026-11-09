import type { JsonValue } from '../contracts/types.ts'
import type { BlockInfo, Box, BodyApi, Vec3 } from '../body/api.ts'
import { materialSources, sourceNames } from './materials.ts'

type Chunk = {
  key: string
  box: Box
  scanned: boolean
}

type ResourceEntry = { name: string; pos: Vec3 }

const CHUNK = 16

/**
 * Bounded area index for material gathering. A ring of 16x16 columns is fetched
 * a few chunks per evaluation; block updates are applied directly, so the
 * common case does not rescan the ring.
 */
export class AreaResourceIndex {
  private readonly port: BodyApi
  private readonly radius: number
  private readonly vertical: number
  private readonly chunkBudget: number
  private readonly refreshMs: number
  private readonly resources: Set<string>
  private readonly entries = new Map<string, ResourceEntry>()
  private readonly chunks = new Map<string, Chunk>()
  private readonly queue: Chunk[] = []
  private center: Vec3 | undefined
  private completeAt = 0
  private staleFlag = true

  constructor(
    port: BodyApi,
    options: { radius?: number; vertical?: number; chunkBudget?: number; refreshMs?: number } = {},
  ) {
    this.port = port
    this.radius = options.radius ?? 32
    this.vertical = options.vertical ?? 16
    this.chunkBudget = options.chunkBudget ?? 2
    this.refreshMs = options.refreshMs ?? 15_000
    this.resources = new Set(sourceNames())
  }

  get stale(): boolean {
    return this.staleFlag || this.queue.length > 0
  }

  get pendingChunks(): number {
    return this.queue.length
  }

  /** Advance the chunk queue around `center`; call once per evaluation. */
  update(center: Vec3, now: number): void {
    const moved = this.center === undefined
      || Math.hypot(center.x - this.center.x, center.z - this.center.z) > 8
      || Math.abs(center.y - this.center.y) > 4
    if (moved || (this.completeAt > 0 && now - this.completeAt >= this.refreshMs)) {
      this.reset(center)
    }
    this.scan(now)
  }

  nearest(item: string, from: Vec3, maxDistance = this.radius): { pos: Vec3; distance: number } | undefined {
    const names = new Set(materialSources(item))
    let best: { pos: Vec3; distance: number } | undefined
    for (const entry of this.entries.values()) {
      if (!names.has(entry.name)) continue
      const distance = Math.hypot(
        entry.pos.x + 0.5 - from.x,
        entry.pos.y + 0.5 - (from.y + 1.5),
        entry.pos.z + 0.5 - from.z,
      )
      if (distance > maxDistance) continue
      if (best === undefined || distance < best.distance) best = { pos: entry.pos, distance }
    }
    return best
  }

  onBlockUpdate(payload: JsonValue): void {
    if (this.center === undefined || !isRecord(payload)) return
    const { x, y, z } = payload
    const name = payload.name
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' || typeof name !== 'string') return
    if (Math.abs(x - this.center.x) > this.radius + CHUNK
      || Math.abs(z - this.center.z) > this.radius + CHUNK
      || Math.abs(y - this.center.y) > this.vertical) return
    const key = pointKey({ x, y, z })
    if (this.resources.has(name)) {
      this.entries.set(key, { name, pos: { x, y, z } })
    } else {
      this.entries.delete(key)
    }
  }

  private reset(center: Vec3): void {
    this.center = { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) }
    this.entries.clear()
    this.chunks.clear()
    this.queue.length = 0
    this.completeAt = 0
    this.staleFlag = true
    for (let cx = Math.floor((this.center.x - this.radius) / CHUNK);
      cx <= Math.floor((this.center.x + this.radius) / CHUNK); cx += 1) {
      for (let cz = Math.floor((this.center.z - this.radius) / CHUNK);
        cz <= Math.floor((this.center.z + this.radius) / CHUNK); cz += 1) {
        const x0 = cx * CHUNK
        const z0 = cz * CHUNK
        const centerX = x0 + CHUNK / 2
        const centerZ = z0 + CHUNK / 2
        if (Math.hypot(centerX - this.center.x, centerZ - this.center.z) > this.radius + CHUNK) continue
        const key = `${cx},${cz}`
        const chunk: Chunk = {
          key,
          box: {
            min: { x: x0, y: this.center.y - this.vertical, z: z0 },
            max: { x: x0 + CHUNK - 1, y: this.center.y + this.vertical, z: z0 + CHUNK - 1 },
          },
          scanned: false,
        }
        this.chunks.set(key, chunk)
        this.queue.push(chunk)
      }
    }
    this.queue.sort((left, right) => distanceToCenter(left.box, this.center!) - distanceToCenter(right.box, this.center!))
  }

  private scan(now: number): void {
    let budget = this.chunkBudget
    while (budget > 0 && this.queue.length > 0) {
      const chunk = this.queue.shift()
      if (chunk === undefined || chunk.scanned) continue
      budget -= 1
      let blocks: BlockInfo[]
      try {
        blocks = this.port.blocksIn(chunk.box)
      } catch {
        this.queue.unshift(chunk)
        this.staleFlag = true
        return
      }
      for (const block of blocks) {
        if (!block.loaded || block.pos === undefined || !this.resources.has(block.name)) continue
        this.entries.set(pointKey(block.pos), { name: block.name, pos: block.pos })
      }
      chunk.scanned = true
    }
    if (this.queue.length === 0) {
      this.completeAt = now
      this.staleFlag = false
    }
  }
}

function distanceToCenter(box: Box, center: Vec3): number {
  return Math.hypot(box.min.x + CHUNK / 2 - center.x, box.min.z + CHUNK / 2 - center.z)
}

function pointKey(point: Vec3): string {
  return `${point.x},${point.y},${point.z}`
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

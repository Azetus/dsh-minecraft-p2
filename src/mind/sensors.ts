import type { Box, ClientPort, Vec3 } from '../port/index.ts'
import { SnapshotWorld } from './world.ts'
import type { SnapshotData } from './world.ts'

export type SensorOptions = {
  port: ClientPort
  /** Block sample: horizontal radius and vertical range around the feet. */
  blockRadius?: number
  verticalMin?: number
  verticalMax?: number
  entityRadius?: number
  /** Full sample period; the constant tree may read a snapshot up to this old. */
  refreshMs?: number
  now?: () => number
}

/**
 * Builds bounded world snapshots on a 10 Hz budget. A sample failure keeps the
 * previous snapshot but marks it stale, so the tree reports
 * `need-observation` instead of deciding on a fabricated world.
 *
 * Observation groups registered with `setObservation` are re-read on **every**
 * sample, not merged into one snapshot. A one-off merge used to be lost on the
 * next sample, which turned plan walls/roof/stances back into `unknown` as soon
 * as the default box moved with the body.
 */
export class Sensors {
  private readonly port: ClientPort
  private readonly blockRadius: number
  private readonly verticalMin: number
  private readonly verticalMax: number
  private readonly entityRadius: number
  private readonly refreshMs: number
  private readonly now: () => number
  private readonly observation = new Map<string, Box[]>()
  private current: SnapshotWorld | undefined
  private lastData: SnapshotData | undefined
  private sampledAt = 0

  constructor(options: SensorOptions) {
    this.port = options.port
    this.blockRadius = options.blockRadius ?? 10
    this.verticalMin = options.verticalMin ?? -6
    this.verticalMax = options.verticalMax ?? 8
    this.entityRadius = options.entityRadius ?? 12
    this.refreshMs = options.refreshMs ?? 100
    this.now = options.now ?? (() => Date.now())
  }

  /** Persist a named observation group; every later sample includes it. */
  setObservation(id: string, boxes: Box[]): SnapshotWorld {
    this.observation.set(id, boxes)
    return this.resample()
  }

  clearObservation(id?: string): void {
    if (id === undefined) this.observation.clear()
    else this.observation.delete(id)
  }

  hasObservation(id: string): boolean {
    return this.observation.has(id)
  }

  /**
   * Targeted P2-internal observation. This is not an Agent-facing payload: the
   * blocks are merged into a freshly sampled snapshot used by the tree and
   * never dumped into the model context. Unloaded cells stay `loaded:false`.
   * The whole snapshot is refreshed so self/time/inventory do not freeze while
   * an unknown cell is being re-read.
   */
  observeBox(box: Box): SnapshotWorld {
    return this.resample([box])
  }

  /**
   * Targeted entity observation for a bounded follow/escort check. It merges
   * into the current snapshot instead of replacing the block sample, so the
   * caller keeps one evaluation snapshot. Failure leaves the snapshot intact.
   */
  observeEntities(box: Box): SnapshotWorld {
    const current = this.current ?? this.resample()
    try {
      current.addEntities(this.port.entities(box))
    } catch {
      // A transient entity query failure is not a world verdict.
    }
    return current
  }

  read(now = this.now()): SnapshotWorld {
    const targeted = this.targetedBoxes()
    if (this.current !== undefined && targeted.length === 0 && now - this.sampledAt < this.refreshMs) {
      return this.current
    }
    return this.resample(undefined, now)
  }

  private resample(extra?: Box[], now = this.now()): SnapshotWorld {
    try {
      const data = this.sample(extra)
      this.lastData = data
      this.current = new SnapshotWorld(data)
      this.sampledAt = now
      return this.current
    } catch {
      this.sampledAt = now
      if (this.lastData === undefined) throw new Error('world snapshot is unavailable')
      this.current = new SnapshotWorld({ ...this.lastData, stale: true })
      return this.current
    }
  }

  private targetedBoxes(): Box[] {
    const boxes: Box[] = []
    for (const group of this.observation.values()) boxes.push(...group)
    return boxes
  }

  private sample(extra?: Box[]): SnapshotData {
    const self = this.port.self()
    const time = this.port.time()
    const feet = {
      x: Math.floor(self.pos.x),
      y: Math.floor(self.pos.y),
      z: Math.floor(self.pos.z),
    }
    const blockBox: Box = {
      min: { x: feet.x - this.blockRadius, y: feet.y + this.verticalMin, z: feet.z - this.blockRadius },
      max: { x: feet.x + this.blockRadius, y: feet.y + this.verticalMax, z: feet.z + this.blockRadius },
    }
    const entityBox: Box = {
      min: { x: feet.x - this.entityRadius, y: feet.y - 8, z: feet.z - this.entityRadius },
      max: { x: feet.x + this.entityRadius, y: feet.y + 8, z: feet.z + this.entityRadius },
    }
    const blocks = this.port.blocksIn(blockBox)
    for (const box of this.targetedBoxes()) blocks.push(...this.port.blocksIn(box))
    for (const box of extra ?? []) blocks.push(...this.port.blocksIn(box))
    const entities = this.port.entities(entityBox)
    const inventory = this.port.inventory()
    return { self, time, entities, blocks, inventory }
  }
}

/** Entity box helper used by givers and tests. */
export function boxAround(center: Vec3, radius: number, vertical = 6): Box {
  return {
    min: { x: center.x - radius, y: center.y - vertical, z: center.z - radius },
    max: { x: center.x + radius, y: center.y + vertical, z: center.z + radius },
  }
}

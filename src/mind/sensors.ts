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
 */
export class Sensors {
  private readonly port: ClientPort
  private readonly blockRadius: number
  private readonly verticalMin: number
  private readonly verticalMax: number
  private readonly entityRadius: number
  private readonly refreshMs: number
  private readonly now: () => number
  private current: SnapshotWorld | undefined
  private lastData: SnapshotData | undefined
  private sampledAt = 0

  constructor(options: SensorOptions) {
    this.port = options.port
    this.blockRadius = options.blockRadius ?? 6
    this.verticalMin = options.verticalMin ?? -3
    this.verticalMax = options.verticalMax ?? 2
    this.entityRadius = options.entityRadius ?? 12
    this.refreshMs = options.refreshMs ?? 100
    this.now = options.now ?? (() => Date.now())
  }

  read(now = this.now()): SnapshotWorld {
    if (this.current !== undefined && now - this.sampledAt < this.refreshMs) {
      return this.current
    }
    try {
      const data = this.sample()
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

  private sample(): SnapshotData {
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

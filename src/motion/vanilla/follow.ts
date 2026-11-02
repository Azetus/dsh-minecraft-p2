import { bodyOverlap, cellOf, hasTag, sameCell } from '../model/block.ts'
import type { Cell, MotionWorld, Vec3 } from '../model/types.ts'
import { VanillaNodeReader } from './classify.ts'

/** Vanilla `PathNavigation`: stuck check every 100 ticks, i.e. 5 s. */
export const VANILLA_STALL_MS = 5_000
/** Vanilla `followThePath`: `0.75 - bbWidth / 2` = 0.45 for a 0.6-wide player. */
export const VANILLA_HORIZONTAL_TOLERANCE = 0.45
/** Vanilla `followThePath`: the vertical term is a plain `< 1.0`. */
export const VANILLA_VERTICAL_TOLERANCE = 1.0

const PROGRESS_EPSILON = 0.12

export type VanillaFollowResult =
  | { status: 'running' }
  | { status: 'succeeded' }
  | { status: 'failed'; code: string }
  | { status: 'canceled' }

/**
 * Greedy waypoint follower in the shape of vanilla `PathNavigation` +
 * `MoveControl`: aim at the next node, hold forward, jump when the next node is
 * a block up, climb ladders by jumping/sneaking, and open doors on the way.
 * It never re-plans, never refuses and never breaks or places.
 */
export class WaypointFollower {
  private index = 0
  private startedAt = -1
  private lastProgressAt = 0
  private lastPos: Vec3 | undefined
  private doorAt = Number.NEGATIVE_INFINITY
  private canceled = false

  constructor(
    private readonly world: MotionWorld,
    private readonly reader: VanillaNodeReader,
    private readonly waypoints: readonly Cell[],
  ) {}

  /** How many waypoints have been consumed (for evidence). */
  get progress(): number {
    return this.index
  }

  tick(now: number): VanillaFollowResult {
    if (this.canceled) {
      this.release()
      return { status: 'canceled' }
    }
    const self = this.world.self()
    if (this.startedAt < 0) {
      this.startedAt = now
      this.lastProgressAt = now
      this.lastPos = self.pos
    }
    if (this.index >= this.waypoints.length) {
      this.release()
      return { status: 'succeeded' }
    }
    const waypoint = this.waypoints[this.index]!
    if (this.closeEnough(self.pos, waypoint)) {
      this.index += 1
      this.lastProgressAt = now
      this.lastPos = self.pos
      return { status: 'running' }
    }
    if (this.lastPos !== undefined
      && Math.hypot(self.pos.x - this.lastPos.x, self.pos.y - this.lastPos.y, self.pos.z - this.lastPos.z) > PROGRESS_EPSILON) {
      this.lastProgressAt = now
      this.lastPos = self.pos
    } else if (now - this.lastProgressAt > VANILLA_STALL_MS) {
      this.release()
      return { status: 'failed', code: 'VANILLA_STUCK' }
    }
    this.steer(self.pos, waypoint, now)
    return { status: 'running' }
  }

  cancel(): void {
    this.canceled = true
    this.release()
  }

  private steer(pos: Vec3, waypoint: Cell, now: number): void {
    const feet = cellOf(pos)
    const feetNode = this.reader.node(feet)
    const yaw = Math.atan2(-(waypoint.x + 0.5 - pos.x), -(waypoint.z + 0.5 - pos.z))
    const waypointNode = this.reader.node(waypoint)

    if (waypointNode?.kind === 'door'
      && Math.hypot(pos.x - (waypoint.x + 0.5), pos.z - (waypoint.z + 0.5)) <= 2.5
      && now - this.doorAt > 600) {
      this.doorAt = now
      this.world.useOn(waypoint)
    }

    // Head under water: swim up (vanilla swim input) while pushing forward.
    if (this.headUnderwater(pos)) {
      this.world.look(yaw, -1.2)
      this.world.setInput('forward', true)
      this.world.setInput('jump', true)
      this.world.setInput('sneak', false)
      return
    }

    if (feetNode?.kind === 'climbable') {
      this.world.look(yaw, 0)
      this.world.setInput('forward', true)
      this.world.setInput('jump', waypoint.y > feet.y)
      this.world.setInput('sneak', waypoint.y < feet.y)
      return
    }

    this.world.look(yaw, 0)
    this.world.setInput('forward', true)
    this.world.setInput('sneak', false)
    this.world.setInput('jump', waypoint.y > feet.y + 0.01 || this.shapeAhead(feet, waypoint))
  }

  /** Vanilla `MoveControl` jumps when the body is inside a protruding shape. */
  private shapeAhead(feet: Cell, waypoint: Cell): boolean {
    const ahead = cellOf({ x: waypoint.x + 0.5, y: feet.y, z: waypoint.z + 0.5 })
    if (sameCell(ahead, feet)) return false
    const block = this.reader.block(ahead)
    if (block === null) return false
    if (hasTag(block, 'door') || hasTag(block, 'gate') || hasTag(block, 'climbable')) return false
    if (block.collision === undefined || block.collision.length === 0) return false
    return bodyOverlap(block, ahead, feet.y) === true
  }

  private headUnderwater(pos: Vec3): boolean {
    // Eye height 1.6 above the feet; floor() the eye itself (no cell snapping).
    const eye = { x: Math.floor(pos.x), y: Math.floor(pos.y + 1.6), z: Math.floor(pos.z) }
    const block = this.reader.block(eye)
    return block !== null && hasTag(block, 'water')
  }

  private closeEnough(pos: Vec3, waypoint: Cell): boolean {
    const horizontal = Math.abs(pos.x - (waypoint.x + 0.5)) < VANILLA_HORIZONTAL_TOLERANCE
      && Math.abs(pos.z - (waypoint.z + 0.5)) < VANILLA_HORIZONTAL_TOLERANCE
    const vertical = Math.abs(pos.y - waypoint.y) < VANILLA_VERTICAL_TOLERANCE
    return horizontal && vertical
  }

  private release(): void {
    for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'] as const) {
      this.world.setInput(control, false)
    }
    this.world.releaseAll()
  }
}

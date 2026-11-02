import { distance2d } from './geometry.ts'
import type {
  Cell,
  Move,
  MoveContext,
  MoveKind,
  MoveState,
  MoveStatus,
  Vec3,
} from '../model/types.ts'
import { COST_INF } from '../model/types.ts'

/**
 * Does the body occupy `cell` at its derived feet height? Uses the same rules
 * as the planner, including slab/carpet feet offsets.
 */
export function reached(pos: Vec3, cell: Cell, ctx: MoveContext, tolerance = 0.55): boolean {
  const info = ctx.rules.standInfo(cell)
  if (info.state !== 'yes') return false
  return distance2d(pos, cell) <= tolerance && Math.abs(pos.y - info.feetY) <= 0.45
}

export function cellOf(pos: Vec3): Cell {
  // Path cells are "support + 1"; a slab puts the continuous feet at y-0.5,
  // so round the feet height instead of flooring it directly.
  return { x: Math.floor(pos.x), y: Math.floor(pos.y + 0.5), z: Math.floor(pos.z) }
}

export function aim(ctx: MoveContext, cell: Cell): void {
  ctx.world.look(yawTo(ctx.position, cell), 0)
}

export function yawTo(from: Vec3, cell: Cell): number {
  // Mineflayer yaw: 0 = -z (north), +pi/2 = -x (west).
  return Math.atan2(-(cell.x + 0.5 - from.x), -(cell.z + 0.5 - from.z))
}

export function holdForward(ctx: MoveContext, sprint = false): void {
  ctx.world.setInput('forward', true)
  ctx.world.setInput('sprint', sprint)
}

export function releaseInputs(ctx: MoveContext): void {
  for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'] as const) {
    ctx.world.setInput(control, false)
  }
}

abstract class BaseMove implements Move {
  abstract readonly kind: MoveKind
  abstract readonly src: Cell
  abstract readonly dest: Cell
  abstract cost(ctx: MoveContext): number
  abstract validPositions(): readonly Cell[]
  abstract update(state: MoveState, ctx: MoveContext): MoveStatus
  abstract safeToCancel(state: MoveState): boolean

  protected constructor() {}

  reset(): void {
    // Stateless moves override when they keep scratch state.
  }

  toBreak(): readonly Cell[] {
    return []
  }

  toPlace(): readonly Cell[] {
    return []
  }
}

function adjacent(a: Cell, b: Cell): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1
}

function sameColumn(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.z === b.z
}

function diagonal(a: Cell, b: Cell): boolean {
  return Math.abs(a.x - b.x) === 1 && Math.abs(a.z - b.z) === 1
}

function jumpGap(a: Cell, b: Cell): boolean {
  return a.y === b.y && Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 2
}

export class TraverseMove extends BaseMove {
  readonly kind = 'traverse' as const
  private doorUseAt: number | undefined
  private doorAttempts = 0

  constructor(readonly src: Cell, readonly dest: Cell) {
    super()
  }

  cost(ctx: MoveContext): number {
    if (this.src.y !== this.dest.y || !adjacent(this.src, this.dest)) return COST_INF
    const door = ctx.rules.doorState(this.dest)
    if (door === 'unknown') return COST_INF
    if (door === 'locked') return COST_INF
    if (door === 'closed') return ctx.rules.isDoorPassable(this.dest, directionOf(this.src, this.dest)) === 'yes'
      ? 1.2
      : COST_INF
    if (ctx.rules.canWalkThrough(this.dest) !== 'yes') return COST_INF
    const stand = ctx.rules.standInfo(this.dest)
    if (stand.state !== 'yes') return COST_INF
    return 1
  }

  validPositions(): readonly Cell[] {
    return [this.src, this.dest]
  }

  reset(): void {
    this.doorUseAt = undefined
    this.doorAttempts = 0
  }

  safeToCancel(_state: MoveState): boolean {
    return true
  }

  update(state: MoveState, ctx: MoveContext): MoveStatus {
    state.ticks += 1
    state.elapsedMs = ctx.now - state.startedAt
    if (reached(ctx.position, this.dest, ctx)) {
      releaseInputs(ctx)
      return 'success'
    }
    const door = ctx.rules.doorState(this.dest)
    if (door === 'closed' || door === 'locked' || door === 'unknown') {
      if (door !== 'closed') return 'unreachable'
      return this.openDoor(state, ctx)
    }
    const stand = ctx.rules.standInfo(this.dest)
    if (stand.state === 'unknown') return 'unreachable'
    if (stand.state === 'no') return 'unreachable'
    aim(ctx, this.dest)
    holdForward(ctx, ctx.constraints.profile === 'sprint')
    return 'running'
  }

  private openDoor(state: MoveState, ctx: MoveContext): MoveStatus {
    ctx.world.setInput('forward', false)
    ctx.world.setInput('sprint', false)
    if (this.doorUseAt === undefined) {
      this.doorUseAt = ctx.now
      this.doorAttempts += 1
      ctx.world.useOn(this.dest)
      state.detail = 'opening-door'
      return 'running'
    }
    // Re-issue once if the first use did not take; never spam the server.
    if (ctx.now - this.doorUseAt > 600 && this.doorAttempts < 2) {
      this.doorUseAt = ctx.now
      this.doorAttempts += 1
      ctx.world.useOn(this.dest)
      return 'running'
    }
    if (ctx.now - this.doorUseAt > 1_500) return 'failed'
    return 'running'
  }
}

export class AscendMove extends BaseMove {
  readonly kind = 'ascend' as const
  private phase: 'approach' | 'jump' = 'approach'
  private jumpTicks = 0
  private retries = 0

  constructor(readonly src: Cell, readonly dest: Cell) {
    super()
  }

  cost(ctx: MoveContext): number {
    if (this.dest.y !== this.src.y + 1 || !adjacent(this.src, this.dest)) return COST_INF
    if (ctx.rules.standInfo(this.src).state !== 'yes') return COST_INF
    const stand = ctx.rules.standInfo(this.dest)
    if (stand.state !== 'yes') return COST_INF
    if (ctx.rules.canWalkThrough(this.dest) !== 'yes') return COST_INF
    return 1.5
  }

  validPositions(): readonly Cell[] {
    return [this.src, this.dest]
  }

  reset(): void {
    this.phase = 'approach'
    this.jumpTicks = 0
    this.retries = 0
  }

  safeToCancel(_state: MoveState): boolean {
    return this.phase === 'approach'
  }

  update(state: MoveState, ctx: MoveContext): MoveStatus {
    state.ticks += 1
    state.elapsedMs = ctx.now - state.startedAt
    if (reached(ctx.position, this.dest, ctx)) {
      releaseInputs(ctx)
      return 'success'
    }
    const distance = distance2d(ctx.position, this.dest)
    if (this.phase === 'approach') {
      aim(ctx, this.dest)
      holdForward(ctx)
      if (distance <= 0.9 && ctx.self.onGround) {
        this.phase = 'jump'
        this.jumpTicks = 0
      }
      return 'running'
    }
    this.jumpTicks += 1
    aim(ctx, this.dest)
    holdForward(ctx)
    ctx.world.setInput('jump', this.jumpTicks <= 2)
    if (this.jumpTicks > 3) ctx.world.setInput('jump', false)
    if (ctx.self.onGround && this.jumpTicks > 4) {
      this.retries += 1
      if (this.retries > 2) {
        releaseInputs(ctx)
        state.detail = 'jump-did-not-land'
        return 'failed'
      }
      this.phase = 'approach'
      this.jumpTicks = 0
      ctx.world.setInput('jump', false)
    }
    return 'running'
  }
}

export class DescendMove extends BaseMove {
  readonly kind = 'descend' as const
  constructor(readonly src: Cell, readonly dest: Cell) {
    super()
  }

  cost(ctx: MoveContext): number {
    if (this.dest.y !== this.src.y - 1 || !adjacent(this.src, this.dest)) return COST_INF
    if (ctx.rules.standInfo(this.dest).state !== 'yes') return COST_INF
    if (ctx.rules.canWalkThrough(this.dest) !== 'yes') return COST_INF
    return 1.1
  }

  validPositions(): readonly Cell[] {
    return [this.src, this.dest]
  }

  safeToCancel(_state: MoveState): boolean {
    return true
  }

  update(state: MoveState, ctx: MoveContext): MoveStatus {
    state.ticks += 1
    state.elapsedMs = ctx.now - state.startedAt
    if (reached(ctx.position, this.dest, ctx)) {
      releaseInputs(ctx)
      return 'success'
    }
    aim(ctx, this.dest)
    holdForward(ctx)
    return 'running'
  }
}

export class FallMove extends BaseMove {
  readonly kind = 'fall' as const
  constructor(readonly src: Cell, readonly dest: Cell) {
    super()
  }

  cost(ctx: MoveContext): number {
    const drop = this.src.y - this.dest.y
    if (drop < 2 || drop > ctx.constraints.maxFall || !adjacent(this.src, this.dest)) return COST_INF
    if (!this.landingSafe(ctx)) return COST_INF
    return 1.5 + drop
  }

  private landingSafe(ctx: MoveContext): boolean {
    if (ctx.rules.standInfo(this.dest).state !== 'yes') return false
    // A planned fall must pass through loaded, clear, non-hazard cells.
    for (let y = this.dest.y; y <= this.src.y; y += 1) {
      const cell = { x: this.dest.x, y, z: this.dest.z }
      if (ctx.rules.isHazard(cell) === 'yes') return false
      if (ctx.rules.isWater(cell) === 'yes' || ctx.rules.isLava(cell) === 'yes') return false
      if (y === this.src.y) continue
      if (y === this.dest.y) continue
      if (ctx.rules.canWalkThrough(cell) !== 'yes') return false
    }
    return true
  }

  validPositions(): readonly Cell[] {
    return [this.src, this.dest]
  }

  safeToCancel(_state: MoveState): boolean {
    return false
  }

  update(state: MoveState, ctx: MoveContext): MoveStatus {
    state.ticks += 1
    state.elapsedMs = ctx.now - state.startedAt
    if (reached(ctx.position, this.dest, ctx)) {
      releaseInputs(ctx)
      return 'success'
    }
    aim(ctx, this.dest)
    holdForward(ctx)
    return 'running'
  }
}

export class DownwardMove extends BaseMove {
  readonly kind = 'downward' as const
  constructor(readonly src: Cell, readonly dest: Cell) {
    super()
  }

  cost(ctx: MoveContext): number {
    if (!sameColumn(this.src, this.dest)) return COST_INF
    const drop = this.src.y - this.dest.y
    if (drop < 1 || drop > ctx.constraints.maxFall) return COST_INF
    if (ctx.rules.standInfo(this.dest).state !== 'yes') return COST_INF
    // A purely vertical descent is only usable when the floor under the source
    // is already gone (otherwise no input can move the body straight down).
    if (ctx.rules.canWalkThrough({ x: this.src.x, y: this.src.y - 1, z: this.src.z }) !== 'yes') return COST_INF
    return 1.2 + drop
  }

  validPositions(): readonly Cell[] {
    return [this.src, this.dest]
  }

  safeToCancel(_state: MoveState): boolean {
    return false
  }

  update(state: MoveState, ctx: MoveContext): MoveStatus {
    state.ticks += 1
    state.elapsedMs = ctx.now - state.startedAt
    if (reached(ctx.position, this.dest, ctx)) {
      releaseInputs(ctx)
      return 'success'
    }
    aim(ctx, this.dest)
    return 'running'
  }
}

export class BridgeMove extends BaseMove {
  readonly kind = 'bridge' as const
  private phase: 'approach' | 'place' | 'cross' = 'approach'
  private phaseAt = 0
  private retried = false

  constructor(readonly src: Cell, readonly dest: Cell) {
    super()
  }

  cost(ctx: MoveContext): number {
    if (!ctx.constraints.allowPlace || ctx.constraints.material === undefined) return COST_INF
    if (this.src.y !== this.dest.y || !adjacent(this.src, this.dest)) return COST_INF
    if (ctx.rules.canWalkThrough(this.dest) !== 'yes') return COST_INF
    if (ctx.rules.isHazard(this.dest) === 'yes') return COST_INF
    // Once this move has placed its support, the same cell is intentionally no
    // longer replaceable; only a pre-placement plan needs the check.
    if (this.phase === 'approach' && ctx.rules.isReplaceable(this.support()) !== 'yes') return COST_INF
    return 4
  }

  private support(): Cell {
    return { x: this.dest.x, y: this.dest.y - 1, z: this.dest.z }
  }

  validPositions(): readonly Cell[] {
    return [this.src, this.dest]
  }

  toPlace(): readonly Cell[] {
    return [this.support()]
  }

  reset(): void {
    this.phase = 'approach'
    this.phaseAt = 0
    this.retried = false
  }

  safeToCancel(_state: MoveState): boolean {
    return this.phase !== 'place'
  }

  update(state: MoveState, ctx: MoveContext): MoveStatus {
    state.ticks += 1
    state.elapsedMs = ctx.now - state.startedAt
    if (reached(ctx.position, this.dest, ctx)) {
      releaseInputs(ctx)
      return 'success'
    }
    const material = ctx.constraints.material
    if (material === undefined) return 'unreachable'
    if (this.phase === 'approach') {
      if (!ctx.self.onGround) {
        aim(ctx, this.dest)
        holdForward(ctx)
        return 'running'
      }
      if (distance2d(ctx.position, this.src) > 0.35) {
        aim(ctx, this.src)
        holdForward(ctx)
        // Crouch before reaching the edge; a late sneak is a fall.
        if (distance2d(ctx.position, this.src) <= 1.2) ctx.world.setInput('sneak', true)
        return 'running'
      }
      this.phase = 'place'
      this.phaseAt = ctx.now
      ctx.world.setInput('forward', false)
      ctx.world.setInput('sneak', true)
      ctx.world.place(this.support(), material)
      state.detail = 'placing'
      return 'running'
    }
    if (this.phase === 'place') {
      ctx.world.setInput('forward', false)
      ctx.world.setInput('sneak', true)
      if (ctx.rules.standInfo(this.dest).state === 'yes') {
        this.phase = 'cross'
        state.detail = 'placed'
        return 'running'
      }
      if (ctx.now - this.phaseAt > 600 && !this.retried) {
        this.retried = true
        this.phaseAt = ctx.now
        ctx.world.place(this.support(), material)
      }
      if (ctx.now - this.phaseAt > 2_000) {
        state.detail = 'place-not-confirmed'
        return 'failed'
      }
      return 'running'
    }
    aim(ctx, this.dest)
    holdForward(ctx)
    ctx.world.setInput('sneak', true)
    state.detail = 'crossing'
    return 'running'
  }
}

export class PillarMove extends BaseMove {
  readonly kind = 'pillar' as const
  private phase: 'jump' | 'air' | 'place' | 'land' = 'jump'
  private level = 0
  private phaseAt = 0
  private retries = 0
  private jumpTicks = 0
  /** Cells this move has already placed; the executor revalidates cost each tick. */
  private placed = 0

  constructor(readonly src: Cell, readonly dest: Cell) {
    super()
  }

  private levels(): number {
    return this.dest.y - this.src.y
  }

  private currentY(): number {
    return this.src.y + this.level
  }

  private columnCell(y: number): Cell {
    return { x: this.src.x, y, z: this.src.z }
  }

  cost(ctx: MoveContext): number {
    if (!ctx.constraints.allowPlace || ctx.constraints.material === undefined) return COST_INF
    const levels = this.levels()
    if (levels < 1 || levels > 8) return COST_INF
    if (this.dest.x !== this.src.x || this.dest.z !== this.src.z) return COST_INF
    if (ctx.rules.standInfo(this.columnCell(this.currentY())).state !== 'yes') return COST_INF
    if (ctx.rules.canWalkThrough(this.dest) !== 'yes') return COST_INF
    if (ctx.rules.canPlaceAgainst(this.columnCell(this.src.y - 1)) !== 'yes') return COST_INF
    // Skip the blocks this move already placed; a mid-pillar revalidation must
    // not mistake its own support column for an obstruction.
    for (let y = this.src.y + this.placed; y < this.dest.y; y += 1) {
      if (ctx.rules.isReplaceable(this.columnCell(y)) !== 'yes') return COST_INF
    }
    return 4 + levels
  }

  validPositions(): readonly Cell[] {
    const cells: Cell[] = [this.src]
    for (let level = 1; level <= this.levels(); level += 1) cells.push(this.columnCell(this.src.y + level))
    return cells
  }

  toPlace(): readonly Cell[] {
    const cells: Cell[] = []
    for (let y = this.src.y; y < this.dest.y; y += 1) cells.push(this.columnCell(y))
    return cells
  }

  reset(): void {
    this.phase = 'jump'
    this.level = 0
    this.phaseAt = 0
    this.retries = 0
    this.jumpTicks = 0
    this.placed = 0
  }

  safeToCancel(_state: MoveState): boolean {
    return this.phase === 'jump'
  }

  update(state: MoveState, ctx: MoveContext): MoveStatus {
    state.ticks += 1
    state.elapsedMs = ctx.now - state.startedAt
    if (reached(ctx.position, this.dest, ctx)) {
      releaseInputs(ctx)
      return 'success'
    }
    const material = ctx.constraints.material
    if (material === undefined) return 'unreachable'

    if (this.phase === 'land' && ctx.self.onGround && ctx.self.pos.y >= this.currentY() + 0.9) {
      if (this.level + 1 >= this.levels()) {
        releaseInputs(ctx)
        return 'success'
      }
      this.level += 1
      this.phase = 'jump'
      this.phaseAt = 0
      state.detail = `level-${this.level}`
    }

    if (this.phase === 'jump') {
      if (!ctx.self.onGround) return 'running'
      ctx.world.setInput('jump', true)
      this.jumpTicks = 1
      this.phase = 'air'
      this.phaseAt = ctx.now
      state.detail = `jumping-${this.level}`
      return 'running'
    }
    if (this.phase === 'air') {
      this.jumpTicks += 1
      ctx.world.setInput('jump', this.jumpTicks <= 3)
      // The block goes into the cell the feet just left. Wait until the feet
      // are above that cell's top, otherwise the server refuses the placement
      // because the player AABB still overlaps it.
      if (ctx.self.pos.y > this.currentY() + 1.01) {
        ctx.world.place(this.columnCell(this.currentY()), material)
        this.placed += 1
        this.phase = 'place'
        this.phaseAt = ctx.now
        state.detail = 'placing'
        return 'running'
      }
      if (ctx.self.onGround && ctx.now - this.phaseAt > 300) {
        this.retries += 1
        if (this.retries > 2) {
          state.detail = 'jump-did-not-lift'
          return 'failed'
        }
        this.phase = 'jump'
        this.jumpTicks = 0
      }
      return 'running'
    }
    if (this.phase === 'place') {
      if (ctx.rules.standInfo(this.columnCell(this.currentY() + 1)).state === 'yes') {
        this.phase = 'land'
        state.detail = 'placed'
        return 'running'
      }
      // The placement missed and the body is back on the previous support:
      // jump again instead of trying to place into our own feet cell.
      if (ctx.self.onGround) {
        this.retries += 1
        if (this.retries > 6) {
          state.detail = 'place-not-confirmed'
          return 'failed'
        }
        this.placed = Math.max(0, this.placed - 1)
        this.phase = 'jump'
        this.phaseAt = 0
        return 'running'
      }
      if (ctx.now - this.phaseAt > 600 && this.retries < 6) {
        this.retries += 1
        this.phaseAt = ctx.now
        ctx.world.place(this.columnCell(this.currentY()), material)
      }
      if (ctx.now - this.phaseAt > 2_000) {
        state.detail = 'place-not-confirmed'
        return 'failed'
      }
      return 'running'
    }
    state.detail = 'landing'
    return 'running'
  }
}

export class DiagonalMove extends BaseMove {  readonly kind = 'diagonal' as const
  constructor(readonly src: Cell, readonly dest: Cell) {
    super()
  }

  cost(ctx: MoveContext): number {
    if (!ctx.constraints.allowDiagonal || this.src.y !== this.dest.y || !diagonal(this.src, this.dest)) return COST_INF
    const through = ctx.rules.canWalkThrough(this.dest)
    if (through !== 'yes') return COST_INF
    if (ctx.rules.standInfo(this.dest).state !== 'yes') return COST_INF
    // Both cardinal side cells must be walkable too; otherwise the corner clips.
    const a = { x: this.dest.x, y: this.src.y, z: this.src.z }
    const b = { x: this.src.x, y: this.src.y, z: this.dest.z }
    if (ctx.rules.canWalkThrough(a) !== 'yes' || ctx.rules.canWalkThrough(b) !== 'yes') return COST_INF
    return 1.4
  }

  validPositions(): readonly Cell[] {
    return [this.src, this.dest]
  }

  safeToCancel(_state: MoveState): boolean {
    return true
  }

  update(state: MoveState, ctx: MoveContext): MoveStatus {
    state.ticks += 1
    state.elapsedMs = ctx.now - state.startedAt
    if (reached(ctx.position, this.dest, ctx)) {
      releaseInputs(ctx)
      return 'success'
    }
    aim(ctx, this.dest)
    holdForward(ctx)
    return 'running'
  }
}

export class ParkourMove extends BaseMove {
  readonly kind = 'parkour' as const
  private jumped = false
  constructor(readonly src: Cell, readonly dest: Cell) {
    super()
  }

  cost(ctx: MoveContext): number {
    if (!ctx.constraints.allowParkour || !jumpGap(this.src, this.dest)) return COST_INF
    if (ctx.rules.standInfo(this.dest).state !== 'yes') return COST_INF
    const gap = { x: Math.floor((this.src.x + this.dest.x) / 2), y: this.src.y, z: Math.floor((this.src.z + this.dest.z) / 2) }
    if (ctx.rules.canWalkThrough(gap) !== 'yes') return COST_INF
    return 2.5
  }

  validPositions(): readonly Cell[] {
    return [this.src, this.dest]
  }

  reset(): void {
    this.jumped = false
  }

  safeToCancel(_state: MoveState): boolean {
    return !this.jumped
  }

  update(state: MoveState, ctx: MoveContext): MoveStatus {
    state.ticks += 1
    state.elapsedMs = ctx.now - state.startedAt
    if (reached(ctx.position, this.dest, ctx)) {
      releaseInputs(ctx)
      return 'success'
    }
    aim(ctx, this.dest)
    holdForward(ctx, true)
    if (!this.jumped && ctx.self.onGround && distance2d(ctx.position, this.src) <= 0.75) {
      this.jumped = true
      ctx.world.setInput('jump', true)
    } else if (this.jumped) {
      ctx.world.setInput('jump', false)
    }
    return 'running'
  }
}

function directionOf(from: Cell, to: Cell): 'north' | 'south' | 'east' | 'west' {
  if (to.x > from.x) return 'east'
  if (to.x < from.x) return 'west'
  if (to.z > from.z) return 'south'
  return 'north'
}

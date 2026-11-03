import { distance2d } from './geometry.ts'
import { cellOf, PLAYER_HALF_WIDTH, PLAYER_HEIGHT } from '../model/block.ts'
import type {
  Cell,
  Move,
  MoveContext,
  MoveKind,
  MoveState,
  MoveStatus,
  Rules,
  Vec3,
} from '../model/types.ts'
import { COST_INF } from '../model/types.ts'

/**
 * Vanilla jump kinematics: v0 = 0.42, gravity 0.08, drag 0.98 per tick, which
 * peaks at 1.2522 blocks. A rise at or below `JUMP_PEAK - JUMP_MARGIN` is
 * reliably landable; the margin absorbs tick quantisation and the fact that the
 * executor launches from up to 0.9 blocks away instead of standing still.
 */
export const JUMP_PEAK = 1.2522
export const JUMP_MARGIN = 0.15
/** The body must clear the placement cell's top by this much before placing. */
export const PLACE_CLEARANCE = 1.01

/**
 * Does the body occupy `cell` at its derived feet height? Uses the same rules
 * as the planner, including slab/carpet feet offsets.
 */
export function reached(pos: Vec3, cell: Cell, ctx: MoveContext, tolerance = 0.55): boolean {
  const info = ctx.rules.standInfo(cell)
  if (info.state !== 'yes') return false
  // A swimming body floats around the cell base and bobs, so the vertical
  // tolerance is a full block for water cells (same rule as the vanilla
  // follower's `e < 1.0`).
  const vertical = ctx.rules.isWater(cell) === 'yes' ? 1 : 0.45
  return distance2d(pos, cell) <= tolerance && Math.abs(pos.y - info.feetY) <= vertical
}

/**
 * Ladder/vine arrival. A climbable cell has no support of its own, so the
 * generic `reached` cannot be used; the body is "on" it while its feet are in
 * that cell and horizontally centred on the column.
 */
export function onClimb(pos: Vec3, cell: Cell, ctx: MoveContext, tolerance = 0.55): boolean {
  if (ctx.rules.isClimbable(cell) !== 'yes') return false
  const distance = Math.hypot(pos.x - (cell.x + 0.5), pos.z - (cell.z + 0.5))
  return distance <= tolerance && pos.y >= cell.y - 0.05 && pos.y <= cell.y + 0.95
}

export { cellOf }

/**
 * The planner's identity for the body's current position.
 *
 * The search node is the *feet cell* whose `standInfo` feet height matches the
 * real feet position, not simply `floor(pos.y)`: a bottom slab at y=69 puts the
 * feet at 69.5 and the node at 70; farmland at 69 (top 69.9375) is also node
 * 70. When the centre column has no matching stand, the body's AABB corners
 * are tried (vanilla `getStart` fallback), so a body half over a step still
 * maps to a node it can actually stand on. Water keeps the surface-node rule.
 */
export function standingCell(rules: Rules, pos: Vec3): Cell {
  const water = surfaceWaterCell(rules, pos)
  if (water !== undefined) return water
  return groundStandingCell(rules, pos)
}

function surfaceWaterCell(rules: Rules, pos: Vec3): Cell | undefined {
  const start = cellOf(pos)
  if (rules.isWater(start) !== 'yes') return undefined
  // A floating body's feet sit below the block-level surface cell; walk up to
  // the topmost water cell (the swim node) if the model accepts it.
  for (let dy = 0; dy <= 2; dy += 1) {
    const candidate = { x: start.x, y: start.y + dy, z: start.z }
    if (rules.isWater(candidate) !== 'yes') continue
    const above = { x: start.x, y: candidate.y + 1, z: start.z }
    if (rules.isWater(above) === 'yes') continue
    if (rules.standInfo(candidate).state === 'yes') return candidate
  }
  return undefined
}

function groundStandingCell(rules: Rules, pos: Vec3): Cell {
  const baseY = Math.floor(pos.y + 0.5)
  const centre = { x: Math.floor(pos.x), z: Math.floor(pos.z) }
  let best: { cell: Cell; feetDelta: number; centreDistance: number } | undefined
  for (const column of bodyColumns(pos)) {
    for (let dy = 1; dy >= -1; dy -= 1) {
      const cell = { x: column.x, y: baseY + dy, z: column.z }
      const info = rules.standInfo(cell)
      if (info.state !== 'yes') continue
      const feetDelta = Math.abs(info.feetY - pos.y)
      // The node must actually be the body's feet, not a neighbouring step.
      if (feetDelta > 0.6) continue
      const centreDistance = Math.hypot(cell.x - centre.x, cell.z - centre.z)
      if (best === undefined
        || feetDelta < best.feetDelta - 1e-9
        || (Math.abs(feetDelta - best.feetDelta) <= 1e-9 && centreDistance < best.centreDistance)) {
        best = { cell, feetDelta, centreDistance }
      }
    }
  }
  return best?.cell ?? { x: centre.x, y: baseY, z: centre.z }
}

/** Columns the 0.6-wide body AABB covers, including both boundary columns. */
function bodyColumns(pos: Vec3): Array<{ x: number; z: number }> {
  const xs = uniqueIndices([pos.x, pos.x - PLAYER_HALF_WIDTH + 1e-4, pos.x + PLAYER_HALF_WIDTH - 1e-4])
  const zs = uniqueIndices([pos.z, pos.z - PLAYER_HALF_WIDTH + 1e-4, pos.z + PLAYER_HALF_WIDTH - 1e-4])
  const columns: Array<{ x: number; z: number }> = []
  for (const x of xs) for (const z of zs) columns.push({ x, z })
  return columns
}

function uniqueIndices(values: readonly number[]): number[] {
  const result: number[] = []
  for (const value of values) {
    const index = Math.floor(value)
    if (!result.includes(index)) result.push(index)
  }
  return result
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

/**
 * "Head fully under": the eye and the cell above it are both water. A body
 * floating at the waterline has its eye in the top water cell with air above
 * it, and must NOT count as submerged: an entry splash sinks it briefly, and a
 * depth threshold tight enough to catch that would fight every surface swim.
 */
export function isDeeplySubmerged(rules: Rules, pos: Vec3): boolean {
  const eye = { x: Math.floor(pos.x), y: Math.floor(pos.y + 1.6), z: Math.floor(pos.z) }
  if (rules.isWater(eye) !== 'yes') return false
  return rules.isWater({ x: eye.x, y: eye.y + 1, z: eye.z }) === 'yes'
}

/** The eye is inside a water block (a floating body flickers around this line). */
export function isEyeInWater(rules: Rules, pos: Vec3): boolean {
  const eye = { x: Math.floor(pos.x), y: Math.floor(pos.y + 1.6), z: Math.floor(pos.z) }
  return rules.isWater(eye) === 'yes'
}

function keepHeadAboveWater(ctx: MoveContext): boolean {
  // Jump as soon as the eye touches water, not only after the head is fully
  // under: the entry splash otherwise sinks a body to the pool floor before
  // buoyancy gets a chance to act.
  if (!isEyeInWater(ctx.rules, ctx.position)) return false
  ctx.world.setInput('jump', true)
  return true
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

  toBreak(_ctx: MoveContext): readonly Cell[] {
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

function sameCell(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

/** Feet and head cells of a two-block-high body at `cell`. */
function bodyCells(cell: Cell): Cell[] {
  return [cell, { x: cell.x, y: cell.y + 1, z: cell.z }]
}

/**
 * Cells the body enters near the jump apex, derived from the real feet height
 * and the vanilla peak instead of a hard-coded "third cell". Cells the apex
 * body only clips (less than 0.1 block) are not required, matching Baritone's
 * `src.above(2)` behaviour and keeping a +1 step jumpable in a 3-high corridor.
 */
function jumpClearance(ctx: MoveContext, src: Cell, columns: readonly Cell[] = [src]): Cell[] {
  const info = ctx.rules.standInfo(src)
  const feet = info.state === 'yes' ? info.feetY : src.y
  const first = Math.floor(feet + JUMP_PEAK + 0.1)
  const last = Math.floor(feet + JUMP_PEAK + PLAYER_HEIGHT - 0.1)
  const cells: Cell[] = []
  for (const column of columns) {
    for (let y = first; y <= last; y += 1) cells.push({ x: column.x, y, z: column.z })
  }
  return cells
}

/** Clearance set for a +1 step: the destination body plus the takeoff apex. */
function ascendClearance(ctx: MoveContext, src: Cell, dest: Cell): Cell[] {
  return uniqueCells([...bodyCells(dest), ...jumpClearance(ctx, src)])
}

/** Stepping down also needs the head cell two above the destination. */
function descendClearance(dest: Cell): Cell[] {
  return uniqueCells([...bodyCells(dest), { x: dest.x, y: dest.y + 2, z: dest.z }])
}

/** Every intermediate pillar level must have its own apex clearance. */
function pillarClearance(ctx: MoveContext, src: Cell, dest: Cell): Cell[] {
  const cells = bodyCells(dest)
  for (let y = src.y; y < dest.y; y += 1) {
    const level = { x: src.x, y, z: src.z }
    cells.push(...jumpClearance(ctx, level))
  }
  return uniqueCells(cells)
}

/** Parkour clearance: takeoff, gap and landing columns up to the apex. */
function parkourClearance(ctx: MoveContext, src: Cell, dest: Cell): Cell[] {
  const gap = {
    x: Math.floor((src.x + dest.x) / 2),
    y: src.y,
    z: Math.floor((src.z + dest.z) / 2),
  }
  return uniqueCells([
    ...bodyCells(dest),
    ...bodyCells(gap),
    ...jumpClearance(ctx, src, [src, gap, dest]),
  ])
}

function uniqueCells(cells: readonly Cell[]): Cell[] {
  const result: Cell[] = []
  for (const cell of cells) {
    if (!result.some(item => sameCell(item, cell))) result.push(cell)
  }
  return result
}

/**
 * True when every blocking body cell is either already passable or explicitly
 * authorized by `Rules.canBreak`. Unknown is never folded into passable.
 */
function passableOrBreakable(ctx: MoveContext, cells: readonly Cell[]): boolean {
  for (const cell of cells) {
    const through = ctx.rules.canPass(cell)
    if (through === 'yes') continue
    if (through === 'unknown') return false
    if (ctx.rules.canBreak(cell) !== 'yes') return false
  }
  return true
}

function breakableCells(ctx: MoveContext, cells: readonly Cell[]): Cell[] {
  return uniqueCells(cells).filter(cell => ctx.rules.canPass(cell) !== 'yes' && ctx.rules.canBreak(cell) === 'yes')
}

function breakCostOf(ctx: MoveContext, cells: readonly Cell[]): number {
  let cost = 0
  for (const cell of cells) {
    cost += ctx.rules.breakCost(cell) ?? 0
  }
  return cost
}

function standInfoWithBreaks(ctx: MoveContext, cell: Cell, cells: readonly Cell[]) {
  return ctx.rules.standInfo(cell, cells.filter(item => ctx.rules.canBreak(item) === 'yes'))
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
    if (door === 'open') {
      // An open door can still report a solid collision shape on some
      // versions; the door state is authoritative for passing through it.
      return ctx.rules.isDoorPassable(this.dest, directionOf(this.src, this.dest)) === 'yes' ? 1 : COST_INF
    }
    const cells = bodyCells(this.dest)
    if (!passableOrBreakable(ctx, cells)) return COST_INF
    const stand = standInfoWithBreaks(ctx, this.dest, cells)
    if (stand.state !== 'yes') return COST_INF
    // Wading is slower than dry ground; the planner should prefer a dry route
    // when one exists, but water is not a wall.
    const wet = ctx.rules.isWater(this.dest) === 'yes' || ctx.rules.isWater(this.src) === 'yes'
    return (wet ? 2 : 1) + breakCostOf(ctx, cells)
  }

  toBreak(ctx: MoveContext): readonly Cell[] {
    if (ctx.rules.doorState(this.dest) !== 'none') return []
    return breakableCells(ctx, bodyCells(this.dest))
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
    ctx.world.setInput('jump', keepHeadAboveWater(ctx))
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
    // The source must hold the body; its real feet height is what decides
    // whether the nominal +1 step is jumpable.
    const srcInfo = ctx.rules.standInfo(this.src)
    if (srcInfo.state !== 'yes') return COST_INF
    const cells = ascendClearance(ctx, this.src, this.dest)
    if (!passableOrBreakable(ctx, cells)) return COST_INF
    const stand = standInfoWithBreaks(ctx, this.dest, cells)
    if (stand.state !== 'yes') return COST_INF
    // A partial support (bottom slab, farmland, chest) lifts the feet, so the
    // nominal +1 step can be a taller jump. Compare real heights against the
    // vanilla peak, not "is the support a full block": farmland (0.9375 -> a
    // 1.0625 rise) is jumpable, a bottom slab (1.5) is not.
    if (stand.feetY - srcInfo.feetY > JUMP_PEAK - JUMP_MARGIN) return COST_INF
    return 1.5 + breakCostOf(ctx, cells)
  }

  toBreak(ctx: MoveContext): readonly Cell[] {
    return breakableCells(ctx, ascendClearance(ctx, this.src, this.dest))
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
    // A wade source is a floor under water: vanilla replaces the normal jump
    // with the slower swim-up, so the body must hold jump long enough to clear
    // the rim instead of pulsing it like a dry jump.
    const wetSource = ctx.rules.isWater(this.src) === 'yes'
    const distance = distance2d(ctx.position, this.dest)
    if (this.phase === 'approach') {
      aim(ctx, this.dest)
      holdForward(ctx)
      if (distance <= 0.9 && (ctx.self.onGround || wetSource)) {
        this.phase = 'jump'
        this.jumpTicks = 0
      }
      return 'running'
    }
    this.jumpTicks += 1
    aim(ctx, this.dest)
    holdForward(ctx)
    const hold = wetSource ? 24 : 2
    ctx.world.setInput('jump', this.jumpTicks <= hold)
    if (this.jumpTicks > hold + 1) ctx.world.setInput('jump', false)
    // Swimming up never reports onGround, so the dry-jump retry cannot judge it;
    // the move timeout bounds the attempt instead.
    if (!wetSource && ctx.self.onGround && this.jumpTicks > 4) {
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
    const cells = descendClearance(this.dest)
    if (!passableOrBreakable(ctx, cells)) return COST_INF
    if (standInfoWithBreaks(ctx, this.dest, cells).state !== 'yes') return COST_INF
    return 1.1 + breakCostOf(ctx, cells)
  }

  toBreak(ctx: MoveContext): readonly Cell[] {
    return breakableCells(ctx, descendClearance(this.dest))
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
    ctx.world.setInput('jump', keepHeadAboveWater(ctx))
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
    const max = Math.max(ctx.constraints.maxFall, ctx.constraints.safeFallBudget ?? 0)
    if (drop < 2 || drop > max || !adjacent(this.src, this.dest)) return COST_INF
    if (!this.landingSafe(ctx)) return COST_INF
    return 1.5 + drop + (drop > ctx.constraints.maxFall ? 1 : 0)
  }

  private landingSafe(ctx: MoveContext): boolean {
    const stand = ctx.rules.standInfo(this.dest)
    if (stand.state !== 'yes') return false
    // Water absorbs the fall: under the swim profile any depth is a landing,
    // so the solid-support requirement does not apply there.
    if (ctx.rules.isWater(this.dest) !== 'yes') {
      const support = ctx.rules.supportFeet(this.dest)
      if (support.state !== 'yes') return false
      // Landing on a half-height support (bottom slab, carpet) has an ambiguous
      // landing height; the reference behaviour refuses it unless explicitly
      // allowed. Wading water keeps the pool floor as the support, so it is a
      // full-height landing and unaffected.
      if (ctx.constraints.allowFallOntoHalfSupport !== true && support.feetY < this.dest.y - 0.01) {
        return false
      }
    }
    // A planned fall must pass through loaded, clear, non-hazard cells. The
    // landing cell itself may be wadeable water (the water absorbs the fall).
    for (let y = this.dest.y; y <= this.src.y; y += 1) {
      const cell = { x: this.dest.x, y, z: this.dest.z }
      if (ctx.rules.isHazard(cell) === 'yes') return false
      if (y !== this.dest.y && (ctx.rules.isWater(cell) === 'yes' || ctx.rules.isLava(cell) === 'yes')) {
        return false
      }
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
    // Surfacing after a landing in deeper water; harmless while airborne.
    ctx.world.setInput('jump', keepHeadAboveWater(ctx))
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
    // The placement happens in the cell this move leaves, so the jump peak must
    // clear that cell's top by PLACE_CLEARANCE. A bottom slab (feet 0.5 over the
    // base) can never reach it; farmland (0.9375) still can. `update` uses the
    // same constant, so the planned edge and the placement threshold cannot drift.
    const srcSupport = ctx.rules.supportFeet(this.src)
    if (srcSupport.state !== 'yes') return COST_INF
    if (srcSupport.feetY + JUMP_PEAK - JUMP_MARGIN <= this.src.y + PLACE_CLEARANCE) return COST_INF
    // While a block for this level is in flight the observed world can still be
    // the pre-placement state; `update` owns the readback. Do not reject the
    // edge from a transient snapshot between place and block-update.
    if (this.placed <= this.level
      && ctx.rules.standInfo(this.columnCell(this.currentY())).state !== 'yes') return COST_INF
    const cells = pillarClearance(ctx, this.src, this.dest)
    if (!passableOrBreakable(ctx, cells)) return COST_INF
    if (ctx.rules.canPlaceAgainst(this.columnCell(this.src.y - 1)) !== 'yes') return COST_INF
    // Skip the blocks this move already placed; a mid-pillar revalidation must
    // not mistake its own support column for an obstruction.
    for (let y = this.src.y + this.placed; y < this.dest.y; y += 1) {
      if (ctx.rules.isReplaceable(this.columnCell(y)) !== 'yes') return COST_INF
    }
    return 4 + levels + breakCostOf(ctx, cells)
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

  toBreak(ctx: MoveContext): readonly Cell[] {
    return breakableCells(ctx, pillarClearance(ctx, this.src, this.dest))
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
      if (ctx.self.pos.y > this.currentY() + PLACE_CLEARANCE) {
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
    const a = { x: this.dest.x, y: this.src.y, z: this.src.z }
    const b = { x: this.src.x, y: this.src.y, z: this.dest.z }
    const cells = uniqueCells([...bodyCells(this.dest), ...bodyCells(a), ...bodyCells(b)])
    if (!passableOrBreakable(ctx, cells)) return COST_INF
    if (standInfoWithBreaks(ctx, this.dest, cells).state !== 'yes') return COST_INF
    return 1.4 + breakCostOf(ctx, cells)
  }

  toBreak(ctx: MoveContext): readonly Cell[] {
    const a = { x: this.dest.x, y: this.src.y, z: this.src.z }
    const b = { x: this.src.x, y: this.src.y, z: this.dest.z }
    return breakableCells(ctx, uniqueCells([...bodyCells(this.dest), ...bodyCells(a), ...bodyCells(b)]))
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
    const srcSupport = ctx.rules.supportFeet(this.src)
    if (srcSupport.state !== 'yes') return COST_INF
    // Sprint-jumping out of a half step (bottom slab, stair tread) or off a
    // ladder has unreliable timing; the reference behaviour refuses those
    // starts, and it keeps "jump from a bottom slab" from becoming a coin flip.
    if (ctx.constraints.allowParkourFromHalfSupport !== true && srcSupport.feetY < this.src.y - 0.01) {
      return COST_INF
    }
    if (ctx.rules.isClimbable(this.src) === 'yes') return COST_INF
    const cells = parkourClearance(ctx, this.src, this.dest)
    if (!passableOrBreakable(ctx, cells)) return COST_INF
    if (standInfoWithBreaks(ctx, this.dest, cells).state !== 'yes') return COST_INF
    return 2.5 + breakCostOf(ctx, cells)
  }

  toBreak(ctx: MoveContext): readonly Cell[] {
    return breakableCells(ctx, parkourClearance(ctx, this.src, this.dest))
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

/**
 * Climb one cell up or down a ladder/vine column, or step sideways into one.
 * The destination must be climbable and body-passable: a ladder plate is thin,
 * so the real body check admits it while `canPass` (any collision at all) does
 * not. A climbable cell has no support of its own, so arrival is `onClimb`, not
 * the generic stand check.
 */
export class ClimbMove extends BaseMove {
  readonly kind = 'climb' as const

  constructor(readonly src: Cell, readonly dest: Cell) {
    super()
  }

  cost(ctx: MoveContext): number {
    if (ctx.constraints.allowClimb === false) return COST_INF
    if (ctx.rules.isClimbable(this.dest) !== 'yes') return COST_INF
    const dy = this.dest.y - this.src.y
    if (dy === 0) {
      if (!adjacent(this.src, this.dest)) return COST_INF
    } else if (Math.abs(dy) !== 1 || !sameColumn(this.src, this.dest)) {
      return COST_INF
    }
    if (ctx.rules.canWalkThrough(this.dest) !== 'yes') return COST_INF
    if (ctx.rules.isClimbable(this.src) !== 'yes') {
      // Entering from a normal cell: the source must hold the body.
      if (ctx.rules.standInfo(this.src).state !== 'yes') return COST_INF
    }
    return dy > 0 ? 3 : dy < 0 ? 2 : 1.6
  }

  validPositions(): readonly Cell[] {
    return [this.src, this.dest]
  }

  safeToCancel(state: MoveState): boolean {
    return state.ticks < 3
  }

  update(state: MoveState, ctx: MoveContext): MoveStatus {
    state.ticks += 1
    state.elapsedMs = ctx.now - state.startedAt
    if (onClimb(ctx.position, this.dest, ctx)) {
      releaseInputs(ctx)
      return 'success'
    }
    const dy = this.dest.y - this.src.y
    const off = Math.hypot(this.dest.x + 0.5 - ctx.position.x, this.dest.z + 0.5 - ctx.position.z)
    if (dy === 0 || off > 0.25) {
      // Re-centre on the column (or walk sideways into it); jump only upwards.
      aim(ctx, this.dest)
      ctx.world.setInput('forward', true)
      ctx.world.setInput('sneak', false)
      ctx.world.setInput('jump', dy > 0)
      state.detail = dy === 0 ? 'entering' : 'centering'
      return 'running'
    }
    // Centred on the column: jump climbs, sneak descends, nothing holds.
    ctx.world.setInput('forward', false)
    ctx.world.setInput('jump', dy > 0)
    ctx.world.setInput('sneak', dy < 0)
    state.detail = dy > 0 ? 'climbing-up' : 'climbing-down'
    return 'running'
  }
}

/**
 * Leaving a climbable column onto a ledge one block higher. This is the
 * standard "ladder through a ceiling hole" exit: the ladder top sits one block
 * below the upper floor, so the body jumps off the column diagonally (or
 * straight) onto the floor. `AscendMove` cannot express it because a climbable
 * cell has no support to stand on.
 */
export class ClimbExitMove extends BaseMove {
  readonly kind = 'climb' as const
  private jumpTicks = 0
  private retries = 0

  constructor(readonly src: Cell, readonly dest: Cell) {
    super()
  }

  cost(ctx: MoveContext): number {
    if (ctx.constraints.allowClimb === false) return COST_INF
    if (this.dest.y !== this.src.y + 1) return COST_INF
    if (!adjacent(this.src, this.dest) && !diagonal(this.src, this.dest)) return COST_INF
    // The body must be hanging on a climbable column.
    if (ctx.rules.isClimbable(this.src) !== 'yes') return COST_INF
    if (ctx.rules.canWalkThrough(this.src) !== 'yes') return COST_INF
    const cells = bodyCells(this.dest)
    if (!passableOrBreakable(ctx, cells)) return COST_INF
    const stand = standInfoWithBreaks(ctx, this.dest, cells)
    if (stand.state !== 'yes') return COST_INF
    // Jumping off the column is a normal jump whose feet start at the cell base.
    if (stand.feetY - this.src.y > JUMP_PEAK - JUMP_MARGIN) return COST_INF
    return 1.8 + breakCostOf(ctx, cells)
  }

  toBreak(ctx: MoveContext): readonly Cell[] {
    return breakableCells(ctx, bodyCells(this.dest))
  }

  validPositions(): readonly Cell[] {
    return [this.src, this.dest]
  }

  reset(): void {
    this.jumpTicks = 0
    this.retries = 0
  }

  safeToCancel(state: MoveState): boolean {
    return state.ticks < 3
  }

  update(state: MoveState, ctx: MoveContext): MoveStatus {
    state.ticks += 1
    state.elapsedMs = ctx.now - state.startedAt
    if (reached(ctx.position, this.dest, ctx)) {
      releaseInputs(ctx)
      return 'success'
    }
    this.jumpTicks += 1
    aim(ctx, this.dest)
    // Rise first, then carry forward: moving into the ledge before clearing its
    // top would pin the body against the block side.
    ctx.world.setInput('jump', this.jumpTicks <= 8)
    ctx.world.setInput('forward', this.jumpTicks > 3)
    ctx.world.setInput('sneak', false)
    if (this.jumpTicks > 20) {
      this.retries += 1
      if (this.retries > 2) {
        releaseInputs(ctx)
        state.detail = 'climb-exit-did-not-land'
        return 'failed'
      }
      this.jumpTicks = 0
      ctx.world.setInput('jump', false)
      ctx.world.setInput('forward', false)
    }
    return 'running'
  }
}

/**
 * Surface swimming. This is the one move that owns a body floating at the
 * waterline, modelled on the unvalidated follower's steer loop and on vanilla's
 * dedicated swimming controller: it holds forward for the whole edge and only
 * ever adds jump. Releasing forward (or letting another layer gate the tick)
 * makes a floating body oscillate at the waterline instead of advancing.
 */
export class SwimMove extends BaseMove {
  readonly kind = 'swim' as const

  constructor(readonly src: Cell, readonly dest: Cell) {
    super()
  }

  cost(ctx: MoveContext): number {
    if (ctx.constraints.waterProfile !== 'swim') return COST_INF
    if (!adjacent(this.src, this.dest)) return COST_INF
    if (ctx.rules.isWater(this.src) !== 'yes') return COST_INF
    const dy = this.dest.y - this.src.y
    if (dy !== 0 && dy !== 1) return COST_INF
    const destWet = ctx.rules.isWater(this.dest) === 'yes'
    if (destWet && dy !== 0) return COST_INF
    if (ctx.rules.standInfo(this.dest).state !== 'yes') return COST_INF
    return destWet ? 2 : 2.5
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
    ctx.world.setInput('forward', true)
    ctx.world.setInput('sneak', false)
    // Leaving the water needs the swim-up; inside the water the eye flickers
    // across the surface, and jumping on that flicker is harmless.
    const leaving = ctx.rules.isWater(this.dest) !== 'yes'
    ctx.world.setInput('jump', leaving || isEyeInWater(ctx.rules, ctx.position))
    return 'running'
  }
}

function directionOf(from: Cell, to: Cell): 'north' | 'south' | 'east' | 'west' {
  if (to.x > from.x) return 'east'
  if (to.x < from.x) return 'west'
  if (to.z > from.z) return 'south'
  return 'north'
}

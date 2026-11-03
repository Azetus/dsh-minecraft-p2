import type { Cell } from '../model/types.ts'
import type { FieldGeometry, MatrixBlockSpec, MatrixFill } from './scenarios.ts'

/**
 * Boundary terrain matrix: water, ladders, scaffolding, slabs/stairs and the
 * dangerous combinations around them. Each row is built from the same LAN
 * commands as the phase matrix and read by the same fixture builder.
 *
 * Expectations are per implementation stage, so the same row proves the
 * geometry/guard fix (`guards`), the climb move (`climb`) and the minimal water
 * profile (`water`) in order. Each stage is replayable from constraints:
 *   guards = waterProfile none + allowClimb false
 *   climb  = waterProfile none + allowClimb true
 *   water  = waterProfile wade + allowClimb true
 * `blocked` is a terminal order state, distinguished by the failure code: a
 * planned refusal must be GOTO_NO_PATH.
 */
export type BoundaryStage = 'guards' | 'climb' | 'wade' | 'swim'

export type BoundaryExpectation =
  | { state: 'succeeded' }
  | { state: 'blocked'; code: 'GOTO_NO_PATH' | 'GOTO_STUCK' | '*' }

export type BoundaryField = FieldGeometry & {
  id: string
  title: string
  /** What this row proves; also copied into the live report. */
  proves: string
  /**
   * `planner` (default) rows are decided at plan time, so the pure fixture can
   * assert them. `executor` rows plan fine and only fail in the world, so they
   * are covered by the live run alone.
   */
  verifiedBy?: 'planner' | 'executor'
  origin: Cell
  start: Cell
  goal: Cell
  probes: readonly Cell[]
  placementProbes?: readonly Cell[]
  authorization?: {
    allowParkour?: boolean
    allowPlace?: boolean
    material?: string
  }
  /**
   * Pre-fix behaviour known from analysis, not replayed: the live script only
   * prints it, so `GOTO_STUCK` vs `GOTO_NO_PATH` stays visible as a documented
   * baseline without checking out the old commit.
   */
  baseline?: BoundaryExpectation
  expect: Readonly<Record<BoundaryStage, BoundaryExpectation>>
}

const SUCCESS: BoundaryExpectation = { state: 'succeeded' }
const NO_PATH: BoundaryExpectation = { state: 'blocked', code: 'GOTO_NO_PATH' }

function same(expectation: BoundaryExpectation): Readonly<Record<BoundaryStage, BoundaryExpectation>> {
  return { guards: expectation, climb: expectation, wade: expectation, swim: expectation }
}

function at(origin: Cell, dx: number, dy: number, dz: number): Cell {
  return { x: origin.x + dx, y: origin.y + dy, z: origin.z + dz }
}

function fill(origin: Cell, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, block: string): MatrixFill {
  return { min: at(origin, x0, y0, z0), max: at(origin, x1, y1, z1), block }
}

function spec(origin: Cell, dx: number, dy: number, dz: number, name: string, state?: Record<string, string>): MatrixBlockSpec {
  return {
    at: at(origin, dx, dy, dz),
    name,
    ...(state === undefined ? {} : { state }),
  }
}

function water(origin: Cell, dx: number, dy: number, dz: number): MatrixBlockSpec {
  return spec(origin, dx, dy, dz, 'water')
}

function waterVolume(origin: Cell, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): MatrixBlockSpec[] {
  const result: MatrixBlockSpec[] = []
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      for (let z = z0; z <= z1; z += 1) result.push(water(origin, x, y, z))
    }
  }
  return result
}

const CLEAR = (origin: Cell): FieldGeometry['clear'] => ({ min: at(origin, -4, -8, -3), max: at(origin, 4, 10, 12) })

const LADDER = { facing: 'north', waterlogged: 'false' } as const
const VINE = { north: 'true', up: 'false' } as const
const SCAFFOLD = { bottom: 'true', distance: '0', waterlogged: 'false' } as const
const BOTTOM_SLAB = { type: 'bottom', waterlogged: 'false' } as const
const TOP_SLAB = { type: 'top', waterlogged: 'false' } as const
const STAIRS = { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' } as const

/**
 * Cell convention: `origin.y` is the corridor floor block, so the walking feet
 * cell is `origin.y + 1`.
 */
export function boundaryFields(origin: Cell): BoundaryField[] {
  const fields: BoundaryField[] = []

  // ---------------------------------------------------------------- water ---
  fields.push({
    id: 'water-wade-1',
    title: '1 深水池穿行',
    proves: 'wade profile: one block of water over a walkable floor is a passable edge',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 1, 'stone'),
      fill(origin, -2, 0, 5, 2, 0, 7, 'stone'),
      fill(origin, -2, -1, 2, 2, -1, 4, 'stone'),
      // Three-high side walls: a 1-high lip would be a dry route around the pool.
      fill(origin, -2, 0, 2, -2, 2, 4, 'stone'),
      fill(origin, 2, 0, 2, 2, 2, 4, 'stone'),
    ],
    blocks: waterVolume(origin, -1, 0, 2, 1, 0, 4),
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 1, 6),
    probes: [at(origin, 0, 0, 3), at(origin, 0, 1, 3), at(origin, -1, 0, 3), at(origin, 0, -1, 3), at(origin, 0, 1, 5), at(origin, 0, 1, 6)],
    expect: { guards: NO_PATH, climb: NO_PATH, wade: SUCCESS, swim: SUCCESS },
  })

  fields.push({
    id: 'water-deep-2',
    title: '2 深水池（swim 前）',
    proves: 'deep water stays closed under wade; the swim profile opens it (fallback pass)',
    origin,
    clear: CLEAR(origin),
    fills: [
      // Banks run down to the pool floor: a one-block-thick bank leaks and the
      // live water level drops, which invalidates the planned surface.
      fill(origin, -2, -2, -1, 2, 0, 1, 'stone'),
      fill(origin, -2, -2, 5, 2, 0, 7, 'stone'),
      fill(origin, -2, -2, 2, 2, -2, 4, 'stone'),
      fill(origin, -2, 0, 2, -2, 2, 4, 'stone'),
      fill(origin, 2, 0, 2, 2, 2, 4, 'stone'),
    ],
    blocks: waterVolume(origin, -1, -1, 2, 1, 0, 4),
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 1, 6),
    probes: [at(origin, 0, 0, 3), at(origin, 0, -1, 3), at(origin, 0, 1, 6)],
    expect: { guards: NO_PATH, climb: NO_PATH, wade: NO_PATH, swim: SUCCESS },
  })

  fields.push({
    id: 'water-fall-2',
    title: '2 格落水',
    proves: 'a planned fall may land in one block of water instead of a solid surface',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 1, -1, 2, 1, 1, 'stone'),
      // Solid under the platform: an air pocket there would let the pool flow
      // and push the body while it wades.
      fill(origin, -2, 0, -1, 2, 0, 1, 'stone'),
      fill(origin, -2, -1, 2, 2, -1, 5, 'stone'),
      fill(origin, -2, 0, 2, -2, 0, 5, 'stone'),
      fill(origin, 2, 0, 2, 2, 0, 5, 'stone'),
    ],
    blocks: waterVolume(origin, -1, 0, 2, 1, 0, 5),
    start: at(origin, 0, 2, 0),
    goal: at(origin, 0, 0, 3),
    probes: [at(origin, 0, 1, 1), at(origin, 0, 0, 2), at(origin, 0, 1, 2), at(origin, 0, 0, 3), at(origin, 0, 1, 3), at(origin, 0, -1, 3)],
    expect: { guards: NO_PATH, climb: NO_PATH, wade: SUCCESS, swim: SUCCESS },
  })

  fields.push({
    id: 'waterlogged-top-slab',
    title: 'waterlogged 上半砖',
    proves: 'a waterlogged solid top stays a dry floor, not a fluid cell',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: [spec(origin, 0, 0, 3, 'oak_slab', { ...TOP_SLAB, waterlogged: 'true' })],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 1, 6),
    probes: [at(origin, 0, 0, 3), at(origin, 0, 1, 3), at(origin, 0, 1, 6)],
    expect: same(SUCCESS),
  })

  fields.push({
    id: 'waterlogged-bottom-slab',
    title: '水 + waterlogged 下半砖',
    proves: 'wading across a waterlogged half-slab step (water + slab combination)',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 1, 'stone'),
      fill(origin, -2, 0, 5, 2, 0, 7, 'stone'),
      fill(origin, -2, -1, 2, 2, -1, 4, 'stone'),
      fill(origin, -2, 0, 2, -2, 2, 4, 'stone'),
      fill(origin, 2, 0, 2, 2, 2, 4, 'stone'),
    ],
    blocks: [
      ...waterVolume(origin, -1, 0, 2, 1, 0, 2),
      ...waterVolume(origin, -1, 0, 4, 1, 0, 4),
      water(origin, -1, 0, 3),
      water(origin, 1, 0, 3),
      spec(origin, 0, 0, 3, 'oak_slab', { ...BOTTOM_SLAB, waterlogged: 'true' }),
    ],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 1, 6),
    probes: [at(origin, 0, 0, 3), at(origin, 0, 1, 3), at(origin, 0, 0, 2)],
    expect: { guards: NO_PATH, climb: NO_PATH, wade: SUCCESS, swim: SUCCESS },
  })

  fields.push({
    id: 'water-ladder',
    title: '水 + 梯子',
    proves: 'a ladder inside a deep water column stays closed (reference supports it, we defer)',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 1, 'stone'),
      fill(origin, -2, -2, 2, 2, -2, 4, 'stone'),
      fill(origin, -2, -2, 5, 2, 1, 5, 'stone'),
      // Side walls must span the whole water column, otherwise the pool leaks.
      fill(origin, -2, -1, 2, -2, 2, 4, 'stone'),
      fill(origin, 2, -1, 2, 2, 2, 4, 'stone'),
    ],
    blocks: [
      ...waterVolume(origin, -1, -1, 2, 1, 0, 4),
      spec(origin, 0, -1, 4, 'ladder', LADDER),
      spec(origin, 0, 0, 4, 'ladder', LADDER),
    ],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 2, 5),
    probes: [at(origin, 0, 0, 4), at(origin, 0, 1, 5), at(origin, 0, 2, 5)],
    expect: same(NO_PATH),
  })

  fields.push({
    id: 'water-ladder-exit',
    title: '水 + 梯子出岸',
    proves: 'swim can enter a ladder from the water surface and climb out onto the bank when the ladder reaches the top',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 1, 'stone'),
      fill(origin, -2, -2, 2, 2, -2, 4, 'stone'),
      // A two-wide bank gives the climb-exit jump room to settle without
      // overshooting into the void after the order succeeds.
      fill(origin, -2, -2, 5, 2, 1, 6, 'stone'),
      fill(origin, -2, -1, 2, -2, 2, 4, 'stone'),
      fill(origin, 2, -1, 2, 2, 2, 4, 'stone'),
    ],
    blocks: [
      ...waterVolume(origin, -1, -1, 2, 1, 0, 4),
      spec(origin, 0, -1, 4, 'ladder', LADDER),
      spec(origin, 0, 0, 4, 'ladder', LADDER),
      spec(origin, 0, 1, 4, 'ladder', LADDER),
    ],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 2, 6),
    probes: [at(origin, 0, 0, 4), at(origin, 0, 1, 4), at(origin, 0, 1, 5), at(origin, 0, 2, 5), at(origin, 0, 2, 6)],
    expect: { guards: NO_PATH, climb: NO_PATH, wade: NO_PATH, swim: SUCCESS },
  })

  fields.push({
    id: 'water-ladder-shallow',
    title: '浅水 + 梯子',
    proves: 'a one-deep pool with a ladder can be waded and climbed out',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 1, 'stone'),
      fill(origin, -2, -1, 2, 2, -1, 4, 'stone'),
      fill(origin, -2, -1, 5, 2, 1, 5, 'stone'),
      fill(origin, -2, 0, 2, -2, 2, 4, 'stone'),
      fill(origin, 2, 0, 2, 2, 2, 4, 'stone'),
    ],
    blocks: [
      ...waterVolume(origin, -1, 0, 2, 1, 0, 4),
      spec(origin, 0, 0, 4, 'ladder', LADDER),
      spec(origin, 0, 1, 4, 'ladder', LADDER),
    ],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 2, 5),
    probes: [at(origin, 0, 0, 3), at(origin, 0, 0, 4), at(origin, 0, 1, 4), at(origin, 0, 2, 5)],
    expect: { guards: NO_PATH, climb: NO_PATH, wade: SUCCESS, swim: SUCCESS },
  })

  fields.push({
    id: 'water-ladder-no-ladder',
    title: '深水 + 高岸（无梯子）',
    proves: 'without a ladder, a deep pool cannot climb a bank two blocks above the surface even under swim',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 1, 'stone'),
      fill(origin, -2, -2, 2, 2, -2, 4, 'stone'),
      fill(origin, -2, -2, 5, 2, 1, 5, 'stone'),
      fill(origin, -2, -1, 2, -2, 2, 4, 'stone'),
      fill(origin, 2, -1, 2, 2, 2, 4, 'stone'),
    ],
    blocks: waterVolume(origin, -1, -1, 2, 1, 0, 4),
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 2, 5),
    probes: [at(origin, 0, 0, 4), at(origin, 0, 1, 5), at(origin, 0, 2, 5)],
    expect: same(NO_PATH),
  })

  // --------------------------------------------------------------- ladder ---
  fields.push({
    id: 'ladder-up',
    title: '梯子上行',
    proves: 'ClimbMove: enter a ladder column from the side and climb to a same-level landing',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 3, 'stone'),
      fill(origin, 0, 1, 1, 0, 3, 1, 'stone'),
    ],
    blocks: [
      spec(origin, 0, 1, 0, 'ladder', LADDER),
      spec(origin, 0, 2, 0, 'ladder', LADDER),
      spec(origin, 0, 3, 0, 'ladder', LADDER),
      spec(origin, 0, 4, 0, 'ladder', LADDER),
    ],
    start: at(origin, 0, 1, -1),
    goal: at(origin, 0, 4, 1),
    probes: [at(origin, 0, 1, 0), at(origin, 0, 3, 0), at(origin, 0, 4, 0), at(origin, 0, 4, 1)],
    expect: { guards: NO_PATH, climb: SUCCESS, wade: SUCCESS, swim: SUCCESS },
  })

  fields.push({
    id: 'ladder-down',
    title: '梯子下行',
    proves: 'ClimbMove descends a ladder column and steps back onto the ground',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 3, 'stone'),
      fill(origin, 0, 1, 1, 0, 3, 1, 'stone'),
      // Top platform on the open (north) side of the ladder column: entering a
      // ladder from the plate side is blocked by the ladder's own collision.
      fill(origin, 0, 3, -1, 0, 3, -1, 'stone'),
    ],
    blocks: [
      spec(origin, 0, 1, 0, 'ladder', LADDER),
      spec(origin, 0, 2, 0, 'ladder', LADDER),
      spec(origin, 0, 3, 0, 'ladder', LADDER),
      spec(origin, 0, 4, 0, 'ladder', LADDER),
    ],
    start: at(origin, 0, 4, -1),
    goal: at(origin, 0, 1, 0),
    probes: [at(origin, 0, 3, -1), at(origin, 0, 4, 0), at(origin, 0, 2, 0), at(origin, 0, 1, 0)],
    expect: { guards: NO_PATH, climb: SUCCESS, wade: SUCCESS, swim: SUCCESS },
  })

  fields.push({
    id: 'ladder-beside',
    title: '梯子旁普通移动',
    proves: 'a ladder beside the corridor never becomes a path node',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 5, 'stone'),
      fill(origin, 1, 1, 1, 2, 3, 1, 'stone'),
    ],
    blocks: [
      spec(origin, 1, 1, 0, 'ladder', LADDER),
      spec(origin, 1, 2, 0, 'ladder', LADDER),
      spec(origin, 1, 3, 0, 'ladder', LADDER),
    ],
    start: at(origin, 0, 1, -1),
    goal: at(origin, 0, 1, 4),
    probes: [at(origin, 1, 1, 0), at(origin, 0, 1, 4)],
    expect: same(SUCCESS),
  })

  fields.push({
    id: 'ladder-top-step-up',
    title: '梯顶再上一格',
    proves: 'ClimbExitMove: jump off a ladder top diagonally onto a ledge one block higher',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 3, 'stone'),
      fill(origin, 0, 1, 1, 0, 4, 1, 'stone'),
    ],
    blocks: [
      spec(origin, 0, 1, 0, 'ladder', LADDER),
      spec(origin, 0, 2, 0, 'ladder', LADDER),
      spec(origin, 0, 3, 0, 'ladder', LADDER),
      spec(origin, 0, 4, 0, 'ladder', LADDER),
    ],
    start: at(origin, 0, 1, -1),
    goal: at(origin, 0, 5, 1),
    probes: [at(origin, 0, 4, 0), at(origin, 0, 4, 1), at(origin, 0, 5, 1)],
    expect: { guards: NO_PATH, climb: SUCCESS, wade: SUCCESS, swim: SUCCESS },
  })

  fields.push({
    id: 'vine-up',
    title: '藤蔓上行',
    proves: 'vines are climbable by tag and passable, so a vine column behaves like a ladder',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 3, 'stone'),
      fill(origin, 0, 1, 1, 0, 4, 1, 'stone'),
    ],
    blocks: [
      spec(origin, 0, 1, 0, 'vine', VINE),
      spec(origin, 0, 2, 0, 'vine', VINE),
      spec(origin, 0, 3, 0, 'vine', VINE),
      spec(origin, 0, 4, 0, 'vine', VINE),
    ],
    start: at(origin, 0, 1, -1),
    goal: at(origin, 0, 5, 1),
    probes: [at(origin, 0, 4, 0), at(origin, 0, 4, 1), at(origin, 0, 5, 1)],
    expect: { guards: NO_PATH, climb: SUCCESS, wade: SUCCESS, swim: SUCCESS },
  })

  fields.push({
    id: 'ladder-second-floor',
    title: '梯子穿洞进二层',
    proves: 'the standard two-floor layout (ladder through a ceiling hole) is reachable',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 3, 'stone'),
      // Ceiling with a hole at the ladder column, so the second floor top is one
      // block above the ladder top.
      fill(origin, -2, 3, -1, 2, 3, 3, 'stone'),
      fill(origin, 0, 3, 0, 0, 3, 0, 'air'),
      fill(origin, 0, 1, 1, 0, 2, 1, 'stone'),
    ],
    blocks: [
      spec(origin, 0, 1, 0, 'ladder', LADDER),
      spec(origin, 0, 2, 0, 'ladder', LADDER),
      spec(origin, 0, 3, 0, 'ladder', LADDER),
    ],
    start: at(origin, 0, 1, -1),
    goal: at(origin, 1, 4, 0),
    probes: [at(origin, 0, 3, 0), at(origin, 1, 3, 0), at(origin, 1, 4, 0)],
    expect: { guards: NO_PATH, climb: SUCCESS, wade: SUCCESS, swim: SUCCESS },
  })

  // ------------------------------------------------------------ scaffolding ---
  fields.push({
    id: 'scaffold-stand',
    title: '脚手架站立',
    proves: 'a scaffolding top is a walkable support one step up',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: [spec(origin, 0, 1, 3, 'scaffolding', { ...SCAFFOLD })],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 2, 3),
    probes: [at(origin, 0, 1, 3), at(origin, 0, 2, 3), at(origin, 0, 3, 3)],
    expect: same(SUCCESS),
  })

  fields.push({
    id: 'scaffold-step-over',
    title: '脚手架跨过',
    proves: 'one scaffolding block is a step up and down; the corridor continues beyond it',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: [spec(origin, 0, 1, 3, 'scaffolding', { ...SCAFFOLD })],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 1, 6),
    probes: [at(origin, 0, 1, 3), at(origin, 0, 2, 3), at(origin, 0, 1, 6)],
    expect: same(SUCCESS),
  })

  fields.push({
    id: 'scaffold-top-down',
    title: '脚手架上下来',
    proves: 'standing on a scaffold top can step back down to the floor',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: [spec(origin, 0, 1, 3, 'scaffolding', { ...SCAFFOLD })],
    start: at(origin, 0, 2, 3),
    goal: at(origin, 0, 1, 0),
    probes: [at(origin, 0, 1, 3), at(origin, 0, 2, 3), at(origin, 0, 1, 0)],
    expect: same(SUCCESS),
  })

  fields.push({
    id: 'scaffold-beside',
    title: '脚手架旁通过',
    proves: 'scaffolding beside the corridor does not become a path obstacle',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: [spec(origin, 1, 1, 3, 'scaffolding', { ...SCAFFOLD })],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 1, 6),
    probes: [at(origin, 1, 1, 3), at(origin, 0, 1, 3), at(origin, 0, 1, 6)],
    expect: same(SUCCESS),
  })

  fields.push({
    id: 'scaffold-through',
    title: '脚手架穿越',
    proves: 'inside/side pass-through stays deferred: a two-high scaffolding wall blocks the corridor in P2Motion',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: (() => {
      const result: MatrixBlockSpec[] = []
      for (let x = -2; x <= 2; x += 1) {
        for (let y = 1; y <= 2; y += 1) result.push(spec(origin, x, y, 3, 'scaffolding', { ...SCAFFOLD }))
      }
      return result
    })(),
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 1, 6),
    probes: [at(origin, 0, 1, 3), at(origin, 0, 2, 3), at(origin, 0, 1, 6)],
    expect: same(NO_PATH),
  })

  fields.push({
    id: 'scaffold-place',
    title: '脚手架放置',
    proves: 'one scaffolding block placed from a solid support through the generic place path',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: [],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 2, 0),
    probes: [at(origin, 0, 1, 0), at(origin, 0, 2, 0)],
    placementProbes: [at(origin, 0, 1, 0)],
    authorization: { allowPlace: true, material: 'scaffolding' },
    expect: same(SUCCESS),
  })

  fields.push({
    id: 'scaffold-stack',
    title: '脚手架叠放',
    proves: 'stacking scaffolding on scaffolding does not confirm (frame collision is a poor click reference)',
    verifiedBy: 'executor',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: [],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 3, 0),
    probes: [at(origin, 0, 1, 0), at(origin, 0, 2, 0), at(origin, 0, 3, 0)],
    placementProbes: [at(origin, 0, 1, 0), at(origin, 0, 2, 0)],
    authorization: { allowPlace: true, material: 'scaffolding' },
    expect: same({ state: 'blocked', code: '*' }),
  })

  // --------------------------------------------------------- slab and stair ---
  fields.push({
    id: 'slab-bottom-step',
    title: '下半砖台阶',
    proves: 'a bottom slab is a half step: feet +0.5, still a normal ascend',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: [spec(origin, 0, 1, 3, 'oak_slab', { ...BOTTOM_SLAB })],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 2, 3),
    probes: [at(origin, 0, 1, 3), at(origin, 0, 2, 3)],
    expect: same(SUCCESS),
  })

  fields.push({
    id: 'slab-top-step',
    title: '上半砖台阶',
    proves: 'a top slab is a full step: feet +1',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: [spec(origin, 0, 1, 3, 'oak_slab', { ...TOP_SLAB })],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 2, 3),
    probes: [at(origin, 0, 1, 3), at(origin, 0, 2, 3)],
    expect: same(SUCCESS),
  })

  fields.push({
    id: 'stair-up',
    title: '楼梯上行',
    proves: 'footprint support: a stair top is walkable (single centre sample used to fail)',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: [spec(origin, 0, 1, 3, 'stone_stairs', { ...STAIRS })],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 2, 3),
    probes: [at(origin, 0, 1, 3), at(origin, 0, 2, 3)],
    // Pre-fix analysis: the stair cell was not standable, so no edge reached it.
    baseline: NO_PATH,
    expect: { guards: SUCCESS, climb: SUCCESS, wade: SUCCESS, swim: SUCCESS },
  })

  fields.push({
    id: 'stair-down',
    title: '楼梯下行',
    proves: 'descending from a stair top back to the floor',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: [spec(origin, 0, 1, 3, 'stone_stairs', { ...STAIRS })],
    start: at(origin, 0, 2, 3),
    goal: at(origin, 0, 1, 0),
    probes: [at(origin, 0, 1, 3), at(origin, 0, 2, 3), at(origin, 0, 1, 0)],
    expect: { guards: SUCCESS, climb: SUCCESS, wade: SUCCESS, swim: SUCCESS },
  })

  fields.push({
    id: 'slab-ascend-impossible',
    title: '从下半砖跳整方块（不可能）',
    proves: 'a bottom-slab source makes a nominal +1 step a 1.5 jump: refuse to plan it',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 5, 'stone')],
    blocks: [
      spec(origin, 0, 1, 3, 'oak_slab', { ...BOTTOM_SLAB }),
      spec(origin, 1, 2, 3, 'stone'),
    ],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 1, 3, 3),
    probes: [at(origin, 0, 1, 3), at(origin, 0, 2, 3), at(origin, 1, 2, 3), at(origin, 1, 3, 3)],
    // Pre-fix analysis: planned, then the 1.5 jump failed -> GOTO_STUCK.
    baseline: { state: 'blocked', code: 'GOTO_STUCK' },
    expect: { guards: NO_PATH, climb: NO_PATH, wade: NO_PATH, swim: NO_PATH },
  })

  fields.push({
    id: 'slab-ascend-bottom-to-bottom',
    title: '下半砖跳下半砖',
    proves: 'slab to slab is a real 1.0 jump and stays allowed',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 5, 'stone')],
    blocks: [
      spec(origin, 0, 1, 3, 'oak_slab', { ...BOTTOM_SLAB }),
      spec(origin, 1, 1, 3, 'stone'),
      spec(origin, 1, 2, 3, 'oak_slab', { ...BOTTOM_SLAB }),
    ],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 1, 3, 3),
    probes: [at(origin, 0, 1, 3), at(origin, 1, 2, 3), at(origin, 1, 3, 3)],
    expect: same(SUCCESS),
  })

  fields.push({
    id: 'slab-pillar',
    title: '从下半砖垫脚',
    proves: 'pillar from a bottom slab cannot clear its placement height: refuse to plan it',
    origin,
    clear: CLEAR(origin),
    // A one-wide shaft: without walls the bridge/pillar edges fan out over the
    // void and the refusal surfaces as a search timeout instead of no path.
    fills: [
      fill(origin, 0, 0, 0, 0, 0, 0, 'stone'),
      fill(origin, -1, 1, 0, -1, 2, 0, 'stone'),
      fill(origin, 1, 1, 0, 1, 2, 0, 'stone'),
      fill(origin, 0, 1, -1, 0, 2, -1, 'stone'),
      fill(origin, 0, 1, 1, 0, 2, 1, 'stone'),
    ],
    blocks: [spec(origin, 0, 1, 0, 'oak_slab', { ...BOTTOM_SLAB })],
    start: at(origin, 0, 2, 0),
    goal: at(origin, 0, 4, 0),
    probes: [at(origin, 0, 1, 0), at(origin, 0, 2, 0), at(origin, 0, 3, 0), at(origin, 0, 4, 0)],
    placementProbes: [at(origin, 0, 2, 0)],
    authorization: { allowPlace: true, material: 'dirt' },
    // Pre-fix analysis: planned, then the placement height was never reached.
    baseline: { state: 'blocked', code: 'GOTO_STUCK' },
    expect: { guards: NO_PATH, climb: NO_PATH, wade: NO_PATH, swim: NO_PATH },
  })

  fields.push({
    id: 'slab-fall-onto',
    title: '落入下半砖',
    proves: 'falling onto a half-height support is refused by default (reference behaviour)',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, 0, 3, -1, 0, 3, 1, 'stone')],
    blocks: [spec(origin, 0, 1, 2, 'oak_slab', { ...BOTTOM_SLAB })],
    start: at(origin, 0, 4, 0),
    goal: at(origin, 0, 2, 2),
    probes: [at(origin, 0, 3, 1), at(origin, 0, 1, 2), at(origin, 0, 2, 2)],
    // Pre-fix analysis: a half-height landing was allowed, the drop landed at 0.5.
    baseline: { state: 'succeeded' },
    expect: { guards: NO_PATH, climb: NO_PATH, wade: NO_PATH, swim: NO_PATH },
  })

  fields.push({
    id: 'slab-parkour-from',
    title: '从下半砖起跳',
    proves: 'sprint-jumping out of a half step is refused by default',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, 0, 0, 0, 0, 0, 0, 'stone'),
      fill(origin, 0, 1, 2, 0, 1, 5, 'stone'),
    ],
    blocks: [spec(origin, 0, 1, 0, 'oak_slab', { ...BOTTOM_SLAB })],
    start: at(origin, 0, 2, 0),
    goal: at(origin, 0, 2, 4),
    probes: [at(origin, 0, 1, 0), at(origin, 0, 1, 1), at(origin, 0, 2, 2), at(origin, 0, 2, 4)],
    authorization: { allowParkour: true },
    expect: { guards: NO_PATH, climb: NO_PATH, wade: NO_PATH, swim: NO_PATH },
  })

  // ------------------------------------------- partial-support physics ---
  fields.push({
    id: 'farmland-step',
    title: '从 farmland 上台（真实 1.0625）',
    proves: 'a 1.0625 rise (farmland -> full block) is inside the jump budget; the old 1.05 threshold rejected it',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: [
      spec(origin, 0, 1, 3, 'farmland'),
      // Adjacent full block at y=102: the goal cell is 103, so the rise from
      // the farmland cell (feet 101.9375) is exactly 1.0625.
      spec(origin, 1, 2, 3, 'stone'),
    ],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 1, 3, 3),
    probes: [at(origin, 0, 1, 3), at(origin, 0, 2, 3), at(origin, 1, 2, 3), at(origin, 1, 3, 3)],
    expect: same(SUCCESS),
  })

  fields.push({
    id: 'farmland-pillar',
    title: '从 farmland 垫脚',
    proves: 'the jump peak from farmland (0.9375) clears the placement clearance, so pillar is possible',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: [spec(origin, 0, 1, 0, 'farmland')],
    start: at(origin, 0, 2, 0),
    goal: at(origin, 0, 4, 0),
    probes: [at(origin, 0, 1, 0), at(origin, 0, 2, 0), at(origin, 0, 3, 0), at(origin, 0, 4, 0)],
    placementProbes: [at(origin, 0, 2, 0), at(origin, 0, 3, 0)],
    authorization: { allowPlace: true, material: 'dirt' },
    expect: same(SUCCESS),
  })

  fields.push({
    id: 'stair-pillar',
    title: '站在楼梯上垫脚',
    proves: 'standing on a stair top (feetY = cell.y) and placing through the pillar path works',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -2, 0, -1, 2, 0, 7, 'stone')],
    blocks: [spec(origin, 0, 1, 3, 'stone_stairs', { ...STAIRS })],
    start: at(origin, 0, 2, 3),
    goal: at(origin, 0, 4, 3),
    probes: [at(origin, 0, 1, 3), at(origin, 0, 2, 3), at(origin, 0, 3, 3), at(origin, 0, 4, 3)],
    placementProbes: [at(origin, 0, 2, 3), at(origin, 0, 3, 3)],
    authorization: { allowPlace: true, material: 'dirt' },
    expect: same(SUCCESS),
  })
  // ---------------------------------------------------------------- lava ---
  fields.push({
    id: 'lava-beside-slab',
    title: '岩浆旁半砖',
    proves: 'lava adjacency does not block standing on a neighbouring bottom slab',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 5, 'stone'),
      fill(origin, 1, -1, 3, 1, -1, 3, 'stone'),
    ],
    blocks: [
      spec(origin, 1, 0, 3, 'lava'),
      spec(origin, 0, 1, 3, 'oak_slab', { ...BOTTOM_SLAB }),
    ],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 2, 3),
    probes: [at(origin, 1, 0, 3), at(origin, 0, 1, 3), at(origin, 0, 2, 3)],
    expect: same(SUCCESS),
  })

  fields.push({
    id: 'lava-step-into',
    title: '踏入岩浆',
    proves: 'a lava cell is never a standable target',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 5, 'stone'),
      fill(origin, 1, -1, 3, 1, -1, 3, 'stone'),
    ],
    blocks: [spec(origin, 1, 0, 3, 'lava')],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 1, 1, 3),
    probes: [at(origin, 1, 0, 3), at(origin, 1, 1, 3)],
    expect: same(NO_PATH),
  })

  // ----------------------------------------------------------------- swim ---
  fields.push({
    id: 'swim-lake-5wide',
    title: '5 格宽湖面横渡',
    proves: 'the swim profile crosses a wide surface without diving or drowning',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -2, -2, -1, 2, 0, 1, 'stone'),
      fill(origin, -2, -2, 7, 2, 0, 9, 'stone'),
      fill(origin, -2, -2, 2, 2, -2, 6, 'stone'),
      fill(origin, -2, 0, 2, -2, 2, 6, 'stone'),
      fill(origin, 2, 0, 2, 2, 2, 6, 'stone'),
    ],
    blocks: waterVolume(origin, -1, -1, 2, 1, 0, 6),
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 1, 8),
    probes: [at(origin, 0, 0, 2), at(origin, 0, 0, 4), at(origin, 0, 0, 6), at(origin, 0, 1, 4), at(origin, 0, 0, 7), at(origin, 0, 1, 8)],
    expect: { guards: NO_PATH, climb: NO_PATH, wade: NO_PATH, swim: SUCCESS },
  })

  fields.push({
    id: 'swim-fall-2deep',
    title: '落入 2 深水再上岸',
    proves: 'a planned fall lands in deep water and the swim exit climbs onto a bank',
    origin,
    clear: CLEAR(origin),
    fills: [
      // A one-wide walkway two blocks above the pool, sealed on three sides so a
      // partial plan cannot walk off into the void.
      fill(origin, -1, 1, -1, 1, 1, 0, 'stone'),
      fill(origin, -1, 1, -2, 1, 2, -2, 'stone'),
      fill(origin, -1, 1, -1, -1, 2, 0, 'stone'),
      fill(origin, 1, 1, -1, 1, 2, 0, 'stone'),
      fill(origin, -1, -2, 1, 1, -2, 3, 'stone'),
      // Pool: near face under the walkway edge, floor and side walls.
      fill(origin, -1, -1, 0, 1, 0, 0, 'stone'),
      fill(origin, -2, -1, 1, -2, 2, 3, 'stone'),
      fill(origin, 2, -1, 1, 2, 2, 3, 'stone'),
      // Far bank (top 101) with its back wall and sides.
      fill(origin, -1, 0, 4, 1, 0, 4, 'stone'),
      fill(origin, -1, 1, 5, 1, 2, 5, 'stone'),
      fill(origin, -2, 0, 4, -2, 2, 5, 'stone'),
      fill(origin, 2, 0, 4, 2, 2, 5, 'stone'),
    ],
    blocks: waterVolume(origin, -1, -1, 1, 1, 0, 3),
    start: at(origin, 0, 2, 0),
    goal: at(origin, 0, 1, 4),
    probes: [at(origin, 0, 1, 0), at(origin, 0, 0, 1), at(origin, 0, 1, 1), at(origin, 0, 0, 4), at(origin, 0, 1, 4)],
    expect: { guards: NO_PATH, climb: NO_PATH, wade: NO_PATH, swim: SUCCESS },
  })

  return fields
}

export function boundaryFieldIds(origin: Cell): string[] {
  return boundaryFields(origin).map(field => field.id)
}

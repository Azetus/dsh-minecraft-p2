import type { Cell } from '../model/types.ts'
import type { FieldGeometry, MatrixBlockSpec, MatrixFill } from './scenarios.ts'

/**
 * Risky-mode matrix: the unvalidated vanilla-style path (`go { risky: true }`).
 * Rows prove capability breadth, not safety: the contract is "best effort",
 * so success must come from the geometry, and `no-path` rows must leave the
 * body where it started.
 */
export type RiskyField = FieldGeometry & {
  id: string
  title: string
  proves: string
  origin: Cell
  start: Cell
  goal: Cell
  /** `safe-alternative` runs the safe planner and expects the `observed.alternative`. */
  mode: 'risky' | 'safe-alternative'
  expect: 'succeeded' | 'no-path'
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

function waterVolume(origin: Cell, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): MatrixBlockSpec[] {
  const result: MatrixBlockSpec[] = []
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      for (let z = z0; z <= z1; z += 1) result.push(spec(origin, x, y, z, 'water'))
    }
  }
  return result
}

const CLEAR = (origin: Cell): FieldGeometry['clear'] => ({ min: at(origin, -3, -6, -3), max: at(origin, 5, 8, 5) })

/** Two banks at feet level with a two-deep river between them. */
function river(origin: Cell): FieldGeometry {
  return {
    clear: CLEAR(origin),
    fills: [
      // Only the river/bank line has a floor: a wider floor would be a dry route
      // around the water and prove nothing.
      fill(origin, -3, -2, 0, 0, 0, 0, 'stone'),
      fill(origin, 3, -2, 0, 5, 0, 0, 'stone'),
      fill(origin, 1, -2, 0, 2, -2, 0, 'stone'),
    ],
    blocks: waterVolume(origin, 1, -1, 0, 2, 0, 0),
  }
}

/**
 * Cell convention: `origin.y` is the walking floor block, so the feet cell is
 * `origin.y + 1` (except for the drop rows, where the platform is explicit).
 */
export function riskyFields(origin: Cell): RiskyField[] {
  const fields: RiskyField[] = []

  // ---------------------------------------------------------------- water ---
  fields.push({
    id: 'risky-river-2deep',
    title: '2 深河（水面横渡）',
    proves: 'the vanilla path may cross two-deep water along the surface (no diving, no drowning)',
    origin,
    ...river(origin),
    start: at(origin, 0, 1, 0),
    goal: at(origin, 4, 1, 0),
    mode: 'risky',
    expect: 'succeeded',
  })

  fields.push({
    id: 'risky-water-ladder',
    title: '水 + 梯子出岸（risky）',
    proves: 'the vanilla node graph can enter a ladder from the water surface and step onto the bank',
    origin,
    clear: { min: at(origin, -3, -6, -3), max: at(origin, 5, 8, 7) },
    fills: [
      fill(origin, -2, 0, -1, 2, 0, 1, 'stone'),
      fill(origin, -2, -2, 2, 2, -2, 4, 'stone'),
      fill(origin, -2, -2, 5, 2, 1, 6, 'stone'),
      fill(origin, -2, -1, 2, -2, 2, 4, 'stone'),
      fill(origin, 2, -1, 2, 2, 2, 4, 'stone'),
    ],
    blocks: [
      ...waterVolume(origin, -1, -1, 2, 1, 0, 4),
      spec(origin, 0, -1, 4, 'ladder', { facing: 'north', waterlogged: 'false' }),
      spec(origin, 0, 0, 4, 'ladder', { facing: 'north', waterlogged: 'false' }),
      spec(origin, 0, 1, 4, 'ladder', { facing: 'north', waterlogged: 'false' }),
    ],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 0, 2, 6),
    mode: 'risky',
    expect: 'succeeded',
  })

  fields.push({
    id: 'risky-safe-alternative',
    title: '安全拒绝时给出未校验备选',
    proves: 'a safe GOTO_NO_PATH (half-height landing) carries observed.alternative (available=true) and does not move the body',
    origin,
    // The same ledge/slab geometry as the boundary `slab-fall-onto` row: safe
    // refuses a half-height landing, while the vanilla node graph accepts it.
    clear: CLEAR(origin),
    fills: [fill(origin, 0, 3, -1, 0, 3, 1, 'stone')],
    blocks: [spec(origin, 0, 1, 2, 'oak_slab', { type: 'bottom', waterlogged: 'false' })],
    // Start on the platform edge: the only safe move would be the refused
    // half-height landing, so a GOTO_NO_PATH leaves the body exactly there.
    start: at(origin, 0, 4, 1),
    goal: at(origin, 0, 2, 2),
    mode: 'safe-alternative',
    expect: 'no-path',
  })

  // ----------------------------------------------------------------- falls ---
  fields.push({
    id: 'risky-fall-3',
    title: '3 格落差',
    proves: 'the vanilla fall budget (3) is enough to step off a three-block ledge',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -3, 0, -2, 5, 0, 2, 'stone'),
      fill(origin, -3, 3, -2, 0, 3, 2, 'stone'),
      fill(origin, -3, 1, -2, -3, 3, 2, 'stone'),
      fill(origin, -3, 1, -2, 0, 3, -2, 'stone'),
      fill(origin, -3, 1, 2, 0, 3, 2, 'stone'),
    ],
    blocks: [],
    start: at(origin, 0, 4, 0),
    goal: at(origin, 3, 1, 0),
    mode: 'risky',
    expect: 'succeeded',
  })

  fields.push({
    id: 'risky-fall-4',
    title: '4 格落差被拒绝',
    proves: 'a four-block drop is outside the vanilla fall budget and yields no path',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -3, 0, -2, 5, 0, 2, 'stone'),
      fill(origin, -3, 4, -2, 0, 4, 2, 'stone'),
      fill(origin, -3, 1, -2, -3, 4, 2, 'stone'),
      fill(origin, -3, 1, -2, 0, 4, -2, 'stone'),
      fill(origin, -3, 1, 2, 0, 4, 2, 'stone'),
    ],
    blocks: [],
    start: at(origin, 0, 5, 0),
    goal: at(origin, 3, 1, 0),
    mode: 'risky',
    expect: 'no-path',
  })

  // ------------------------------------------------------------------ lava ---
  fields.push({
    id: 'risky-lava-shore',
    title: '沿岩浆岸通过',
    proves: 'lava is excluded by the hazard tag, so a path along its shore still succeeds',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -3, 0, -3, 5, 0, 5, 'stone'),
      fill(origin, 1, 0, 1, 3, 0, 2, 'lava'),
      fill(origin, 1, 1, 1, 3, 2, 2, 'stone'),
      fill(origin, 1, 1, 0, 3, 2, 0, 'stone'),
    ],
    blocks: [],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 4, 1, -1),
    mode: 'risky',
    expect: 'succeeded',
  })

  fields.push({
    id: 'risky-lava-goal',
    title: '目标是岩浆',
    proves: 'a lava cell is not a node, so the target is refused even in risky mode',
    origin,
    clear: CLEAR(origin),
    fills: [fill(origin, -3, 0, -3, 5, 0, 5, 'stone')],
    blocks: [spec(origin, 3, 1, 0, 'lava')],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 3, 1, 0),
    mode: 'risky',
    expect: 'no-path',
  })

  // ---------------------------------------------------------------- ladder ---
  fields.push({
    id: 'risky-ladder',
    title: '爬梯上平台',
    proves: 'ladder cells are nodes and get vertical neighbours, so a three-high ladder is climbable',
    origin,
    clear: CLEAR(origin),
    fills: [
      fill(origin, -3, 0, -2, 5, 0, 2, 'stone'),
      fill(origin, 2, 1, 0, 2, 3, 0, 'stone'),
      fill(origin, 1, 1, 0, 1, 3, 0, 'air'),
    ],
    blocks: [
      spec(origin, 1, 1, 0, 'ladder', { facing: 'north', waterlogged: 'false' }),
      spec(origin, 1, 2, 0, 'ladder', { facing: 'north', waterlogged: 'false' }),
      spec(origin, 1, 3, 0, 'ladder', { facing: 'north', waterlogged: 'false' }),
    ],
    start: at(origin, 0, 1, 0),
    goal: at(origin, 2, 4, 0),
    mode: 'risky',
    expect: 'succeeded',
  })

  fields.push({
    id: 'risky-river-exec',
    title: '2 深河（risky 实际执行）',
    proves: 'the same river is actually crossed with risky:true end to end',
    origin,
    ...river(origin),
    start: at(origin, 0, 1, 0),
    goal: at(origin, 4, 1, 0),
    mode: 'risky',
    expect: 'succeeded',
  })

  return fields
}

export const riskyFieldIds = riskyFields({ x: 0, y: 0, z: 0 }).map(field => field.id)

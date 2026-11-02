import type { Cell } from '../model/types.ts'

/**
 * The movement acceptance matrix. Each field is built from LAN commands on the
 * live server; the same description is used by pure tests to build a fixture
 * world. Expectations are per phase because the move set grows in P1/P3.
 */
export type MatrixFieldId =
  | 'flat'
  | 'step-up'
  | 'gap-1'
  | 'door'
  | 'drop-2'
  | 'bridge'
  | 'pillar'
  | 'diagonal'
export type MatrixPhase = 'p1' | 'p2' | 'p3'
export type MatrixExpectation = 'success' | 'unreachable' | 'blocked'

export type MatrixFill = { min: Cell; max: Cell; block: string }

export type MatrixBlockSpec = {
  at: Cell
  name: string
  state?: Readonly<Record<string, string>>
}

export type MatrixField = {
  id: MatrixFieldId
  title: string
  origin: Cell
  clear: { min: Cell; max: Cell }
  fills: readonly MatrixFill[]
  blocks: readonly MatrixBlockSpec[]
  /** Feet cell where the body is teleported before the run. */
  start: Cell
  /** Feet cell the move must reach. */
  goal: Cell
  /** Blocks to read back after the run for evidence. */
  probes: readonly Cell[]
  /** Cells a placing move is expected to fill (bridge/pillar readback). */
  placementProbes?: readonly Cell[]
  /** Explicit authorization this field needs; absent means default constraints. */
  authorization?: {
    allowParkour?: boolean
    allowDiagonal?: boolean
    allowPlace?: boolean
    material?: string
  }
  expect: Readonly<Record<MatrixPhase, MatrixExpectation>>
}

const EXPECT_ALL: Readonly<Record<MatrixPhase, MatrixExpectation>> = {
  p1: 'success',
  p2: 'success',
  p3: 'success',
}

function at(origin: Cell, dx: number, dy: number, dz: number): Cell {
  return { x: origin.x + dx, y: origin.y + dy, z: origin.z + dz }
}

function doorHalf(
  field: MatrixField,
  dx: number,
  dy: number,
  dz: number,
  half: 'lower' | 'upper',
): MatrixBlockSpec {
  return {
    at: at(field.origin, dx, dy, dz),
    name: 'oak_door',
    state: { half, facing: 'north', hinge: 'left', open: 'false', powered: 'false' },
  }
}

function baseFloor(origin: Cell, zMin: number, zMax: number): {
  clear: { min: Cell; max: Cell }
  fills: MatrixFill[]
} {
  return {
    // One block of margin around the walkable strip; the body needs headroom.
    // Clearing below y=0 removes leftovers from the previous matrix field.
    clear: { min: at(origin, -2, -3, zMin), max: at(origin, 2, 4, zMax) },
    fills: [
      { min: at(origin, -2, 0, zMin), max: at(origin, 2, 0, zMax), block: 'stone' },
    ],
  }
}

export function matrixFields(origin: Cell): MatrixField[] {
  const flat: MatrixField = (() => {
    const base = baseFloor(origin, -1, 7)
    return {
      id: 'flat',
      title: '平地',
      origin,
      clear: base.clear,
      fills: base.fills,
      blocks: [],
      start: at(origin, 0, 1, 0),
      goal: at(origin, 0, 1, 6),
      probes: [at(origin, 0, 0, 0), at(origin, 0, 1, 0), at(origin, 0, 0, 6), at(origin, 0, 1, 6)],
      expect: EXPECT_ALL,
    }
  })()

  const stepUp: MatrixField = (() => {
    const base = baseFloor(origin, -1, 7)
    const field: MatrixField = {
      id: 'step-up',
      title: '+1 台阶',
      origin,
      clear: base.clear,
      fills: [
        ...base.fills,
        // Full-width step: the only route to the goal is a real ascend.
        { min: at(origin, -2, 1, 3), max: at(origin, 2, 1, 3), block: 'stone' },
      ],
      blocks: [],
      start: at(origin, 0, 1, 0),
      goal: at(origin, 0, 2, 3),
      probes: [at(origin, 0, 1, 3), at(origin, 0, 2, 3), at(origin, 0, 3, 3)],
      expect: EXPECT_ALL,
    }
    return field
  })()

  const gap: MatrixField = (() => {
    const base = baseFloor(origin, -1, 7)
    const field: MatrixField = {
      id: 'gap-1',
      title: '1 格缺口',
      origin,
      clear: base.clear,
      fills: [
        ...base.fills,
        // The pit spans the corridor so the only route is a jump, not a detour.
        { min: at(origin, -2, 0, 3), max: at(origin, 2, 0, 3), block: 'air' },
      ],
      blocks: [],
      start: at(origin, 0, 1, 0),
      goal: at(origin, 0, 1, 6),
      probes: [at(origin, 0, 0, 2), at(origin, 0, 0, 3), at(origin, 0, 0, 4), at(origin, 0, 1, 6)],
      // A one-cell gap needs the P3 parkour move; P1 must report it, not fake it.
      authorization: { allowParkour: true },
      expect: { p1: 'unreachable', p2: 'unreachable', p3: 'success' },
    }
    return field
  })()

  const door: MatrixField = (() => {
    const base = baseFloor(origin, -1, 7)
    // Wall strip at z=3; the door occupies y=1..2 and is replaced below.
    const wall: MatrixFill[] = [
      { min: at(origin, -2, 1, 3), max: at(origin, 2, 3, 3), block: 'stone' },
    ]
    const field: MatrixField = {
      id: 'door',
      title: '门',
      origin,
      clear: base.clear,
      fills: [...base.fills, ...wall],
      blocks: [],
      start: at(origin, 0, 1, 0),
      goal: at(origin, 0, 1, 6),
      probes: [
        at(origin, 0, 1, 3),
        at(origin, 0, 2, 3),
        at(origin, 0, 1, 2),
        at(origin, 0, 1, 4),
      ],
      expect: EXPECT_ALL,
    }
    return {
      ...field,
      blocks: [doorHalf(field, 0, 1, 3, 'lower'), doorHalf(field, 0, 2, 3, 'upper')],
    }
  })()

  const drop: MatrixField = (() => {
    const field: MatrixField = {
      id: 'drop-2',
      title: '2 格落差',
      origin,
      clear: { min: at(origin, -2, -3, -1), max: at(origin, 2, 4, 7) },
      fills: [
        { min: at(origin, -2, 0, -1), max: at(origin, 2, 0, 2), block: 'stone' },
        { min: at(origin, -2, -2, 3), max: at(origin, 2, -2, 7), block: 'stone' },
      ],
      blocks: [],
      start: at(origin, 0, 1, 0),
      goal: at(origin, 0, -1, 5),
      probes: [at(origin, 0, 0, 2), at(origin, 0, -2, 5), at(origin, 0, -1, 5)],
      expect: EXPECT_ALL,
    }
    return field
  })()

  const bridge: MatrixField = (() => {
    const field: MatrixField = {
      id: 'bridge',
      title: '2 格搭桥',
      origin,
      clear: { min: at(origin, -2, -3, -1), max: at(origin, 2, 4, 7) },
      fills: [
        { min: at(origin, -2, 0, -1), max: at(origin, 2, 0, 2), block: 'stone' },
        { min: at(origin, -2, 0, 5), max: at(origin, 2, 0, 7), block: 'stone' },
      ],
      blocks: [],
      start: at(origin, 0, 1, 0),
      goal: at(origin, 0, 1, 5),
      probes: [at(origin, 0, 1, 2), at(origin, 0, 0, 3), at(origin, 0, 0, 4), at(origin, 0, 1, 5)],
      placementProbes: [at(origin, 0, 0, 3), at(origin, 0, 0, 4)],
      authorization: { allowPlace: true, material: 'dirt' },
      expect: { p1: 'unreachable', p2: 'unreachable', p3: 'success' },
    }
    return field
  })()

  const pillar: MatrixField = (() => {
    const field: MatrixField = {
      id: 'pillar',
      title: '2 级垫脚',
      origin,
      clear: { min: at(origin, -2, -3, -1), max: at(origin, 2, 5, 2) },
      fills: [{ min: at(origin, -2, 0, -1), max: at(origin, 2, 0, 2), block: 'stone' }],
      blocks: [],
      start: at(origin, 0, 1, 0),
      goal: at(origin, 0, 3, 0),
      probes: [at(origin, 0, 1, 0), at(origin, 0, 2, 0), at(origin, 0, 3, 0)],
      placementProbes: [at(origin, 0, 1, 0), at(origin, 0, 2, 0)],
      authorization: { allowPlace: true, material: 'dirt' },
      expect: { p1: 'unreachable', p2: 'unreachable', p3: 'success' },
    }
    return field
  })()

  const diagonal: MatrixField = (() => {
    const field: MatrixField = {
      id: 'diagonal',
      title: '对角移动',
      origin,
      clear: { min: at(origin, -2, -3, -1), max: at(origin, 2, 4, 2) },
      fills: [{ min: at(origin, -2, 0, -1), max: at(origin, 2, 0, 2), block: 'stone' }],
      blocks: [],
      start: at(origin, 0, 1, 0),
      goal: at(origin, 1, 1, 1),
      probes: [at(origin, 0, 0, 0), at(origin, 1, 0, 1), at(origin, 1, 1, 1)],
      authorization: { allowDiagonal: true },
      expect: EXPECT_ALL,
    }
    return field
  })()

  return [flat, stepUp, gap, door, drop, bridge, pillar, diagonal]
}

export function blockString(spec: MatrixBlockSpec): string {
  if (spec.state === undefined) return spec.name
  const entries = Object.entries(spec.state)
  if (entries.length === 0) return spec.name
  return `${spec.name}[${entries.map(([key, value]) => `${key}=${value}`).join(',')}]`
}

export function fillCommand(min: Cell, max: Cell, block: string): string {
  return `/fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} ${block}`
}

/** Commands that (re)build this field; clear first, then floors, then blocks. */
export function matrixCommands(field: MatrixField): string[] {
  const commands = [fillCommand(field.clear.min, field.clear.max, 'air')]
  for (const fill of field.fills) commands.push(fillCommand(fill.min, fill.max, fill.block))
  for (const spec of field.blocks) {
    commands.push(`/setblock ${spec.at.x} ${spec.at.y} ${spec.at.z} ${blockString(spec)}`)
  }
  return commands
}

/** Final block map after clear + fills + blocks; used by pure fixtures. */
export function matrixBlockMap(field: MatrixField): Map<string, MatrixBlockSpec> {
  const map = new Map<string, MatrixBlockSpec>()
  for (let x = field.clear.min.x; x <= field.clear.max.x; x += 1) {
    for (let y = field.clear.min.y; y <= field.clear.max.y; y += 1) {
      for (let z = field.clear.min.z; z <= field.clear.max.z; z += 1) {
        map.set(`${x},${y},${z}`, { at: { x, y, z }, name: 'air' })
      }
    }
  }
  for (const fill of field.fills) {
    for (let x = fill.min.x; x <= fill.max.x; x += 1) {
      for (let y = fill.min.y; y <= fill.max.y; y += 1) {
        for (let z = fill.min.z; z <= fill.max.z; z += 1) {
          map.set(`${x},${y},${z}`, { at: { x, y, z }, name: fill.block })
        }
      }
    }
  }
  for (const spec of field.blocks) map.set(`${spec.at.x},${spec.at.y},${spec.at.z}`, spec)
  return map
}

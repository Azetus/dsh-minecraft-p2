import type { BlockInfo, ClientPort, Face } from '../../port/index.ts'
import type { JsonValue } from '../../contracts/types.ts'
import { isRecord } from '../../contracts/index.ts'
import { standingCell } from '../../motion/execute/index.ts'
import { createRules, defaultConstraints, PLAYER_HEIGHT } from '../../motion/model/index.ts'
import { standCells } from '../../motion/search/index.ts'
import { approachBlock } from '../approach.ts'
import { failureBody, readFailure, withFailure } from '../failure.ts'
import { matchesExpected } from '../plan.ts'
import type { ExpectedBlock } from '../plan.ts'
import type { SchemaNode } from '../schema.ts'
import { createReadOnlyMotionWorld } from '../standing.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle, actFailure } from './handle.ts'

export const PLACE_DRIVER_ID = 'place'

const FACES: Array<{ name: Face; dx: number; dy: number; dz: number }> = [
  { name: 'up', dx: 0, dy: -1, dz: 0 },
  { name: 'down', dx: 0, dy: 1, dz: 0 },
  { name: 'north', dx: 0, dy: 0, dz: 1 },
  { name: 'south', dx: 0, dy: 0, dz: -1 },
  { name: 'east', dx: -1, dy: 0, dz: 0 },
  { name: 'west', dx: 1, dy: 0, dz: 0 },
]

const PLACE_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    item: { type: 'string' },
    face: { type: 'string', enum: ['up', 'down', 'north', 'south', 'east', 'west'] },
    expectedState: { type: 'object' },
    yaw: { type: 'number' },
    cells: {
      type: 'array',
      items: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
        required: ['x', 'y', 'z'],
        additionalProperties: false,
      },
    },
    standX: { type: 'number' },
    standY: { type: 'number' },
    standZ: { type: 'number' },
    stands: {
      type: 'array',
      items: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
        required: ['x', 'y', 'z'],
        additionalProperties: false,
      },
    },
  },
  required: ['x', 'y', 'z', 'item'],
  additionalProperties: false,
}

type PlaceParams = {
  x: number
  y: number
  z: number
  item: string
  face?: Face
  expectedState?: Record<string, string>
  yaw?: number
  cells?: Array<{ x: number; y: number; z: number }>
  standX?: number
  standY?: number
  standZ?: number
  stands?: Array<{ x: number; y: number; z: number }>
}

type Cell = { x: number; y: number; z: number }

type Attempt = {
  stance: Cell
  move: string
  place?: string
  code?: string
  ok: boolean
}

/**
 * Place one expected block (or one two-cell group: door, bed). The placement
 * is issued once at the anchor cell; every cell the server produced is read
 * back, so a half group is never reported as success. Movement to a stance is
 * not progress: only the readback decides.
 */
export function createPlaceDriver(): Driver {
  return {
    id: PLACE_DRIVER_ID,
    schema: PLACE_SCHEMA,
    defaults: {
      budget: { maxTicks: 300, maxWallMs: 45_000 },
      interrupt: 'constant-only',
      suspendable: true,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as PlaceParams
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      if (typeof params.item !== 'string' || params.item.length === 0) return { ok: false, code: 'BAD_ARGS' }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as PlaceParams
      const key = `place:${params.x},${params.y},${params.z},${params.item}`
      return new AsyncDriverHandle(key, placeCell(ctx.port, params).then(result => attachPlaceFailure(result, params)))
    },
  }
}

async function placeCell(port: ClientPort, params: PlaceParams): Promise<DriverResult> {
  const target = { x: params.x, y: params.y, z: params.z }
  const expected: ExpectedBlock = {
    name: params.item,
    ...(params.expectedState === undefined ? {} : { state: params.expectedState }),
  }
  const cells: Cell[] = [target, ...(params.cells ?? [])]

  const before = port.blockAt(target)
  if (before === null || !before.loaded) {
    return { state: 'failed', code: 'OBSERVATION_UNAVAILABLE' }
  }
  if (cellsMatch(port, cells, expected)) return { state: 'succeeded' }

  const requestedStands = params.stands ?? (params.standX !== undefined && params.standY !== undefined
    && params.standZ !== undefined
    ? [{ x: params.standX, y: params.standY, z: params.standZ }]
    : [])
  // A stance whose own body occupies a target cell can never place it: the
  // server answers PLACE_BLOCKED_BY_SELF. Drop it before moving there.
  const explicit = requestedStands.filter(stand => !bodyCoversCells(
    { x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 },
    cells,
  ))
  if (requestedStands.length > 0 && explicit.length === 0) {
    return {
      state: 'failed',
      code: 'PLACE_BLOCKED_BY_SELF',
      observed: {
        blockedBy: 'self',
        target,
        skippedStands: requestedStands.length,
        adjacent: suggestedStances(port, cells),
      },
    }
  }

  if (explicit.length > 0) {
    const attempts: Attempt[] = []
    for (const stand of explicit) {
      const moved = await port.moveTo(stand, { range: 0.5, timeoutMs: 20_000 })
      if (moved.state !== 'ok') {
        attempts.push({ stance: stand, move: 'failed', code: moved.code ?? 'PLACE_APPROACH_FAILED', ok: false })
        continue
      }
      if (params.yaw !== undefined) {
        const looked = await lookYaw(port, params.yaw)
        if (looked !== undefined) {
          attempts.push({ stance: stand, move: 'ok', code: looked, ok: false })
          continue
        }
      }
      const placed = await placeFaces(port, cells, params, expected)
      attempts.push({
        stance: stand,
        move: 'ok',
        place: placed.state === 'succeeded' ? 'ok' : 'failed',
        ...(placed.code === undefined ? {} : { code: placed.code }),
        ok: placed.state === 'succeeded',
      })
      if (placed.state === 'succeeded') {
        return { state: 'succeeded', observed: { attempts: attempts as unknown as never } }
      }
    }
    const last = attempts[attempts.length - 1]
    const selfBlocked = attempts.some(attempt => attempt.code === 'PLACE_BLOCKED_BY_SELF')
    return {
      state: 'failed',
      code: last?.code ?? 'PLACE_FAILED',
      observed: {
        attempts: attempts as unknown as never,
        ...(selfBlocked ? { blockedBy: 'self', target, adjacent: suggestedStances(port, cells) } : {}),
      },
    }
  }

  const self = port.self().pos
  if (Math.hypot(self.x - target.x, self.y - target.y, self.z - target.z) > 4.5) {
    const approach = await approachBlock(port, target, {
      range: 3,
      timeoutMs: 20_000,
      code: 'PLACE_APPROACH_FAILED',
    })
    if (!approach.ok) {
      return {
        state: 'failed',
        code: approach.code,
        ...(approach.observed === undefined ? {} : { observed: approach.observed }),
      }
    }
  }
  if (bodyCoversCells(port.self().pos, cells)) {
    return {
      state: 'failed',
      code: 'PLACE_BLOCKED_BY_SELF',
      observed: {
        blockedBy: 'self',
        target,
        adjacent: suggestedStances(port, cells),
      },
    }
  }
  if (params.yaw !== undefined) {
    const looked = await lookYaw(port, params.yaw)
    if (looked !== undefined) return { state: 'failed', code: looked }
  }
  return placeFaces(port, cells, params, expected)
}

async function placeFaces(
  port: ClientPort,
  cells: Cell[],
  params: PlaceParams,
  expected: ExpectedBlock,
): Promise<DriverResult> {
  const target = cells[0]!
  const faces = params.face === undefined ? supportFaces(port, target) : [params.face]
  if (faces.length === 0) return { state: 'failed', code: 'NO_SUPPORT' }

  let lastCode = 'PLACE_FAILED'
  let lastObserved: DriverResult['observed']
  for (const face of faces) {
    const result = await port.place(target, face, params.item)
    if (result.state === 'unknown') {
      return actFailure(result, 'PLACE_FAILED')
    }
    if (result.state === 'failed') {
      lastCode = result.code ?? 'PLACE_FAILED'
      lastObserved = result.observed
      // Target-inside-body does not depend on the chosen face; stop early.
      if (lastCode === 'PLACE_BLOCKED_BY_SELF') {
        return {
          state: 'failed',
          code: lastCode,
          observed: { blockedBy: 'self', target, ...(result.observed === undefined ? {} : { provider: result.observed }) },
        }
      }
      continue
    }
    // The server accepted the placement. One immediate read confirms every
    // cell of the group; permanence is the plan verifier's job.
    if (cellsMatch(port, cells, expected)) return { state: 'succeeded' }
    lastCode = 'PLACE_READBACK_MISMATCH'
  }
  return {
    state: 'failed',
    code: lastCode,
    ...(lastObserved === undefined ? {} : { observed: lastObserved }),
  }
}

async function lookYaw(port: ClientPort, yaw: number): Promise<string | undefined> {
  if (port.lookYaw === undefined) return undefined
  const result = await port.lookYaw(yaw)
  return result.state === 'ok' ? undefined : (result.code ?? 'PLACE_LOOK_FAILED')
}

/** Add the unified failure projection to every placement failure path. */
function attachPlaceFailure(result: DriverResult, params: PlaceParams): DriverResult {
  if (result.state !== 'failed' || readFailure(result.observed) !== undefined) return result
  const code = result.code ?? 'PLACE_FAILED'
  const facts: Record<string, JsonValue> = {
    target: { x: params.x, y: params.y, z: params.z },
  }
  const suggestions: Array<{ action: string; params?: Record<string, JsonValue>; confidence: 'exact' | 'candidate'; why: string }> = []
  const observed = result.observed
  if (code === 'PLACE_BLOCKED_BY_SELF' && isRecord(observed) && Array.isArray(observed.adjacent)) {
    for (const entry of observed.adjacent.slice(0, 2)) {
      if (!isRecord(entry)
        || typeof entry.x !== 'number' || typeof entry.y !== 'number' || typeof entry.z !== 'number') continue
      suggestions.push({
        action: 'go',
        params: { x: entry.x, y: entry.y, z: entry.z, range: 0 },
        confidence: 'exact',
        why: 'this adjacent stand cell is proven not to overlap the target group',
      })
    }
  }
  if (suggestions.length === 0) {
    suggestions.push({
      action: 'reobserve',
      confidence: 'exact',
      why: 'read the target and adjacent cells before choosing another stance',
    })
  }
  return {
    ...result,
    observed: withFailure(observed, failureBody({
      layer: 'driver',
      phase: 'execute',
      code,
      observed,
      facts,
      cause: { kind: 'world', code },
      recovery: code === 'PLACE_BLOCKED_BY_SELF' ? { kind: 'replan' } : { kind: 'replan' },
      suggestions,
    })),
  }
}

function cellsMatch(port: ClientPort, cells: Cell[], expected: ExpectedBlock): boolean {
  return cells.every(cell => {
    const block = port.blockAt(cell)
    return block !== null && block.loaded && matchesName(block, expected)
  })
}

function matchesName(block: BlockInfo, expected: ExpectedBlock): boolean {
  // The driver proves the block identity; the plan verifier proves the state
  // subset (door half, bed part) once the server's update has applied.
  return matchesExpected({ name: block.name, loaded: block.loaded }, { name: expected.name })
}

function supportFaces(port: ClientPort, target: Cell): Face[] {
  const faces: Face[] = []
  for (const face of FACES) {
    const reference = port.blockAt({
      x: target.x + face.dx,
      y: target.y + face.dy,
      z: target.z + face.dz,
    })
    if (isSolid(reference)) faces.push(face.name)
  }
  return faces
}

function isAir(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

function isSolid(block: BlockInfo | null): boolean {
  return block !== null && block.loaded && !isAir(block.name)
    && block.name !== 'water' && block.name !== 'lava'
}

/** Does the body at `pos` occupy any of the target cells? */
function bodyCoversCells(pos: { x: number; y: number; z: number }, cells: readonly Cell[]): boolean {
  const x = Math.floor(pos.x)
  const z = Math.floor(pos.z)
  const firstY = Math.floor(pos.y + 0.001)
  const lastY = Math.floor(pos.y + PLAYER_HEIGHT - 0.001)
  return cells.some(cell => cell.x === x && cell.z === z && cell.y >= firstY && cell.y <= lastY)
}

/**
 * Stand cells from which the target group is not inside the body. Evidence for
 * a PLACE_BLOCKED_BY_SELF failure, not an automatic placement policy.
 */
function suggestedStances(port: ClientPort, cells: readonly Cell[]): Cell[] {
  const target = cells[0]
  if (target === undefined) return []
  const world = createReadOnlyMotionWorld(point => port.blockAt(point))
  const rules = createRules(world, defaultConstraints())
  const query = standCells(world, {
    near: target,
    reach: { horizontal: 2, vertical: 1 },
    accept: (cell, feetY) => !bodyCoversCells({ x: cell.x + 0.5, y: feetY, z: cell.z + 0.5 }, cells),
  }, { from: standingCell(rules, port.self().pos), dry: true })
  return query.cells.slice(0, 4).map(candidate => candidate.cell)
}

import type { BlockInfo, BodyApi, Face } from '../../body/api.ts'
import { isRecord } from '../../contracts/index.ts'
import type { JsonValue } from '../../contracts/types.ts'
import { standingCell } from '../../motion/execute/index.ts'
import { createRules, defaultConstraints, PLAYER_HEIGHT } from '../../motion/model/index.ts'
import { REPLACEABLE } from '../../motion/model/semantics/vanilla.ts'
import { standCells } from '../../motion/search/index.ts'
import { approachBlock } from '../approach.ts'
import { failureBody, failureSnapshot, readFailure, withFailure, diagnoseFailure } from '../failure.ts'
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
  stance?: Cell
  face?: Face
  move?: string
  place?: string
  code?: string
  ok: boolean
  itemConsumed?: boolean | null
  retrySafe?: boolean
  placedAt?: Cell
}

type FaceChoice = {
  face: Face
  reference: Cell
  support: BlockInfo
}

type PlaceEvidence = {
  placedAt?: Cell
  placedCells?: Cell[]
  changedCells?: Array<Cell & { name: string }>
  itemConsumed?: boolean | null
  retrySafe?: boolean
  supports?: Record<string, boolean>
  providerCode?: string
  providerMessage?: string
  itemCountBefore?: number
  itemCountAfter?: number
}

type StancePlan = { stand: Cell; move: boolean }

/**
 * Place one expected block (or one two-cell group: door, bed). The target is
 * the occupied cell; the driver selects one exposed support face and sends at
 * most one placement packet per item consumption. Only the readback proves
 * success; a provider `ok` is not accepted without it.
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
      return new AsyncDriverHandle(key, placeCell(ctx.body, params).then(result => attachPlaceFailure(result, params, ctx.body)))
    },
  }
}

async function placeCell(port: BodyApi, params: PlaceParams): Promise<DriverResult> {
  const target = { x: params.x, y: params.y, z: params.z }
  const expected: ExpectedBlock = {
    name: params.item,
    ...(params.expectedState === undefined ? {} : { state: params.expectedState }),
  }
  const cells: Cell[] = [target, ...(params.cells ?? [])]
  const supportHint = expectedSupport(port, target, params.item)

  const precheck = preflight(port, target, cells, expected, params, supportHint)
  if (precheck !== undefined) return precheck

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
        ...(supportHint === undefined ? {} : { supportMatchesExpected: true, suggestedTarget: supportHint }),
      },
    }
  }

  if (explicit.length > 0) {
    return await placeFromStances(
      port,
      cells,
      params,
      expected,
      explicit.map(stand => ({ stand, move: true })),
      supportHint,
    )
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
        ...(supportHint === undefined ? {} : { supportMatchesExpected: true, suggestedTarget: supportHint }),
      },
    }
  }
  if (params.yaw !== undefined) {
    const looked = await lookYaw(port, params.yaw)
    if (looked !== undefined) return { state: 'failed', code: looked }
  }

  // Try the current stand first; alternative stands are only tried before any
  // placement packet is sent. This keeps a failed packet from becoming a
  // second item consumption.
  const feet = { x: Math.floor(port.self().pos.x), y: Math.floor(port.self().pos.y), z: Math.floor(port.self().pos.z) }
  const plans: StancePlan[] = [{ stand: feet, move: false }]
  for (const stand of suggestedStances(port, cells)) {
    if (sameCell(stand, feet) || plans.some(plan => sameCell(plan.stand, stand))) continue
    plans.push({ stand, move: true })
  }
  return await placeFromStances(port, cells, params, expected, plans, supportHint)
}

async function placeFromStances(
  port: BodyApi,
  cells: Cell[],
  params: PlaceParams,
  expected: ExpectedBlock,
  stances: StancePlan[],
  supportHint: Cell | undefined,
): Promise<DriverResult> {
  const target = cells[0]!
  const attempts: Attempt[] = []
  let lastCode: string | undefined
  let lastEvidence: PlaceEvidence | undefined
  let packetFailure = false

  for (const plan of stances) {
    if (plan.move) {
      const moved = await port.moveTo(plan.stand, { range: 0.5, timeoutMs: 20_000 })
      if (moved.state !== 'ok') {
        attempts.push({
          stance: plan.stand,
          move: 'failed',
          code: moved.code ?? 'PLACE_APPROACH_FAILED',
          ok: false,
        })
        lastCode = moved.code ?? 'PLACE_APPROACH_FAILED'
        continue
      }
    }
    if (params.yaw !== undefined) {
      const looked = await lookYaw(port, params.yaw)
      if (looked !== undefined) {
        attempts.push({ stance: plan.stand, move: 'ok', code: looked, ok: false })
        lastCode = looked
        continue
      }
    }
    if (bodyCoversCells({ x: plan.stand.x + 0.5, y: plan.stand.y, z: plan.stand.z + 0.5 }, cells)) {
      attempts.push({ stance: plan.stand, place: 'failed', code: 'PLACE_BLOCKED_BY_SELF', ok: false })
      lastCode = 'PLACE_BLOCKED_BY_SELF'
      continue
    }

    const choices = faceChoices(port, target, plan.stand, params.face)
    if (choices.length === 0) {
      attempts.push({
        stance: plan.stand,
        ...(params.face === undefined ? {} : { face: params.face }),
        place: 'none',
        code: 'PLACE_UNSUPPORTED',
        ok: false,
      })
      lastCode = 'PLACE_UNSUPPORTED'
      continue
    }

    for (let index = 0; index < choices.length; index += 1) {
      const choice = choices[index]!
      const result = await port.place(target, choice.face, params.item)
      const evidence = readPlaceEvidence(result.observed)
      const attempt: Attempt = {
        stance: plan.stand,
        face: choice.face,
        place: result.state === 'ok' ? 'ok' : 'failed',
        ...(result.code === undefined ? {} : { code: result.code }),
        ok: result.state === 'ok',
        ...(evidence.itemConsumed === undefined ? {} : { itemConsumed: evidence.itemConsumed }),
        ...(evidence.retrySafe === undefined ? {} : { retrySafe: evidence.retrySafe }),
        ...(evidence.placedAt === undefined ? {} : { placedAt: evidence.placedAt }),
      }
      attempts.push(attempt)
      if (result.state === 'unknown') return actFailure(result, 'PLACE_FAILED')

      if (result.state === 'ok') {
        const confirmed = await confirmCells(port, cells, expected)
        if (!confirmed) {
          return {
            state: 'failed',
            code: 'PLACE_READBACK_MISMATCH',
            observed: failureObserved(
              target,
              cells,
              attempts,
              supportHint,
              evidence,
              choice.face,
              plan.stand,
            ),
          }
        }
        return {
          state: 'succeeded',
          observed: successObserved(port, target, cells, params, expected, choice.face, plan.stand, attempts, supportHint, evidence),
        }
      }

      lastCode = result.code ?? 'PLACE_FAILED'
      lastEvidence = evidence
      packetFailure = true

      // A provider-proven refusal (no item consumed, no block changed) is the
      // only failure that may try another face. A timeout, off-target placement
      // or consumed item is terminal for this job.
      if (evidence.retrySafe !== true) {
        return {
          state: 'failed',
          code: lastCode,
          observed: failureObserved(target, cells, attempts, supportHint, evidence, choice.face, plan.stand),
        }
      }
      if (index < choices.length - 1) continue
      // All faces of this stance were safe refusals; a later stance may expose
      // another face, still without consuming the item.
      break
    }
  }

  if (packetFailure) {
    return {
      state: 'failed',
      code: lastCode ?? 'PLACE_FAILED',
      observed: failureObserved(target, cells, attempts, supportHint, lastEvidence),
    }
  }
  const blocked = attempts.some(attempt => attempt.code === 'PLACE_BLOCKED_BY_SELF')
  return {
    state: 'failed',
    code: blocked ? 'PLACE_BLOCKED_BY_SELF' : 'PLACE_UNSUPPORTED',
    observed: failureObserved(target, cells, attempts, supportHint),
  }
}

function preflight(
  port: BodyApi,
  target: Cell,
  cells: Cell[],
  expected: ExpectedBlock,
  params: PlaceParams,
  supportHint: Cell | undefined,
): DriverResult | undefined {
  const first = port.blockAt(target)
  if (first === null || !first.loaded) {
    return { state: 'failed', code: 'OBSERVATION_UNAVAILABLE', observed: { target, cells } }
  }
  if (cellsMatch(port, cells, expected)) {
    return {
      state: 'succeeded',
      observed: {
        kind: 'place',
        target,
        cells,
        item: params.item,
        alreadyPlaced: true,
        placedAt: target,
        placedCells: cellViews(port, cells),
        ...(supportHint === undefined ? {} : { supportMatchesExpected: true, suggestedTarget: supportHint }),
      },
    }
  }
  for (const cell of cells) {
    const block = port.blockAt(cell)
    if (block === null || !block.loaded) {
      return { state: 'failed', code: 'OBSERVATION_UNAVAILABLE', observed: { target, cells, cell } }
    }
    if (isReplaceableTarget(block)) continue
    return {
      state: 'failed',
      code: 'PLACE_TARGET_OCCUPIED',
      observed: {
        kind: 'place',
        target,
        cells,
        item: params.item,
        occupied: { cell, block: block.name, replaceable: false },
        suggestedCells: suggestedPlaceCells(port, cells),
        ...(supportHint === undefined ? {} : { supportMatchesExpected: true, suggestedTarget: supportHint }),
      },
    }
  }
  return undefined
}

function faceChoices(
  port: BodyApi,
  target: Cell,
  stand: Cell,
  requestedFace: Face | undefined,
): FaceChoice[] {
  const candidates = requestedFace === undefined
    ? FACES
    : FACES.filter(face => face.name === requestedFace)
  const eye = { x: stand.x + 0.5, y: stand.y + 1.5, z: stand.z + 0.5 }
  const center = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }
  const baseAllowed = new Set([cellKey(stand), cellKey(target)])
  const choices: FaceChoice[] = []
  for (const face of candidates) {
    const reference = { x: target.x + face.dx, y: target.y + face.dy, z: target.z + face.dz }
    const support = port.blockAt(reference)
    if (!isPlaceSupport(support)) continue
    // `face.dx..` points from the target to the reference; the clicked face is
    // the shared boundary, at the target centre plus half that offset.
    const point = {
      x: center.x + face.dx * 0.5,
      y: center.y + face.dy * 0.5,
      z: center.z + face.dz * 0.5,
    }
    if (Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z) > 4.5) continue
    // The line to the face centre may graze the reference block itself; it is
    // the support, not an obstruction.
    const allowed = new Set(baseAllowed)
    allowed.add(cellKey(reference))
    if (!lineClear(port, eye, point, allowed)) continue
    choices.push({ face: face.name, reference, support })
  }
  return choices
}

function successObserved(
  port: BodyApi,
  target: Cell,
  cells: Cell[],
  params: PlaceParams,
  expected: ExpectedBlock,
  face: Face,
  stance: Cell,
  attempts: Attempt[],
  supportHint: Cell | undefined,
  evidence: PlaceEvidence,
): JsonValue {
  return {
    kind: 'place',
    target,
    cells,
    item: params.item,
    expected,
    face,
    stance,
    placedAt: target,
    placedCells: cellViews(port, cells),
    alreadyPlaced: false,
    ...(attempts.length <= 1 ? {} : { attempts: attempts as unknown as JsonValue }),
    ...(supportHint === undefined ? {} : { supportMatchesExpected: true, suggestedTarget: supportHint }),
    ...(evidence.itemConsumed === undefined ? {} : { itemConsumed: evidence.itemConsumed }),
    ...(evidence.itemCountBefore === undefined ? {} : { itemCountBefore: evidence.itemCountBefore }),
    ...(evidence.itemCountAfter === undefined ? {} : { itemCountAfter: evidence.itemCountAfter }),
    ...(evidence.supports === undefined ? {} : { supports: evidence.supports }),
  }
}

function failureObserved(
  target: Cell,
  cells: Cell[],
  attempts: Attempt[],
  supportHint: Cell | undefined,
  evidence?: PlaceEvidence,
  face?: Face,
  stance?: Cell,
): JsonValue {
  return {
    kind: 'place',
    target,
    cells,
    ...(face === undefined ? {} : { face }),
    ...(stance === undefined ? {} : { stance }),
    ...(evidence?.placedAt === undefined ? {} : { placedAt: evidence.placedAt }),
    ...(evidence?.placedCells === undefined ? {} : { placedCells: evidence.placedCells }),
    ...(evidence?.changedCells === undefined ? {} : { changedCells: evidence.changedCells }),
    ...(evidence?.itemConsumed === undefined ? {} : { itemConsumed: evidence.itemConsumed }),
    ...(evidence?.retrySafe === undefined ? {} : { retrySafe: evidence.retrySafe }),
    ...(evidence?.supports === undefined ? {} : { supports: evidence.supports }),
    ...(evidence?.providerCode === undefined ? {} : { providerCode: evidence.providerCode }),
    ...(evidence?.providerMessage === undefined ? {} : { providerMessage: evidence.providerMessage }),
    ...(evidence?.itemCountBefore === undefined ? {} : { itemCountBefore: evidence.itemCountBefore }),
    ...(evidence?.itemCountAfter === undefined ? {} : { itemCountAfter: evidence.itemCountAfter }),
    attempts: attempts as unknown as JsonValue,
    ...(supportHint === undefined ? {} : { supportMatchesExpected: true, suggestedTarget: supportHint }),
  }
}

function readPlaceEvidence(value: JsonValue | undefined): PlaceEvidence {
  if (!isRecord(value)) return {}
  const at = cellValue(value.placedAt)
  const placedCells = arrayCells(value.placedCells)
  const changedCells = arrayChangedCells(value.changedCells)
  return {
    ...(at === undefined ? {} : { placedAt: at }),
    ...(placedCells === undefined ? {} : { placedCells }),
    ...(changedCells === undefined ? {} : { changedCells }),
    ...(typeof value.itemConsumed === 'boolean' || value.itemConsumed === null ? { itemConsumed: value.itemConsumed } : {}),
    ...(typeof value.retrySafe === 'boolean' ? { retrySafe: value.retrySafe } : {}),
    ...(isRecord(value.supports) ? { supports: booleanRecord(value.supports) } : {}),
    ...(typeof value.providerCode === 'string' ? { providerCode: value.providerCode } : {}),
    ...(typeof value.providerMessage === 'string' ? { providerMessage: value.providerMessage } : {}),
    ...(typeof value.itemCountBefore === 'number' ? { itemCountBefore: value.itemCountBefore } : {}),
    ...(typeof value.itemCountAfter === 'number' ? { itemCountAfter: value.itemCountAfter } : {}),
  }
}

async function confirmCells(port: BodyApi, cells: Cell[], expected: ExpectedBlock): Promise<boolean> {
  if (cellsMatch(port, cells, expected)) return true
  await sleep(100)
  if (cellsMatch(port, cells, expected)) return true
  await sleep(100)
  return cellsMatch(port, cells, expected)
}

function cellsMatch(port: BodyApi, cells: Cell[], expected: ExpectedBlock): boolean {
  return cells.every(cell => {
    const block = port.blockAt(cell)
    return block !== null && block.loaded && matchesName(block, expected)
  })
}

function cellViews(port: BodyApi, cells: Cell[]): JsonValue {
  return cells.map(cell => {
    const block = port.blockAt(cell)
    return {
      ...cell,
      name: block === null ? null : block.name,
      loaded: block?.loaded === true,
    }
  }) as unknown as JsonValue
}

function matchesName(block: BlockInfo, expected: ExpectedBlock): boolean {
  // The driver proves the block identity; the plan verifier proves the state
  // subset (door half, bed part) once the server's update has applied.
  return matchesExpected({ name: block.name, loaded: block.loaded }, { name: expected.name })
}

function expectedSupport(port: BodyApi, target: Cell, item: string): Cell | undefined {
  for (const face of FACES) {
    const reference = { x: target.x + face.dx, y: target.y + face.dy, z: target.z + face.dz }
    const block = port.blockAt(reference)
    if (block !== null && block.loaded && sameItem(block.name, item)) return reference
  }
  return undefined
}

/** Air/fluid/`replaceable` targets may receive a block; solid targets may not. */
function isReplaceableTarget(block: BlockInfo): boolean {
  if (!block.loaded) return false
  const name = normalizeName(block.name)
  if (isAir(name) || name === 'water' || name === 'lava') return true
  if (block.serverTags !== undefined) {
    return block.serverTags.has('minecraft:replaceable') || block.serverTags.has('replaceable')
  }
  return REPLACEABLE.has(name)
}

/** A placement reference needs collision, not merely a non-air name. */
function isPlaceSupport(block: BlockInfo | null): block is BlockInfo {
  if (block === null || !block.loaded) return false
  if (isAir(normalizeName(block.name)) || block.name === 'water' || block.name === 'lava') return false
  if (block.solid === false) return false
  if (block.collision !== undefined) return block.collision.length > 0
  // Adapters without collision metadata keep the old name-based fallback.
  return true
}

function lineClear(port: BodyApi, from: Cell, to: Cell, allowed: Set<string>): boolean {
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  const steps = Math.ceil(distance / 0.1)
  for (let step = 1; step < steps; step += 1) {
    const t = step / steps
    const at = {
      x: Math.floor(from.x + (to.x - from.x) * t),
      y: Math.floor(from.y + (to.y - from.y) * t),
      z: Math.floor(from.z + (to.z - from.z) * t),
    }
    if (allowed.has(cellKey(at))) continue
    const block = port.blockAt(at)
    // Unknown/unloaded cells are not proof of a wall; the provider still has the
    // final say. A loaded non-air block on the line is a real obstruction.
    if (block === null || !block.loaded) continue
    if (!isAir(block.name) && block.name !== 'water' && block.name !== 'lava') return false
  }
  return true
}

/** Add the unified failure projection to every placement failure path. */
function attachPlaceFailure(result: DriverResult, params: PlaceParams, port: BodyApi): DriverResult {
  if (result.state !== 'failed' || readFailure(result.observed) !== undefined) return result
  const code = result.code ?? 'PLACE_FAILED'
  const target = { x: params.x, y: params.y, z: params.z }
  const cells = [target, ...(params.cells ?? [])]
  const observed = result.observed
  const provider = isRecord(observed) ? observed : undefined
  const evidence = readPlaceEvidence(observed)
  const facts: Record<string, JsonValue> = {
    target,
    snapshot: failureSnapshot(port, target, observed) as unknown as JsonValue,
  }
  // The last attempted face plus every attempt makes a refused placement
  // explainable without a second observation.
  if (typeof provider?.face === 'string') facts.face = provider.face
  if (Array.isArray(provider?.attempts)) {
    facts.attempts = provider.attempts.slice(0, 8) as unknown as JsonValue
  }
  // Prefer the provider's own six-face read from the placement window; fall
  // back to reading the target only when the provider did not report it.
  const providerSupports = evidence.supports ?? (isRecord(provider?.supports) ? booleanRecord(provider.supports) : undefined)
  if (code === 'PLACE_FAILED' || code === 'PLACE_READBACK_MISMATCH'
    || code === 'PLACE_UNSUPPORTED' || code === 'NO_SUPPORT' || code === 'PLACE_OFF_TARGET') {
    facts.supports = (providerSupports ?? supportFacts(port, target)) as unknown as JsonValue
  }
  if (code === 'PLACE_UNSUPPORTED' || code === 'NO_SUPPORT' || code === 'PLACE_TARGET_OCCUPIED') {
    facts.suggestedCells = suggestedPlaceCells(port, cells) as unknown as JsonValue
  }
  if (evidence.placedAt !== undefined) facts.placedAt = evidence.placedAt as unknown as JsonValue
  if (evidence.placedCells !== undefined) facts.placedCells = evidence.placedCells as unknown as JsonValue
  if (evidence.changedCells !== undefined) facts.changedCells = evidence.changedCells as unknown as JsonValue
  if (evidence.itemConsumed !== undefined) facts.itemConsumed = evidence.itemConsumed
  if (evidence.retrySafe !== undefined) facts.retrySafe = evidence.retrySafe
  if (evidence.itemCountBefore !== undefined) facts.itemCountBefore = evidence.itemCountBefore
  if (evidence.itemCountAfter !== undefined) facts.itemCountAfter = evidence.itemCountAfter
  if (isRecord(provider?.occupied)) facts.occupied = provider.occupied as unknown as JsonValue
  if (provider?.supportMatchesExpected === true) {
    facts.supportMatchesExpected = true
    if (isCell(provider.suggestedTarget)) facts.suggestedTarget = provider.suggestedTarget as unknown as JsonValue
  }
  // Stand cells, not placement candidates: the same `adjacent` meaning as
  // PLACE_BLOCKED_BY_SELF.
  if (code === 'PLACE_FAILED' || code === 'PLACE_BLOCKED_BY_SELF') {
    facts.adjacent = suggestedStances(port, cells) as unknown as JsonValue
  }
  if (typeof provider?.providerCode === 'string') facts.providerCode = provider.providerCode
  if (typeof provider?.providerMessage === 'string') {
    facts.providerMessage = provider.providerMessage.slice(0, 200)
  }
  if (isRecord(provider?.denial)) facts.denial = provider.denial
  const diagnosis = diagnoseFailure({ code, observed, facts })
  return {
    ...result,
    observed: withFailure(observed, failureBody({
      layer: 'driver',
      phase: 'execute',
      code,
      observed,
      facts,
      diagnosis,
      cause: { kind: diagnosis === 'DENIED' ? 'authority' : 'world', code },
      recovery: 'replan',
    })),
  }
}

/** All six faces of one target cell, true when that neighbour is a support. */
function supportFacts(port: BodyApi, target: Cell): Record<Face, boolean> {
  const result = {} as Record<Face, boolean>
  for (const face of FACES) {
    result[face.name] = isPlaceSupport(port.blockAt({
      x: target.x + face.dx,
      y: target.y + face.dy,
      z: target.z + face.dz,
    }))
  }
  return result
}

/**
 * Up to three nearby empty cells that already have a solid reference face and
 * are not occupied by the body. These are candidate placement cells, not stand
 * cells; the caller remains responsible for choosing and approaching them.
 */
function suggestedPlaceCells(
  port: BodyApi,
  cells: readonly Cell[],
): Array<{ cell: [number, number, number]; support: Face }> {
  const target = cells[0]
  if (target === undefined) return []
  const self = port.self().pos
  const candidates: Array<{ cell: [number, number, number]; support: Face; distance: number }> = []
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        if (dx === 0 && dy === 0 && dz === 0) continue
        const candidate: Cell = { x: target.x + dx, y: target.y + dy, z: target.z + dz }
        if (cells.some(cell => sameCell(cell, candidate))) continue
        if (bodyCoversCells(self, [candidate])) continue
        const block = port.blockAt(candidate)
        if (block === null || !block.loaded || !isAir(block.name)) continue
        const support = FACES.find(face => isPlaceSupport(port.blockAt({
          x: candidate.x + face.dx,
          y: candidate.y + face.dy,
          z: candidate.z + face.dz,
        })))
        if (support === undefined) continue
        candidates.push({
          cell: [candidate.x, candidate.y, candidate.z],
          support: support.name,
          distance: Math.abs(dx) + Math.abs(dy) + Math.abs(dz),
        })
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.cell[1] - b.cell[1]
    || a.cell[0] - b.cell[0] || a.cell[2] - b.cell[2])
  return candidates.slice(0, 3).map(({ cell, support }) => ({ cell, support }))
}

function isAir(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

/** Does the body at `pos` occupy any of the target cells? */
function bodyCoversCells(pos: { x: number; y: number; z: number }, cells: readonly Cell[]): boolean {
  const x = Math.floor(pos.x)
  const z = Math.floor(pos.z)
  const firstY = Math.floor(pos.y + 0.001)
  const lastY = Math.floor(pos.y + PLAYER_HEIGHT - 0.001)
  return cells.some(cell => cell.x === x && cell.z === z && cell.y >= firstY && cell.y <= lastY)
}

async function lookYaw(port: BodyApi, yaw: number): Promise<string | undefined> {
  if (port.lookYaw === undefined) return undefined
  const result = await port.lookYaw(yaw)
  return result.state === 'ok' ? undefined : (result.code ?? 'PLACE_LOOK_FAILED')
}

/**
 * Stand cells from which the target group is not inside the body. Evidence for
 * a PLACE_BLOCKED_BY_SELF failure, not an automatic placement policy.
 */
function suggestedStances(port: BodyApi, cells: readonly Cell[]): Cell[] {
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

function isCell(value: unknown): value is Cell {
  return isRecord(value)
    && typeof value.x === 'number'
    && typeof value.y === 'number'
    && typeof value.z === 'number'
}

function cellValue(value: JsonValue | undefined): Cell | undefined {
  return isCell(value) ? { x: value.x, y: value.y, z: value.z } : undefined
}

function arrayCells(value: JsonValue | undefined): Cell[] | undefined {
  if (!Array.isArray(value)) return undefined
  const cells: Cell[] = []
  for (const entry of value.slice(0, 8)) {
    if (isCell(entry)) cells.push({ x: entry.x, y: entry.y, z: entry.z })
  }
  return cells
}

function arrayChangedCells(value: JsonValue | undefined): Array<Cell & { name: string }> | undefined {
  if (!Array.isArray(value)) return undefined
  const cells: Array<Cell & { name: string }> = []
  for (const entry of value.slice(0, 8)) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue
    if (typeof entry.x !== 'number' || typeof entry.y !== 'number' || typeof entry.z !== 'number') continue
    cells.push({ x: entry.x, y: entry.y, z: entry.z, name: entry.name })
  }
  return cells
}

function booleanRecord(value: Record<string, JsonValue>): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'boolean') result[key] = entry
  }
  return result
}

function sameCell(left: Cell, right: Cell): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z
}

function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y},${cell.z}`
}

function normalizeName(name: string): string {
  return name.replace(/^minecraft:/u, '')
}

function sameItem(left: string, right: string): boolean {
  return normalizeName(left) === normalizeName(right)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

import type { BlockInfo, ClientPort, Face } from '../../port/index.ts'
import { matchesExpected } from '../plan.ts'
import type { ExpectedBlock } from '../plan.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle, sleep } from './handle.ts'

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
}

/**
 * Place one expected block. Toils: observe → choose support face → place →
 * readback #1 → readback #2. The driver only executes the selected cell.
 */
export function createPlaceDriver(): Driver {
  return {
    id: PLACE_DRIVER_ID,
    schema: PLACE_SCHEMA,
    defaults: {
      budget: { maxTicks: 200, maxWallMs: 15_000 },
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
      return new AsyncDriverHandle(key, placeCell(ctx.port, params))
    },
  }
}

async function placeCell(port: ClientPort, params: PlaceParams): Promise<DriverResult> {
  const target = { x: params.x, y: params.y, z: params.z }
  const expected: ExpectedBlock = {
    name: params.item,
    ...(params.expectedState === undefined ? {} : { state: params.expectedState }),
  }

  const before = port.blockAt(target)
  if (before === null || !before.loaded) {
    return { state: 'failed', code: 'OBSERVATION_UNAVAILABLE' }
  }
  if (matchesExpected(before, expected)) return { state: 'succeeded' }
  if (!isAir(before.name)) return { state: 'failed', code: 'PLACE_CONFLICT' }

  const faces = params.face === undefined ? supportFaces(port, target) : [params.face]
  if (faces.length === 0) return { state: 'failed', code: 'NO_SUPPORT' }

  let lastCode = 'PLACE_FAILED'
  for (const face of faces) {
    const result = await port.place(target, face, params.item)
    if (result.state === 'unknown') {
      return { state: 'failed', code: result.code ?? 'CLIENT_TIMEOUT' }
    }
    if (result.state === 'failed') {
      lastCode = result.code ?? 'PLACE_FAILED'
      continue
    }
    const first = port.blockAt(target)
    await sleep(200)
    const second = port.blockAt(target)
    if (matches(first, expected) && matches(second, expected)) return { state: 'succeeded' }
    lastCode = 'READBACK_UNSTABLE'
  }
  return { state: 'failed', code: lastCode }
}

function supportFaces(port: ClientPort, target: { x: number; y: number; z: number }): Face[] {
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

function matches(block: BlockInfo | null, expected: ExpectedBlock): boolean {
  return block !== null && block.loaded && matchesExpected(block, expected)
}

function isAir(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

function isSolid(block: BlockInfo | null): boolean {
  return block !== null && block.loaded && !isAir(block.name)
    && block.name !== 'water' && block.name !== 'lava'
}

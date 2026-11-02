import type { JsonValue } from '../contracts/types.ts'
import { standingAt } from './standing.ts'
import type { ClientPort, Vec3 } from '../port/index.ts'

export type ApproachResult =
  | { ok: true }
  | { ok: false; code: string; observed?: JsonValue }

/**
 * Close the distance to an already-selected block before interacting. The
 * target stays the giver's; this only chooses a standing cell near it.
 *
 * The block itself is often solid, so the move goal is a standable neighbour,
 * never the block coordinate.
 */
export async function approachBlock(
  port: ClientPort,
  target: Vec3,
  options: { range?: number; timeoutMs?: number; code?: string } = {},
): Promise<ApproachResult> {
  const self = port.self().pos
  const distance = Math.hypot(
    target.x + 0.5 - self.x,
    target.y + 0.5 - (self.y + 1.5),
    target.z + 0.5 - self.z,
  )
  if (distance <= 4) return { ok: true }
  const stand = nearestStandableCell(port, target)
  if (stand === undefined) return { ok: false, code: 'APPROACH_NO_STAND' }
  const moved = await port.moveTo(stand, {
    range: options.range ?? 1,
    intent: 'interact',
    timeoutMs: options.timeoutMs ?? 15_000,
  })
  if (moved.state === 'ok') return { ok: true }
  return {
    ok: false,
    code: moved.code ?? options.code ?? 'APPROACH_FAILED',
    ...(moved.observed === undefined ? {} : { observed: moved.observed }),
  }
}

export function nearestStandableCell(port: ClientPort, target: Vec3): Vec3 | undefined {
  const read = (point: Vec3) => port.blockAt(point)
  let best: Vec3 | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (let dx = -3; dx <= 3; dx += 1) {
    for (let dz = -3; dz <= 3; dz += 1) {
      for (let dy = -2; dy <= 2; dy += 1) {
        const candidate = { x: target.x + dx, y: target.y + dy, z: target.z + dz }
        if (standingAt(read, candidate).state !== 'valid') continue
        const distance = Math.hypot(
          candidate.x - target.x,
          candidate.y - target.y,
          candidate.z - target.z,
        )
        if (distance < bestDistance) {
          best = candidate
          bestDistance = distance
        }
      }
    }
  }
  return best
}


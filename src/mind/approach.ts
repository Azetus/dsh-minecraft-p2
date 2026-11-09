import type { JsonValue } from '../contracts/types.ts'
import { cellOf } from '../motion/model/index.ts'
import { nearestStandCell, type StandCell, type StandResult } from '../motion/search/index.ts'
import { createReadOnlyMotionWorld } from './standing.ts'
import type { BodyApi, Vec3 } from '../body/api.ts'

export type ApproachResult =
  | { ok: true }
  | { ok: false; code: string; observed?: JsonValue }

/**
 * Reach envelope for "a cell from which this block can be used". It is the
 * core query's input; the query owns the candidate window and the standability
 * check, so nothing here repeats a `-3..3` loop.
 */
const STAND_REACH = { horizontal: 3, vertical: 2 } as const

/**
 * Close the distance to an already-selected block before interacting. The
 * target stays the giver's; this only chooses a standing cell near it.
 *
 * The block itself is often solid, so the move goal is a standable neighbour,
 * never the block coordinate. The neighbour is chosen through the same Rules
 * and move edges as the executor: reachable cells come first, and when the
 * reachability walk proves the neighbourhood unreachable the caller gets
 * `APPROACH_NO_PATH` instead of a generic move failure.
 */
export async function approachBlock(
  port: BodyApi,
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
  const stand = nearestStandCell(
    createReadOnlyMotionWorld(point => port.blockAt(point)),
    {
      near: target,
      reach: STAND_REACH,
      // Standing inside the target cell cannot use or place into it.
      accept: cell => cell.x !== target.x || cell.y !== target.y || cell.z !== target.z,
    },
    { from: cellOf(self) },
  )
  const observed = summarize(stand)
  if (stand.best === undefined) {
    return {
      ok: false,
      code: stand.reason === 'unloaded-window' ? 'APPROACH_UNKNOWN' : 'APPROACH_NO_STAND',
      observed,
    }
  }
  if (stand.best.reachable === 'no') {
    // Proof, not a budget guess: the BFS drained the reachable component.
    return { ok: false, code: 'APPROACH_NO_PATH', observed }
  }
  const moved = await port.moveTo(stand.best.cell, {
    range: options.range ?? 1,
    intent: 'interact',
    timeoutMs: options.timeoutMs ?? 15_000,
  })
  if (moved.state === 'ok') return { ok: true }
  return {
    ok: false,
    code: moved.code ?? options.code ?? 'APPROACH_FAILED',
    observed: {
      query: observed,
      ...(moved.observed === undefined ? {} : { move: moved.observed }),
    },
  }
}

function summarize(result: StandResult & { best?: StandCell }): JsonValue {
  return {
    kind: 'approach',
    reason: result.reason ?? null,
    coverage: result.coverage,
    scanned: result.scanned,
    unknown: result.unknown,
    candidates: result.cells.length,
    best: result.best === undefined
      ? null
      : {
          cell: { ...result.best.cell },
          feetY: result.best.feetY,
          reachable: result.best.reachable,
          steps: result.best.steps ?? null,
        },
  }
}

import {
  AscendMove,
  ClimbMove,
  DescendMove,
  DiagonalMove,
  DownwardMove,
  FallMove,
  ParkourMove,
  PillarMove,
  TraverseMove,
} from './moves.ts'
import { cellOf } from './moves.ts'
import { COST_INF, type Cell, type Move, type MoveContext } from '../model/types.ts'

export type BuildMovesResult =
  | { ok: true; moves: Move[] }
  | { ok: false; code: string; reason: string; at: Cell }

/**
 * Convert path nodes into typed moves. The planner (P1: the existing search)
 * may return edges this move set does not implement yet; those are rejected as
 * no path rather than executed blindly.
 */
export function buildMoves(
  path: readonly Cell[],
  start: Cell,
  ctx: MoveContext,
): BuildMovesResult {
  const nodes: Cell[] = []
  for (const node of [start, ...path]) {
    const last = nodes.at(-1)
    if (last !== undefined && last.x === node.x && last.y === node.y && last.z === node.z) continue
    nodes.push(node)
  }
  const moves: Move[] = []
  for (let index = 1; index < nodes.length; index += 1) {
    const src = nodes[index - 1]!
    const dest = nodes[index]!
    const dx = dest.x - src.x
    const dy = dest.y - src.y
    const dz = dest.z - src.z
    const move = makeMove(src, dest, dx, dy, dz, ctx)
    if (move === undefined) {
      return { ok: false, code: 'UNSUPPORTED_EDGE', reason: `dx=${dx} dy=${dy} dz=${dz}`, at: dest }
    }
    if (move.cost(ctx) === COST_INF) {
      return { ok: false, code: 'EDGE_INFEASIBLE', reason: `${move.kind} at ${dest.x},${dest.y},${dest.z}`, at: dest }
    }
    moves.push(move)
  }
  return { ok: true, moves }
}

function makeMove(
  src: Cell,
  dest: Cell,
  dx: number,
  dy: number,
  dz: number,
  ctx: MoveContext,
): Move | undefined {
  const horizontal = Math.abs(dx) + Math.abs(dz)
  // Climbable destinations need the climb state machine even when the geometry
  // looks like a traverse/ascend: a ladder cell has no support of its own.
  if (ctx.rules.isClimbable(dest) === 'yes' && horizontal <= 1 && Math.abs(dy) <= 1) {
    return new ClimbMove(src, dest)
  }
  if (horizontal === 1) {
    if (dy === 0) return new TraverseMove(src, dest)
    if (dy === 1) return new AscendMove(src, dest)
    if (dy === -1) return new DescendMove(src, dest)
    if (dy <= -2) return new FallMove(src, dest)
    return undefined
  }
  if (horizontal === 0) {
    if (dy < 0) return new DownwardMove(src, dest)
    if (dy >= 1 && ctx.constraints.allowPlace) return new PillarMove(src, dest)
    return undefined
  }
  if (Math.abs(dx) === 1 && Math.abs(dz) === 1) {
    if (dy === 0) return new DiagonalMove(src, dest)
    // Diagonal ascend/descend is deliberately not in P1; no silent fallback.
    return undefined
  }
  if (dy === 0 && horizontal === 2) return new ParkourMove(src, dest)
  return undefined
}

export { cellOf }

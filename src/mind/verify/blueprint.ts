import type { PlanInstance } from '../plan.ts'
import { itemCells, matchesExpected } from '../plan.ts'
import type { WorldView } from '../types.ts'
import type { VerifyResult } from './sealed-room.ts'

/**
 * Generic final-geometry verifier: every expected cell (including the second
 * cell of a door/bed placement) must still match its name+state subset. It is
 * the authority for a build order; a placement that the server accepted but the
 * world later removed is refuted here.
 */
export function verifyBlueprint(plan: PlanInstance, world: WorldView): VerifyResult {
  let expectedCells = 0
  for (const item of plan.workItems) {
    for (const cell of itemCells(plan, item)) {
      expectedCells += 1
      const block = world.blockAt(cell.pos)
      if (block === null || !block.loaded) {
        return { state: 'insufficient', at: cell.pos, detail: 'expected block is not loaded' }
      }
      if (!matchesExpected(block, cell.expected)) {
        return {
          state: 'refuted',
          at: cell.pos,
          detail: `expected ${cell.expected.name}, found ${block.name}`,
        }
      }
    }
  }
  return expectedCells === 0
    ? { state: 'insufficient', detail: 'plan has no expected blocks' }
    : { state: 'confirmed' }
}

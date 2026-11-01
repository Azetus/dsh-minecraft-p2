import type { PlanInstance } from '../plan.ts'
import { itemPosition, matchesExpected } from '../plan.ts'
import type { WorldView } from '../types.ts'
import type { VerifyResult } from './sealed-room.ts'

/**
 * Generic final-geometry verifier: every expected work item must still match
 * its name+state subset. It is the authority for a build order; a placement
 * that the server accepted but the world later removed is refuted here.
 */
export function verifyBlueprint(plan: PlanInstance, world: WorldView): VerifyResult {
  let expectedItems = 0
  for (const item of plan.workItems) {
    if (item.expected === undefined) continue
    expectedItems += 1
    const at = itemPosition(plan, item)
    const block = world.blockAt(at)
    if (block === null || !block.loaded) {
      return { state: 'insufficient', at, detail: 'expected block is not loaded' }
    }
    if (!matchesExpected(block, item.expected)) {
      return {
        state: 'refuted',
        at,
        detail: `expected ${item.expected.name}, found ${block.name}`,
      }
    }
  }
  return expectedItems === 0
    ? { state: 'insufficient', detail: 'plan has no expected blocks' }
    : { state: 'confirmed' }
}

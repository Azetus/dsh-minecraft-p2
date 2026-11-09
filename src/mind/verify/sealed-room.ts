import type { Vec3 } from '../../body/api.ts'
import { isAirName, isSolidBlock } from '../plan.ts'
import type { PlanInstance, VerifySpec } from '../plan.ts'
import type { WorldView } from '../types.ts'

export type VerifyState = 'confirmed' | 'refuted' | 'insufficient'

export type VerifyResult = {
  state: VerifyState
  /** First cell that decided the result, when there is one. */
  at?: Vec3
  detail?: string
  /** Work item whose expected block is at `at`, when one exists. */
  workItemId?: string
}

/**
 * Pure observation: the interior must be air and the one-block shell must be
 * solid. Any unloaded cell is `insufficient`, never a silent pass.
 */
export function verifySealedRoom(
  plan: PlanInstance,
  spec: VerifySpec,
  world: WorldView,
): VerifyResult {
  const min = absolute(plan, spec.min)
  const max = absolute(plan, spec.max)

  let unknown: Vec3 | undefined
  for (let x = min.x; x <= max.x; x += 1) {
    for (let y = min.y; y <= max.y; y += 1) {
      for (let z = min.z; z <= max.z; z += 1) {
        const at = { x, y, z }
        const block = world.blockAt(at)
        if (block === null || !block.loaded) {
          unknown ??= at
          continue
        }
        if (!isAirName(block.name)) {
          return { state: 'refuted', at, detail: `interior cell contains ${block.name}` }
        }
      }
    }
  }

  for (let x = min.x - 1; x <= max.x + 1; x += 1) {
    for (let y = min.y - 1; y <= max.y + 1; y += 1) {
      for (let z = min.z - 1; z <= max.z + 1; z += 1) {
        if (x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z) continue
        const at = { x, y, z }
        const block = world.blockAt(at)
        if (block === null || !block.loaded) {
          unknown ??= at
          continue
        }
        if (!isSolidBlock(block)) {
          return { state: 'refuted', at, detail: `shell cell is ${block.name}` }
        }
      }
    }
  }

  return unknown === undefined
    ? { state: 'confirmed' }
    : { state: 'insufficient', at: unknown, detail: 'part of the room is not loaded' }
}

/** Convenience for cells given as absolute coordinates. */
export function absolute(plan: PlanInstance, relative: [number, number, number]): Vec3 {
  return {
    x: plan.origin.x + relative[0],
    y: plan.origin.y + relative[1],
    z: plan.origin.z + relative[2],
  }
}

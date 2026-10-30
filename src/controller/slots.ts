/**
 * Fixed four-slot skeleton and the conflict matrix (P2CONTROLLER §6).
 *
 * Only the action slot is unique. Slot evaluation may happen in parallel; the
 * ordering below only decides who gets the next action. There are no weights:
 * a fixed class order for emergencies, then slot order, then registration order.
 */

import type { HazardClass, SlotId } from './types.ts'
import { HAZARD_RANK } from './types.ts'

export type SlotDefinition = {
  id: SlotId
  name: string
  responsibility: string
}

export const SLOTS: readonly SlotDefinition[] = Object.freeze([
  { id: 'S0', name: 'Emergency', responsibility: 'preempt actions and protect life' },
  { id: 'S1', name: 'Maintenance', responsibility: 'maintain survival conditions' },
  { id: 'S2', name: 'Commitment', responsibility: 'advance the current commitment and local recovery' },
  { id: 'S3', name: 'Standby', responsibility: 'default state with no commitment' },
])

export const SLOT_ORDER: readonly SlotId[] = Object.freeze(['S0', 'S1', 'S2', 'S3'])

export function slotRank(slot: SlotId): number {
  const index = SLOT_ORDER.indexOf(slot)
  return index < 0 ? SLOT_ORDER.length : index
}

export type CandidateOrder = {
  slot: SlotId
  hazardClass?: HazardClass
  registration: number
}

/**
 * Fixed order: immediate-fatal > bleeding/fire > trapped, then slot order,
 * then registration order. Same class never introduces weights.
 */
export function compareCandidates(left: CandidateOrder, right: CandidateOrder): number {
  const leftHazard = left.slot === 'S0' && left.hazardClass !== undefined
  const rightHazard = right.slot === 'S0' && right.hazardClass !== undefined
  if (leftHazard && rightHazard) {
    const rank = HAZARD_RANK[left.hazardClass as HazardClass] - HAZARD_RANK[right.hazardClass as HazardClass]
    if (rank !== 0) return rank
  } else if (leftHazard !== rightHazard) {
    return leftHazard ? -1 : 1
  }
  const slot = slotRank(left.slot) - slotRank(right.slot)
  if (slot !== 0) return slot
  return left.registration - right.registration
}

/**
 * Pure spacing decision for one locked melee engagement.
 *
 * "Backoff" here means spacing backoff: step out to the band edge, not retreat
 * out of the fight. It never changes the target, never leaves the job and never
 * seeks cover, so the explicit-attack contract stays intact.
 */

export type CombatMove = 'approach' | 'hold' | 'backoff' | 'strafe-left' | 'strafe-right'

export type CombatBand = { min: number; desired: number; max: number }

export type CombatMoveInput = {
  /** Eye-to-AABB distance from a fresh inspect. */
  distance: number
  band: CombatBand
  tooClose: number
  visible: boolean
  /** Self health dropped within the hurt window. */
  recentlyHurt: boolean
  /** Movement is not making progress; suppress strafing, not safety backoff. */
  stalled: boolean
  strafeEnabled: boolean
  side: 'left' | 'right'
}

const MIN_REACH = 1.5
const MAX_REACH = 6
const TOO_CLOSE_MIN = 0.5

/** Clamp the attribute-derived reach to a sane engagement envelope. */
export function clampReach(reach: number): number {
  return Math.min(MAX_REACH, Math.max(MIN_REACH, reach))
}

/**
 * The hold band derived from the current reach: a 0.2 safety margin below
 * reach, a 0.5 mid point, and a 0.8 floor. reach 3.0 -> 2.2 / 2.5 / 2.8.
 */
export function engageBand(reach: number): CombatBand {
  const value = clampReach(reach)
  return { min: value - 0.8, desired: value - 0.5, max: value - 0.2 }
}

/** Below this the target is effectively inside the body: back off first. */
export function tooCloseFor(reach: number): number {
  return Math.max(TOO_CLOSE_MIN, clampReach(reach) - 1.4)
}

export function decideCombatMove(input: CombatMoveInput): CombatMove {
  if (!input.visible) return 'hold'
  if (input.distance < input.tooClose) return 'backoff'
  if (input.recentlyHurt && input.distance < input.band.max - 0.1) return 'backoff'
  if (input.distance > input.band.max) return 'approach'
  if (input.stalled) return 'hold'
  if (input.strafeEnabled && input.distance >= input.band.min) return `strafe-${input.side}`
  return 'hold'
}

export { attackCooldownMs } from './cooldown.ts'
export {
  clampReach,
  decideCombatMove,
  engageBand,
  nextStrafeSide,
  tooCloseFor,
  type CombatBand,
  type CombatMove,
  type CombatMoveInput,
} from './decide.ts'
export {
  DEFAULT_ENTITY_HEIGHT,
  DEFAULT_ENTITY_WIDTH,
  PLAYER_EYE_OFFSET,
  entityBox,
  eyeHeight,
  eyeReach,
} from './geometry.ts'
export type {
  CombatAction,
  CombatActionState,
  CombatEntity,
  CombatInput,
  CombatPort,
  MeleeOptions,
  MeleeResult,
} from './types.ts'
export { CombatSession, type CombatSessionState } from './session.ts'

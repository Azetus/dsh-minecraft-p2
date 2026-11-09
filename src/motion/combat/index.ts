export { attackCooldownMs } from './cooldown.ts'
export {
  clampReach,
  decideCombatMove,
  engageBand,
  tooCloseFor,
  type CombatBand,
  type CombatMove,
  type CombatMoveInput,
} from './decide.ts'
export { CombatEvidence } from './evidence.ts'
export {
  DEFAULT_ENTITY_HEIGHT,
  DEFAULT_ENTITY_WIDTH,
  PLAYER_EYE_OFFSET,
  entityBox,
  eyeHeight,
  eyeReach,
} from './geometry.ts'
export {
  runMeleeCombat,
  type CombatAction,
  type CombatActionState,
  type CombatEntity,
  type CombatPort,
  type CombatStandCell,
  type CombatStandQuery,
  type CombatStepOptions,
  type MeleeOptions,
  type MeleeResult,
} from './controller.ts'

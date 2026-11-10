import type { Vec3 } from '../model/types.ts'

export type CombatActionState = 'ok' | 'failed' | 'unknown'

export type CombatAction = {
  state: CombatActionState
  code?: string
}

export type CombatEntity = {
  id: string
  name: string
  position: Vec3
  /** Adapter-reported velocity in blocks per tick; absent means unknown. */
  velocity?: Vec3
  /** Entity yaw in radians; absent means the adapter cannot tell. */
  yaw?: number
  type?: string
  kind?: string
  health?: number
  width?: number
  height?: number
}

export type CombatInput = {
  face: Vec3
  forward?: boolean
  back?: boolean
  left?: boolean
  right?: boolean
}

/**
 * The tick combat session's dependency boundary. Movement and shield are
 * persistent control states; attack/lookAt are short one-shot acts.
 */
export type CombatPort = {
  now(): number
  self(): { pos: Vec3; health: number; height?: number }
  entity(id: string): CombatEntity | undefined
  canSee(id: string): boolean
  attackSpeed(): number
  reach?(): number
  attack(id: string): Promise<CombatAction>
  /** Persistent movement controls, updated by the 50ms tick. */
  combatInput?(opts: CombatInput): Promise<CombatAction>
  lookAt?(pos: Vec3): Promise<CombatAction>
  hasShield?(): boolean
  /** Persistent off-hand shield stance; true holds, false releases. */
  offhandHold?(active: boolean): Promise<CombatAction>
  onEntityHurt(cb: (entityId: string) => void): () => void
  onEntityDead(cb: (entityId: string) => void): () => void
}

export type MeleeOptions = {
  targetName?: string
  /** Explicit Agent order: no P2-side player/passive protection filter. */
  allowAny?: boolean
  /** Compatibility flag for passive/neutral targets. */
  allowPassive?: boolean
  reach?: number
  maxAttacks?: number
  totalMs?: number
  maxMisses?: number
  /** Hurt guard window; requires a shield. */
  guardMs?: number
  /** Test/A-B only: 0 disables the guard. */
  movement?: boolean
  strafe?: boolean
  /** Test/A-B only: disable the persistent shield stance. */
  shield?: boolean
  /** Raise the shield before the first swing. */
  preShield?: boolean
  /** Distance at which the opening stance is raised (default 12). */
  preShieldRange?: number
}

export type MeleeResult = {
  state: 'succeeded' | 'failed'
  code?: string
  observed: {
    kind: 'attack'
    entityId: string
    targetName?: string
    attacks: number
    attacksIssued: number
    damageObserved: number
    deathConfirmed: boolean
    targetLost: boolean
    killed: boolean
    guardWindows: number
    guardExits: number
    stanceRaises: number
    stanceDrops: number
    stanceReleaseFailures: number
    shieldHeldMs: number
    preShieldRaises: number
    approachMoves: number
    strafeMoves: number
    backoffMoves: number
    inputTicks: number
    inputBlocked: number
    inputFailures: number
    reach: number
    reachSource: 'attribute' | 'default' | 'override'
    /** Attached by the attack driver, not the session. */
    shieldAutoEquip?: 'equipped' | 'present' | 'skipped' | 'failed' | 'no-shield'
    lostReason?: string
    targetHealth?: number
  }
}

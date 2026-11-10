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
  jump?: boolean
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
  /** Read-only path planning; the session follows the waypoints each tick. */
  pathTo?(pos: Vec3, range: number, timeoutMs: number): Promise<{
    state: 'ok' | 'failed'
    code?: string
    path?: Vec3[]
  }>
  /** Persistent movement controls, updated by the 50ms tick. */
  combatInput?(opts: CombatInput): Promise<CombatAction>
  lookAt?(pos: Vec3): Promise<CombatAction>
  hasShield?(): boolean
  /** Persistent off-hand shield stance; true holds, false releases. */
  offhandHold?(active: boolean): Promise<CombatAction>
  onEntityHurt(cb: (entityId: string) => void): () => void
  onEntityDead(cb: (entityId: string) => void): () => void
  /** Explosion center/radius; used only to classify creeper neutralization. */
  onExplosion?(cb: (pos: Vec3, radius?: number) => void): () => void
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
  /** Additional allowed targets; the session switches inside this set. */
  targetIds?: string[]
  /** Raise the shield before the first swing. */
  preShield?: boolean
  /** Distance at which the opening stance is raised (default 12). */
  preShieldRange?: number
  /** Test/A-B only: back off while facing a creeper at blast range. */
  creeperBackpedal?: boolean
  /** LOS recovery budget before ATTACK_NO_LINE_OF_SIGHT (default 40 ticks). */
  losRecoveryTicks?: number
  /** Optional engagement leash from the session start (blocks/targets). */
  chaseLeash?: number
  /** A fight engagement resolves when no allowed target remains alive. */
  engagement?: boolean
}

export type MeleeResult = {
  state: 'succeeded' | 'failed'
  code?: string
  observed: {
    kind: 'attack'
    entityId: string
    targets: string[]
    kills: number
    neutralized: number
    escaped: number
    resolution: 'killed' | 'neutralized' | 'escaped' | 'lost' | 'protected' | 'unresolved'
    resolved: boolean
    retryable: boolean
    targetSwitches: number
    lostTargets: number
    threatCount: number
    rangedThreat: boolean
    explosionThreat: boolean
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

/** Evidence accumulated during one melee engagement. */
export class CombatEvidence {
  attacksIssued = 0
  damageObserved = 0
  deathConfirmed = false
  targetLost = false
  lastHurtAt: number | undefined
  lastDeathAt: number | undefined
  targetHealth: number | undefined

  hurt(entityId: string, targetId: string, now: number): void {
    if (entityId !== targetId) return
    this.damageObserved += 1
    this.lastHurtAt = now
  }

  dead(entityId: string, targetId: string, now: number): void {
    if (entityId !== targetId) return
    this.deathConfirmed = true
    this.lastDeathAt = now
  }

  lost(): void {
    this.targetLost = true
  }

  snapshot(): {
    attacksIssued: number
    damageObserved: number
    deathConfirmed: boolean
    targetLost: boolean
    killed: boolean
  } {
    return {
      attacksIssued: this.attacksIssued,
      damageObserved: this.damageObserved,
      deathConfirmed: this.deathConfirmed,
      targetLost: this.targetLost,
      // A disappearance is never death evidence.
      killed: this.deathConfirmed,
    }
  }
}

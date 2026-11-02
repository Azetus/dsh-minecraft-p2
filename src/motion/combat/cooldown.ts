/**
 * Attack cooldown from the vanilla attack-speed attribute. No fixed millisecond
 * interval: a sword, an axe and a fist produce different cadences.
 */
export function attackCooldownMs(attackSpeed: number | undefined): number {
  const speed = attackSpeed !== undefined && Number.isFinite(attackSpeed) && attackSpeed > 0
    ? attackSpeed
    : 4
  return Math.max(250, Math.min(2_000, Math.round(1_000 / speed)))
}

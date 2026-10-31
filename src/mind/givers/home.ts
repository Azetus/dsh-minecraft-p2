import type { WorkGiver } from '../types.ts'
import type { Candidate, EvalCtx, WorldView } from '../types.ts'
import { feetOf, nearestStandable } from './common.ts'

export function isNight(timeOfDay: number): boolean {
  return timeOfDay >= 13_000 && timeOfDay < 23_000
}

/** Return home when the body has drifted farther than `radius` blocks. */
export function createGoHomeGiver(options: { radius?: number; nightRadius?: number } = {}): WorkGiver {
  const radius = options.radius ?? 16
  const nightRadius = options.nightRadius ?? 2
  return {
    id: 'goHome',
    find(ctx: EvalCtx, world: WorldView): Candidate | null {
      const home = ctx.home
      if (home === undefined) return null
      const pos = world.self.pos
      const night = isNight(world.time.timeOfDay)
      const limit = night ? nightRadius : radius
      if (Math.hypot(pos.x - home.x, pos.z - home.z) <= limit) return null
      return {
        driverId: 'move',
        target: { kind: 'point', pos: home },
        params: { x: home.x, y: home.y, z: home.z, range: night ? 1 : 2, timeoutMs: 15_000 },
        keys: `home:${night ? 'night' : 'day'}:${home.x},${home.y},${home.z}`,
      }
    },
  }
}

/** Pick a standable point within the wander radius of home; stand still at night. */
export function createWanderGiver(options: {
  radius?: number
  minDistance?: number
  cooldownMs?: number
  allowNight?: boolean
} = {}): WorkGiver {
  const radius = options.radius ?? 8
  const minDistance = options.minDistance ?? 3
  const cooldownMs = options.cooldownMs ?? 12_000
  const allowNight = options.allowNight ?? false
  let lastAt = Number.NEGATIVE_INFINITY
  return {
    id: 'wander',
    find(ctx: EvalCtx, world: WorldView): Candidate | null {
      if (!allowNight && isNight(world.time.timeOfDay)) return null
      if (ctx.now - lastAt < cooldownMs) return null
      const self = feetOf(world.self.pos)
      const home = ctx.home ?? self
      const baseAngle = ((ctx.now % 60_000) / 60_000) * Math.PI * 2
      const distance = minDistance + Math.floor((ctx.now / 60_000) % 4)
      for (const offset of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        const angle = baseAngle + offset
        const desired = {
          x: Math.round(home.x + Math.cos(angle) * distance),
          y: home.y,
          z: Math.round(home.z + Math.sin(angle) * distance),
        }
        const target = nearestStandable(world, home, radius, desired, 1)
        if (target === undefined) continue
        if (Math.hypot(target.x - home.x, target.z - home.z) > radius) continue
        if (Math.hypot(target.x - self.x, target.z - self.z) < 2) continue
        lastAt = ctx.now
        return {
          driverId: 'move',
          target: { kind: 'point', pos: target },
          params: { x: target.x, y: target.y, z: target.z, range: 1, timeoutMs: 10_000 },
          keys: `wander:${target.x},${target.y},${target.z}`,
        }
      }
      return null
    },
  }
}

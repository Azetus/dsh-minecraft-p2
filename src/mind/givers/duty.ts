import type { Vec3 } from '../../port/index.ts'
import type { AreaResourceIndex } from '../area.ts'
import type { DutyController } from '../duty.ts'
import type { Candidate, EvalCtx, Handoff, WorkGiver, WorkGiverResult, WorldView } from '../types.ts'

const REACH = 4.5

/**
 * Narrow standing WORK for D1: gather the duty's item to its quota. The giver
 * only selects a source; digging and pickup are normal driver work. Any active
 * order or plan suppresses this giver, so a duty never overrides the Agent.
 */
export function createDutyGiver(duty: DutyController, area: AreaResourceIndex): WorkGiver {
  return {
    id: 'duty.work',
    find(ctx: EvalCtx, world: WorldView): Candidate | Handoff | WorkGiverResult {
      if (!duty.canWork(ctx.orderVerb !== undefined, ctx.plan !== undefined)) return null
      duty.refresh(world.inventory, ctx.now)
      const spec = duty.spec()
      if (spec === undefined || duty.view(ctx.now)?.state !== 'active') return null
      if (!duty.canStartJob()) {
        duty.block('DUTY_JOB_BUDGET', ctx.now)
        return null
      }

      const self = world.self.pos
      area.update(self, ctx.now)
      if (!duty.canWork(ctx.orderVerb !== undefined, ctx.plan !== undefined)) return null
      const found = area.nearest(spec.item, self, spec.radius)
      if (found === undefined) {
        if (area.stale) return null
        duty.block('DUTY_NO_SOURCE', ctx.now)
        return null
      }

      const pos: Vec3 = { x: Math.floor(found.pos.x), y: Math.floor(found.pos.y), z: Math.floor(found.pos.z) }
      if (found.distance > REACH) {
        const handoff: Handoff = {
          driverId: 'move',
          target: { kind: 'point', pos },
          params: { x: pos.x, y: pos.y, z: pos.z, range: 4, intent: 'interact', timeoutMs: 8_000 },
          reason: `duty gather ${spec.item}`,
        }
        if (ctx.isBlocked?.(`duty:move:${spec.item}:${pos.x},${pos.y},${pos.z}`) === true) {
          duty.block('DUTY_WORK_BLOCKED', ctx.now)
          return null
        }
        return handoff
      }

      const keys = `duty:gather:${spec.item}:${pos.x},${pos.y},${pos.z}`
      if (ctx.isBlocked?.(keys) === true) {
        duty.block('DUTY_WORK_BLOCKED', ctx.now)
        return null
      }
      return {
        driverId: 'dig',
        target: { kind: 'point', pos },
        params: { x: pos.x, y: pos.y, z: pos.z, purpose: 'harvest' },
        keys,
      }
    },
  }
}

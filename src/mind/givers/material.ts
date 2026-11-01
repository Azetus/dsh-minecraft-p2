import type { Vec3 } from '../../port/index.ts'
import type { AreaResourceIndex } from '../area.ts'
import { materialSources, planShortage } from '../materials.ts'
import { itemPosition } from '../plan.ts'
import type { Candidate, EvalCtx, Handoff, WorkGiver, WorldView } from '../types.ts'

const SEARCH_RADIUS = 8
const REACH = 4.5

/**
 * Material giver for auto-gather orders. It only selects a source block; the
 * clear driver digs it and normal pickup/material accounting takes over.
 * Crafting and non-source items (doors, etc.) intentionally have no candidate.
 */
export function createMaterialGiver(area?: AreaResourceIndex): WorkGiver {
  return {
    id: 'material.gather',
    find(ctx: EvalCtx, world: WorldView): Candidate | Handoff | null {
      const plan = ctx.plan
      if (plan === undefined || ctx.materialPolicy?.mode !== 'auto-gather') return null
      const maxGather = ctx.materialPolicy.maxGatherBlocks
      if (maxGather !== undefined && (ctx.gatherCount ?? 0) >= maxGather) return null
      const shortage = planShortage(plan, world)
      if (Object.keys(shortage.missing).length === 0) return null

      const planPositions = new Set(plan.workItems
        .filter(item => item.expected !== undefined)
        .map(item => key(itemPosition(plan, item))))
      const self = world.self.pos
      area?.update(self, ctx.now)
      const nearby = area === undefined ? scanSnapshot(world) : undefined

      for (const [item, amount] of Object.entries(shortage.missing)) {
        if (amount <= 0) continue
        const sources = new Set(materialSources(item))
        if (sources.size === 0) continue
        const best = area === undefined
          ? nearestInSnapshot(nearby!, sources, planPositions, self)
          : nearestInArea(area, item, planPositions, self)
        if (best === undefined) continue
        if (best.distance > REACH) {
          const handoff: Handoff = {
            driverId: 'move',
            target: { kind: 'point', pos: best.pos },
            params: { x: best.pos.x, y: best.pos.y, z: best.pos.z, range: 4, intent: 'interact', timeoutMs: 8_000 },
            reason: `gather ${item}`,
            orderId: plan.orderId,
          }
          const handoffKey = `handoff:move:${best.pos.x},${best.pos.y},${best.pos.z}`
          if (ctx.isBlocked?.(handoffKey) === true) continue
          return handoff
        }
        const candidate: Candidate = {
          driverId: 'clear',
          target: { kind: 'point', pos: best.pos },
          params: { x: best.pos.x, y: best.pos.y, z: best.pos.z },
          keys: `gather:${item}:${best.pos.x},${best.pos.y},${best.pos.z}`,
          orderId: plan.orderId,
        }
        if (ctx.isBlocked?.(candidate.keys) === true) continue
        return candidate
      }
      return null
    },
  }
}

function scanSnapshot(world: WorldView): ReturnType<WorldView['blocksIn']> {
  const self = world.self.pos
  const box = {
    min: { x: Math.floor(self.x) - SEARCH_RADIUS, y: Math.floor(self.y) - SEARCH_RADIUS, z: Math.floor(self.z) - SEARCH_RADIUS },
    max: { x: Math.floor(self.x) + SEARCH_RADIUS, y: Math.floor(self.y) + SEARCH_RADIUS, z: Math.floor(self.z) + SEARCH_RADIUS },
  }
  return world.blocksIn(box).filter(block => block.loaded && block.pos !== undefined)
}

function nearestInSnapshot(
  blocks: ReturnType<WorldView['blocksIn']>,
  sources: Set<string>,
  planPositions: Set<string>,
  self: Vec3,
): { pos: Vec3; distance: number } | undefined {
  let best: { pos: Vec3; distance: number } | undefined
  for (const block of blocks) {
    if (block.pos === undefined || !sources.has(block.name) || planPositions.has(key(block.pos))) continue
    const distance = Math.hypot(
      block.pos.x + 0.5 - self.x,
      block.pos.y + 0.5 - (self.y + 1.5),
      block.pos.z + 0.5 - self.z,
    )
    if (best === undefined || distance < best.distance) best = { pos: block.pos, distance }
  }
  return best
}

function nearestInArea(
  area: AreaResourceIndex,
  item: string,
  planPositions: Set<string>,
  self: Vec3,
): { pos: Vec3; distance: number } | undefined {
  const found = area.nearest(item, self)
  if (found === undefined || planPositions.has(key(found.pos))) return undefined
  return found
}

function key(position: Vec3): string {
  return `${position.x},${position.y},${position.z}`
}

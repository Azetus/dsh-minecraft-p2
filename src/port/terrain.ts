import { isRecord } from '../contracts/protocol.ts'
import { AIR_NAMES, isLegacySolidName, vanillaClassifier } from '../motion/model/semantics/vanilla.ts'
import type { BlockTag, CollisionBox } from '../motion/model/types.ts'
import type { BlockInfo, Vec3 } from './types.ts'

/** Shared collision vocabulary; no client objects or pathfinder types. */
export type Standability = {
  state: 'valid' | 'unknown' | 'blocked' | 'unsafe'
  position?: Vec3
  reason?: string
  block?: { position: Vec3; name: string }
}

/** Dynamic, per-order authorization. A name is an expected state, not a rule
 * permitting all blocks of that material; unlisted coordinates are protected. */
export type UnstickBlock = Vec3 & { name: string }

/** Explicit per-pathfinder-call hazard permissions. The caller (Agent) is the
 * only place allowed to trade health/world safety for an escape. */
export const HAZARD_KINDS = ['void', 'lethal_fall', 'lava'] as const
export type HazardKind = (typeof HAZARD_KINDS)[number]
export type HazardPolicy = { allow: HazardKind[]; reason?: string }

/** Keep at least three hearts after a planned fall (1 HP per block past 3). */
export const MIN_HEALTH_AFTER_FALL = 6

/** Health-derived safe fall budget; 0..2 is always the normal walking policy. */
export function safeFallDistance(health: number): number {
  const hp = Number.isFinite(health) ? Math.max(0, Math.floor(health)) : 0
  return Math.max(2, hp - MIN_HEALTH_AFTER_FALL + 3)
}

/** undefined = absent; null = invalid. */
export function parseHazardPolicy(value: unknown): HazardPolicy | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  for (const key of Object.keys(value)) {
    if (key !== 'allow' && key !== 'reason') return null
  }
  if (!Array.isArray(value.allow) || value.allow.length === 0) return null
  const allow: HazardKind[] = []
  for (const entry of value.allow) {
    if (typeof entry !== 'string' || !(HAZARD_KINDS as readonly string[]).includes(entry)) return null
    if (!allow.includes(entry as HazardKind)) allow.push(entry as HazardKind)
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') return null
  return {
    allow,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  }
}

export function parseUnstickBlocks(value: unknown): UnstickBlock[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 2) return null
  const result: UnstickBlock[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || !['x', 'y', 'z'].every(k => Number.isInteger(entry[k]))
      || typeof entry.name !== 'string' || entry.name.length === 0) return null
    result.push({ x: entry.x, y: entry.y, z: entry.z, name: entry.name.replace(/^minecraft:/u, '') })
  }
  return result
}

export function unstickObstacle(read: (p: Vec3) => BlockInfo | null, at: Vec3, feet: Vec3, allowed: readonly UnstickBlock[]): string | undefined {
  const block = read(at)
  if (block === null || !block.loaded) return 'unloaded'
  if (!allowed.some(p => p.x === at.x && p.y === at.y && p.z === at.z && p.name === block.name)) return 'not-authorized'
  if (at.y < Math.floor(feet.y) || (at.x === Math.floor(feet.x) && at.z === Math.floor(feet.z) && at.y <= Math.floor(feet.y))) return 'footing'
  if (clearCell(block)) return 'not-an-obstacle'
  if (/chest|barrel|shulker|furnace|smoker|hopper|dropper|dispenser|brewing|enchant|beacon|spawner|bed|door|gate|sign|command_block|structure|jigsaw|portal/u.test(block.name)) return 'protected-block'
  if (!clearCell(read({ ...at, y: at.y + 1 }))) return 'load-bearing-or-ceiling-unknown'
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const neighbour = read({ x: at.x + dx, y: at.y + dy, z: at.z + dz })
    if (neighbour === null || !neighbour.loaded) return 'boundary-unloaded'
    if (isWaterBlock(neighbour) || isHazardBlock(neighbour) || neighbour.state?.waterlogged === 'true') return 'fluid-or-hazard-boundary'
    if (/torch|rail|ladder|redstone|lever|button|sign|scaffolding/u.test(neighbour.name)) return 'attached-structure'
  }
  return undefined
}

const FULL_CUBE_SHAPE = [[0, 0, 0, 1, 1, 1]]

/** Classify once per read; semantic tables are shared with the motion rules. */
function semanticTags(block: BlockInfo): readonly BlockTag[] {
  return vanillaClassifier.classify({
    loaded: block.loaded,
    name: block.name,
    state: block.state ?? {},
    ...(block.collision === undefined ? {} : { collision: block.collision as unknown as readonly CollisionBox[] }),
    ...(block.serverTags === undefined ? {} : { serverTags: block.serverTags }),
  })
}

export function isHazardBlock(block: BlockInfo | null): boolean {
  if (block === null || !block.loaded) return false
  const tags = semanticTags(block)
  return tags.includes('hazard') || tags.includes('lava')
}

export function isWaterBlock(block: BlockInfo | null): boolean {
  if (block === null || !block.loaded) return false
  return semanticTags(block).includes('water')
}

function shapes(block: BlockInfo): number[][] | undefined {
  if (block.collision !== undefined) return block.collision
  if (block.solid === false || AIR_NAMES.has(block.name)) return []
  if (block.solid === true || isLegacySolidName(block.name)) return FULL_CUBE_SHAPE
  return undefined
}

export function clearCell(block: BlockInfo | null): boolean {
  return block !== null && block.loaded && !isHazardBlock(block) && !isWaterBlock(block)
    && shapes(block)?.length === 0
}

/**
 * Only a same-height, cardinal jump across ONE cell. No sprint or planned deep
 * drop. A missed short jump may fall up to three blocks, but only onto a safe,
 * standable floor: lava, water, unloaded chunks and deeper cliffs are rejected.
 */
export const MAX_MISSED_JUMP_FALL = 3

export function safeOneGap(read: (p: Vec3) => BlockInfo | null, from: Vec3, to: Vec3): boolean {
  if (to.y !== from.y || Math.abs(to.x - from.x) + Math.abs(to.z - from.z) !== 2
    || (to.x !== from.x && to.z !== from.z)) return false
  const a = standingAt(read, from)
  const b = standingAt(read, to)
  if (a.state !== 'valid' || b.state !== 'valid' || a.position!.y !== from.y || b.position!.y !== to.y) return false
  const middle = { x: (from.x + to.x) / 2, y: from.y, z: (from.z + to.z) / 2 }
  if (!clearCell(read({ ...middle, y: middle.y - 1 }))) return false
  for (const p of [from, middle, to]) {
    // A full jump lifts a 1.8-high body slightly over the third cell.
    for (let dy = 0; dy <= 3; dy++) if (!clearCell(read({ ...p, y: p.y + dy }))) return false
  }
  // A missed jump must not mean lava, water, an unloaded chunk or a deep cliff.
  // The fall checks below include the body cells, so hazards above the floor
  // still reject a deeper candidate.
  for (let drop = 1; drop <= MAX_MISSED_JUMP_FALL; drop++) {
    if (standingAt(read, { ...middle, y: middle.y - drop }).state === 'valid') return true
  }
  return false
}

/** `cell` is a path node: feet above the supporting block, including slabs. */
export function standingAt(read: (p: Vec3) => BlockInfo | null, cell: Vec3): Standability {
  const p = { x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z) }
  const floor = { ...p, y: p.y - 1 }
  const support = read(floor)
  if (support === null || !support.loaded) return { state: 'unknown', reason: 'support-unloaded' }
  if (isHazardBlock(support) || isWaterBlock(support)) {
    return { state: 'unsafe', reason: 'unsafe-support', block: { position: floor, name: support.name } }
  }
  const supportShapes = shapes(support)
  if (supportShapes === undefined) return { state: 'unknown', reason: 'collision-unknown' }
  const tops = supportShapes.filter(s => s[0]! <= 0.5 && s[3]! >= 0.5 && s[2]! <= 0.5 && s[5]! >= 0.5)
  const height = Math.max(0, ...tops.map(s => s[4]!))
  if (height <= 0 || height > 1) return { state: 'blocked', reason: 'no-safe-support', block: { position: floor, name: support.name } }
  const feet = floor.y + height
  // 0.6 wide, 1.8 high. Include the support cell for partial-height blocks.
  for (let y = Math.floor(feet); y < feet + 1.8; y++) {
    const at = { ...p, y }
    const block = read(at)
    if (block === null || !block.loaded) return { state: 'unknown', reason: 'body-unloaded' }
    if (isHazardBlock(block) || isWaterBlock(block)) {
      return { state: 'unsafe', reason: 'unsafe-body', block: { position: at, name: block.name } }
    }
    const collision = shapes(block)
    if (collision === undefined) return { state: 'unknown', reason: 'collision-unknown' }
    if (collision.some(s => s[0]! < 0.8 && s[3]! > 0.2 && s[2]! < 0.8 && s[5]! > 0.2
      && y + s[1]! < feet + 1.8 - 0.001 && y + s[4]! > feet + 0.001)) {
      return { state: 'blocked', reason: 'body-collision', block: { position: at, name: block.name } }
    }
  }
  return { state: 'valid', position: { x: p.x + 0.5, y: feet, z: p.z + 0.5 } }
}

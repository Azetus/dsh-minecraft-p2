import type { BlockInfo, Vec3 } from './types.ts'

/** Shared collision vocabulary; no client objects or pathfinder types. */
export const WALK_HAZARDS: ReadonlySet<string> = new Set([
  'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush',
  'campfire', 'soul_campfire', 'powder_snow', 'wither_rose',
])

export type Standability = {
  state: 'valid' | 'unknown' | 'blocked' | 'unsafe'
  position?: Vec3
  reason?: string
  block?: { position: Vec3; name: string }
}

const AIR = new Set(['air', 'cave_air', 'void_air'])
const FULL_CUBES = new Set(['stone', 'dirt', 'grass_block', 'cobblestone', 'deepslate', 'sand', 'gravel'])

function shapes(block: BlockInfo): number[][] | undefined {
  if (block.collision !== undefined) return block.collision
  if (block.solid === false || AIR.has(block.name)) return []
  if (block.solid === true || FULL_CUBES.has(block.name) || /_(planks|log)$/u.test(block.name)) {
    return [[0, 0, 0, 1, 1, 1]]
  }
  return undefined
}

/** `cell` is a path node: feet above the supporting block, including slabs. */
export function standingAt(read: (p: Vec3) => BlockInfo | null, cell: Vec3): Standability {
  const p = { x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z) }
  const floor = { ...p, y: p.y - 1 }
  const support = read(floor)
  if (support === null || !support.loaded) return { state: 'unknown', reason: 'support-unloaded' }
  if (WALK_HAZARDS.has(support.name) || support.name === 'water') {
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
    if (WALK_HAZARDS.has(block.name) || block.name === 'water') {
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

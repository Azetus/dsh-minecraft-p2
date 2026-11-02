import type { Cell, Vec3 } from '../model/types.ts'

/** Horizontal distance from a continuous position to a cell's centre. */
export function distance2d(pos: Vec3, cell: Cell): number {
  return Math.hypot(pos.x - cell.x - 0.5, pos.z - cell.z - 0.5)
}

export function distance3d(pos: Vec3, cell: Cell): number {
  return Math.hypot(pos.x - cell.x - 0.5, pos.y - cell.y, pos.z - cell.z - 0.5)
}

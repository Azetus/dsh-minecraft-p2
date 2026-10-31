import type { Driver } from '../types.ts'
import { createMoveDriver } from './move.ts'

/**
 * `prepare` and `enter` share the movement toil: walk to the selected stand
 * cell. They keep distinct driver ids so plans and logs stay readable.
 */
export function createStepDriver(id: 'prepare' | 'enter'): Driver {
  return { ...createMoveDriver(), id }
}

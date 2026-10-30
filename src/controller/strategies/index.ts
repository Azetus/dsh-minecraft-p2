/**
 * Built-in strategy content. Strategies import the strategy port and shared
 * readers only; none of them imports the controller, which is what keeps the
 * "new content is mostly a strategy" claim checkable.
 */

export { createHarvestStrategy } from './harvest.ts'
export type { HarvestOptions } from './harvest.ts'
export { createWaterEscapeStrategy } from './water-escape.ts'
export type { WaterEscapeOptions } from './water-escape.ts'
export { createCreeperEscapeStrategy } from './creeper-escape.ts'
export type { CreeperEscapeOptions } from './creeper-escape.ts'
export { createFollowOwnerStrategy } from './follow-owner.ts'
export type { FollowOwnerOptions } from './follow-owner.ts'



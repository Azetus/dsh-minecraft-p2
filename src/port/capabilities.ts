import { p2Error } from '../contracts/protocol.ts'
import type { P2Error } from '../contracts/types.ts'
import { PortErrorCodes } from './types.ts'

/** Behavioural capabilities, never implementation names. */
export const CAPABILITIES = [
  'navigate',
  'interact',
  'observe.screen',
  'combat',
] as const

export type Capability = (typeof CAPABILITIES)[number]

/** Every port action whose missing capability must fail explicitly. */
export type ClientAction =
  | 'moveTo'
  | 'lookAt'
  | 'dig'
  | 'place'
  | 'useItem'
  | 'equip'
  | 'useOn'
  | 'attack'
  | 'sleep'
  | 'screen'
  | 'containerTransfer'

export const ACTION_CAPABILITIES: Record<ClientAction, Capability | null> = {
  moveTo: 'navigate',
  lookAt: null,
  dig: 'interact',
  place: 'interact',
  useItem: 'interact',
  equip: 'interact',
  useOn: 'interact',
  attack: 'combat',
  sleep: 'interact',
  screen: 'observe.screen',
  containerTransfer: 'interact',
}

export function actionCapability(action: ClientAction): Capability | null {
  return ACTION_CAPABILITIES[action]
}

/**
 * Return the structured error for an unsupported action, or undefined when the
 * port can perform it. Callers never fall back silently.
 */
export function checkCapability(available: readonly Capability[], action: ClientAction): P2Error | undefined {
  const needed = ACTION_CAPABILITIES[action]
  if (needed === null || available.includes(needed)) return undefined
  return p2Error(
    PortErrorCodes.CAPABILITY_MISSING,
    'capability',
    `port does not provide ${needed} for ${action}`,
    { module: 'port.capability' },
    { action, missing: needed },
  )
}

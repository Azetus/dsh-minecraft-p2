/**
 * Operation declarations owned by the P2 core.
 *
 * Names, kinds, effects, stop semantics and capabilities are the contract; a
 * provider only implements them. The M5.5 baseline extends the M5 set with the
 * operations a survival experiment needs (crafting, containers, trading,
 * sleeping, respawn) so that content can be written without touching core.
 */

import { p2Error } from '../contracts/protocol.ts'
import type { P2Error } from '../contracts/types.ts'

export type OperationKind = 'query' | 'control'

/** `active` means the operation can leave control input behind until stopped. */
export type OperationEffects = 'none' | 'active'

/** `poll` means the operation must be stopped explicitly and confirmed. */
export type OperationStop = 'none' | 'poll'

export type OperationContract = {
  id: string
  kind: OperationKind
  effects: OperationEffects
  stop: OperationStop
  capabilities: string[]
  /** May run alongside one exclusive control (for example `jump` before `place`). */
  concurrent?: boolean
  /** Authored-op execution budget; absent means the broker imposes no deadline. */
  limits?: { totalMs?: number }
}

export const OPERATION_CONTRACT_VERSION = '4'

export const OPERATION_CONTRACTS: readonly OperationContract[] = Object.freeze([
  // Queries: read-only observations. They never change world state.
  { id: 'position', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'inventory', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'health', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'entities', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'blocks', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'block', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'time', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'equipment', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'entity', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'players', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'recipe', kind: 'query', effects: 'none', stop: 'none', capabilities: ['craft'] },
  { id: 'container', kind: 'query', effects: 'none', stop: 'none', capabilities: ['container'] },
  { id: 'offers', kind: 'query', effects: 'none', stop: 'none', capabilities: ['trade'] },
  { id: 'weather', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },

  // Controls: actions. At most one is active at a time in one run.
  { id: 'look', kind: 'control', effects: 'none', stop: 'none', capabilities: ['look'] },
  { id: 'lookAt', kind: 'control', effects: 'none', stop: 'none', capabilities: ['look'] },
  { id: 'move', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['move'] },
  { id: 'forward', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['move'] },
  { id: 'back', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['move'] },
  { id: 'left', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['move'] },
  { id: 'right', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['move'] },
  { id: 'jump', kind: 'control', effects: 'none', stop: 'none', capabilities: ['move'], concurrent: true },
  { id: 'pillar', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['move', 'place'] },
  { id: 'moveTo', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['move'] },
  { id: 'goto', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['pathfind'] },
  { id: 'follow', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['pathfind'] },
  { id: 'stop', kind: 'control', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'dig', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['dig'] },
  { id: 'place', kind: 'control', effects: 'none', stop: 'none', capabilities: ['place'] },
  { id: 'replace', kind: 'control', effects: 'none', stop: 'none', capabilities: ['place'] },
  { id: 'attack', kind: 'control', effects: 'none', stop: 'none', capabilities: ['attack'] },
  { id: 'equip', kind: 'control', effects: 'none', stop: 'none', capabilities: ['equip'] },
  { id: 'unequip', kind: 'control', effects: 'none', stop: 'none', capabilities: ['equip'] },
  { id: 'use', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['use'] },
  { id: 'consume', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['use'] },
  { id: 'craft', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['craft'] },
  { id: 'container-transfer', kind: 'control', effects: 'none', stop: 'none', capabilities: ['container'] },
  { id: 'toss', kind: 'control', effects: 'none', stop: 'none', capabilities: ['toss'] },
  { id: 'respawn', kind: 'control', effects: 'none', stop: 'poll', capabilities: [] },
  { id: 'sleep', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['sleep'] },
  { id: 'interact', kind: 'control', effects: 'none', stop: 'none', capabilities: ['interact'] },
  { id: 'activate', kind: 'control', effects: 'none', stop: 'none', capabilities: ['interact'] },
  { id: 'mount', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['mount'] },
  { id: 'dismount', kind: 'control', effects: 'none', stop: 'none', capabilities: ['mount'] },
  { id: 'drive', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['mount'] },
  { id: 'place-entity', kind: 'control', effects: 'none', stop: 'none', capabilities: ['place'] },
  { id: 'fish', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['use'] },
  { id: 'trade', kind: 'control', effects: 'none', stop: 'none', capabilities: ['trade'] },
])

const CONTRACTS = new Map(OPERATION_CONTRACTS.map(contract => [contract.id, contract]))

/**
 * Developer-mode operations (see `src/body/dev-ops.ts`). They live outside the
 * compiled bundle so a new operation can be added without a rebuild. Released
 * builds never register any, and the list stays empty by default.
 */
let externalOperations: readonly OperationContract[] = []

export function setExternalOperations(contracts: readonly OperationContract[]): void {
  externalOperations = [...contracts]
}

export function externalOperationIds(): string[] {
  return externalOperations.map(contract => contract.id)
}

export function operationContract(id: string): OperationContract | undefined {
  return CONTRACTS.get(id) ?? externalOperations.find(contract => contract.id === id)
}

export function operationIds(kind?: OperationKind): string[] {
  return OPERATION_CONTRACTS
    .filter(contract => kind === undefined || contract.kind === kind)
    .map(contract => contract.id)
}

/** Validate that `id` exists and belongs to the expected kind. */
export function requireOperation(id: string, kind: OperationKind, module: string): OperationContract {
  const contract = operationContract(id)
  if (contract === undefined) {
    throw p2Error('UNKNOWN_OP', 'validation', `unknown operation: ${id}`, { module }, { operation: id })
  }
  if (contract.kind !== kind) {
    throw p2Error(
      'OP_KIND_MISMATCH',
      'validation',
      `operation ${id} is ${contract.kind}, not ${kind}`,
      { module },
      { operation: id, expected: kind, actual: contract.kind },
    )
  }
  return contract
}

/** Fail closed when the connected provider never declared an operation capability. */
export function requireCapability(contract: OperationContract, available: readonly string[], module: string): void {
  const missing = contract.capabilities.filter(capability => !available.includes(capability))
  if (missing.length === 0) return
  throw p2Error(
    'CAPABILITY_MISSING',
    'capability',
    `provider does not declare ${missing.join(', ')} for operation ${contract.id}`,
    { module, opId: contract.id },
    { operation: contract.id, missing },
  )
}

export function asP2Error(error: unknown, module: string): P2Error {
  if (typeof error === 'object' && error !== null && typeof (error as P2Error).code === 'string') {
    return error as P2Error
  }
  return p2Error('OP_FAILED', 'runtime', error instanceof Error ? error.message : String(error), { module })
}



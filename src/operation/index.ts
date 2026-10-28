/**
 * Operation declarations owned by the P2 core.
 *
 * Names, kinds, effects and stop semantics are the contract; a provider only
 * implements them. The first version declares the operations the executor and
 * the M5 validation scenarios need; new operations are added by maintainers.
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
}

export const OPERATION_CONTRACT_VERSION = '1'

export const OPERATION_CONTRACTS: readonly OperationContract[] = Object.freeze([
  { id: 'position', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'inventory', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'entities', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'time', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'block', kind: 'query', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'look', kind: 'control', effects: 'none', stop: 'none', capabilities: ['look'] },
  { id: 'move', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['move'] },
  { id: 'jump', kind: 'control', effects: 'none', stop: 'none', capabilities: ['move'] },
  { id: 'moveTo', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['move'] },
  { id: 'stop', kind: 'control', effects: 'none', stop: 'none', capabilities: [] },
  { id: 'dig', kind: 'control', effects: 'active', stop: 'poll', capabilities: ['dig'] },
])

const CONTRACTS = new Map(OPERATION_CONTRACTS.map(contract => [contract.id, contract]))

export function operationContract(id: string): OperationContract | undefined {
  return CONTRACTS.get(id)
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

export function asP2Error(error: unknown, module: string): P2Error {
  if (typeof error === 'object' && error !== null && typeof (error as P2Error).code === 'string') {
    return error as P2Error
  }
  return p2Error('OP_FAILED', 'runtime', error instanceof Error ? error.message : String(error), { module })
}

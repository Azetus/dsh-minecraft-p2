import type { WriteToken } from '../body/api.ts'

/**
 * One Driver execution's write authority.
 *
 * The JobTracker creates a scope together with the write token and hands the
 * driver a body view bound to it (see `scoped-body.ts`). Revocation is
 * one-way: after `revokeScope` the same execution can never write again, no
 * matter when its async code resumes. There is deliberately no un-revoke.
 */
export type RunScope = {
  readonly token: WriteToken
  revoked: boolean
  /** How many write calls were refused after revocation (diagnostics only). */
  rejected: number
}

export function createScope(token: WriteToken): RunScope {
  return { token, revoked: false, rejected: 0 }
}

/**
 * Revoke one execution's authority. Idempotent: a second call is a no-op and
 * there is no path back to an active scope.
 */
export function revokeScope(scope: RunScope): void {
  scope.revoked = true
}

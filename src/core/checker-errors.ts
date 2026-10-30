/** Shared checker identity and error type for act/policy/op/strategy artifacts. */

export const CHECKER_VERSION = '0.1.0'

export type CheckerCredential = {
  checkerVersion: string
  bindingId: string
  network: false
  builtinsDigest: string
}

export class CheckerError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CheckerError'
    this.code = code
  }
}



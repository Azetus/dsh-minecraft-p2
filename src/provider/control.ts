import { p2Error } from '../contracts/protocol.ts'
import type { P2Error } from '../contracts/types.ts'
import { BodyErrorCodes, type ActResult, type WriteToken } from '../body/api.ts'

/**
 * Single-writer authority. The JobTracker issues one token per run; the body
 * captures `currentEpoch()` before doing async work and drops the result when
 * `isCurrent(epoch)` is false.
 */
export class WriteGate {
  private active: WriteToken | undefined
  private authority = 0
  private stale = 0

  /** Acquire or renew the authority. An older token is rejected as STALE_WRITE. */
  begin(token: WriteToken): number {
    if (this.active !== undefined && sameToken(this.active, token)) return this.authority
    if (this.active !== undefined && token.seq <= this.active.seq) {
      throw this.reject(token)
    }
    this.active = { ...token }
    this.authority += 1
    return this.authority
  }

  /** Release the authority. Only the current token may release it. */
  end(token: WriteToken): void {
    if (this.active === undefined || !sameToken(this.active, token)) {
      throw this.reject(token)
    }
    this.active = undefined
    this.authority += 1
  }

  /** Epoch of the active authority, or undefined when no writer holds it. */
  currentEpoch(): number | undefined {
    return this.active === undefined ? undefined : this.authority
  }

  isCurrent(epoch: number): boolean {
    return this.active !== undefined && this.authority === epoch
  }

  token(): WriteToken | undefined {
    return this.active === undefined ? undefined : { ...this.active }
  }

  staleWrites(): number {
    return this.stale
  }

  private reject(actual: WriteToken): P2Error {
    this.stale += 1
    const active = this.active
    return p2Error(
      BodyErrorCodes.STALE_WRITE,
      'control',
      'write token does not match the active authority',
      { module: 'body.write' },
      {
        runId: actual.runId,
        jobId: actual.jobId,
        seq: actual.seq,
        active: active === undefined
          ? null
          : { runId: active.runId, jobId: active.jobId, seq: active.seq },
      },
    )
  }
}

/** The body-level result for a write attempted without an authority. */
export function staleWriteResult(elapsedMs: number): ActResult {
  return {
    state: 'failed',
    code: BodyErrorCodes.STALE_WRITE,
    elapsedMs,
  }
}

function sameToken(left: WriteToken, right: WriteToken): boolean {
  return left.runId === right.runId && left.jobId === right.jobId && left.seq === right.seq
}

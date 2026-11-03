import type { JsonValue } from '../../contracts/types.ts'
import type { DriverHandle, DriverResult } from '../types.ts'
import { failureBody, providerFailureSuggestions, withFailure } from '../failure.ts'

/** Async driver handle: completion is the promise, stop is observe-only. */
export class AsyncDriverHandle implements DriverHandle {
  private resultValue: DriverResult = { state: 'running' }
  private stopRequested = false
  private settled = false
  private releaseUnconfirmed = false

  constructor(
    private readonly key: string,
    work: Promise<DriverResult>,
  ) {
    void work.then(
      result => {
        this.settled = true
        this.releaseUnconfirmed = result.code === 'STOP_UNCONFIRMED'
        this.resultValue = this.stopRequested ? { state: 'interrupted' } : result
      },
      error => {
        this.settled = true
        this.releaseUnconfirmed = true
        this.resultValue = {
          state: this.stopRequested ? 'interrupted' : 'failed',
          code: errorCode(error),
        }
      },
    )
  }

  tick(): void {
    // The driver's work is bounded inside its promise; tick stays cheap.
  }

  requestStop(): void {
    this.stopRequested = true
  }

  stopStatus(): 'stopping' | 'stopped' | 'unconfirmed' {
    if (!this.stopRequested) return 'stopping'
    if (this.releaseUnconfirmed) return 'unconfirmed'
    return this.settled ? 'stopped' : 'stopping'
  }

  result(): DriverResult {
    return this.resultValue
  }

  continuationKey(): string {
    return this.key
  }
}

export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : 'DRIVER_FAULT'
}

/**
 * Port failure as a driver failure. `observed` is the provider's evidence
 * (timeout control state, release verdict, elapsed); dropping it would leave
 * the job terminal unable to say which layer failed and why.
 */
export function actFailure(
  result: { state: 'ok' | 'failed' | 'unknown'; code?: string; observed?: JsonValue },
  fallback: string,
): DriverResult {
  const code = result.code ?? (result.state === 'unknown' ? 'ACT_UNCONFIRMED' : fallback)
  const providerFailure = code === 'ACT_TIMEOUT'
    || code === 'ACT_UNCONFIRMED'
    || code === 'STOP_UNCONFIRMED'
    || code === 'ACTION_DENIED'
    || code === 'CLIENT_TIMEOUT'
  const observed = withFailure(result.observed, failureBody({
    layer: providerFailure ? 'port' : 'driver',
    phase: providerFailure ? 'execute' : 'unknown',
    code,
    observed: result.observed,
    cause: {
      kind: providerFailure
        ? code === 'STOP_UNCONFIRMED' ? 'authority' : 'provider'
        : 'world',
      code,
    },
    recovery: code === 'ACT_TIMEOUT'
      ? { kind: 'retry' }
      : code === 'STOP_UNCONFIRMED'
        ? { kind: 'restart' }
        : providerFailure
          ? { kind: 'reobserve' }
          : { kind: 'none' },
    ...(providerFailure ? { suggestions: providerFailureSuggestions(code) } : {}),
  }))
  return { state: 'failed', code, observed }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

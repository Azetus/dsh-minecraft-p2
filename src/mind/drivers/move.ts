import type { ActResult } from '../../port/index.ts'
import type { SchemaNode } from '../schema.ts'
import type {
  Driver,
  DriverCtx,
  DriverHandle,
  DriverResult,
  DriverValidation,
  Job,
  WorldView,
} from '../types.ts'

export const MOVE_DRIVER_ID = 'move'

const MOVE_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    range: { type: 'number', minimum: 0 },
    timeoutMs: { type: 'integer', minimum: 1 },
  },
  required: ['x', 'y', 'z'],
  additionalProperties: false,
}

type MoveParams = {
  x: number
  y: number
  z: number
  range?: number
  timeoutMs?: number
}

/**
 * The M1 movement driver: one bounded `ClientPort.moveTo` per job. It never
 * chooses the target; the giver already did.
 */
export function createMoveDriver(): Driver {
  return {
    id: MOVE_DRIVER_ID,
    schema: MOVE_SCHEMA,
    defaults: {
      // 400 game ticks / 30 wall seconds is enough for a local walk and short
      // enough that a stuck path does not hold the tracker.
      budget: { maxTicks: 400, maxWallMs: 30_000 },
      interrupt: 'constant-only',
      suspendable: true,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as MoveParams
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !Number.isFinite(params.z)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx): DriverHandle {
      const params = job.params as unknown as MoveParams
      const range = params.range ?? 1
      const timeoutMs = params.timeoutMs ?? job.budget.maxWallMs
      const keys = `move:${params.x},${params.y},${params.z},${range}`
      const promise = ctx.port.moveTo(
        { x: params.x, y: params.y, z: params.z },
        { range, timeoutMs },
      )
      return new MoveHandle(keys, promise)
    },
  }
}

class MoveHandle implements DriverHandle {
  private resultValue: DriverResult = { state: 'running' }
  private stopRequested = false
  private settled = false

  constructor(
    private readonly keys: string,
    promise: Promise<ActResult>,
  ) {
    void promise.then(
      result => {
        this.settled = true
        this.resultValue = this.stopRequested
          ? { state: 'interrupted' }
          : toDriverResult(result)
      },
      error => {
        this.settled = true
        this.resultValue = {
          state: this.stopRequested ? 'interrupted' : 'failed',
          code: errorCode(error),
        }
      },
    )
  }

  tick(): void {
    // Completion is delivered by the port promise; tick stays bounded.
  }

  requestStop(): void {
    this.stopRequested = true
  }

  stopStatus(): 'stopping' | 'stopped' | 'unconfirmed' {
    if (!this.stopRequested) return 'stopping'
    return this.settled ? 'stopped' : 'stopping'
  }

  result(): DriverResult {
    return this.resultValue
  }

  continuationKey(): string {
    return this.keys
  }
}

function toDriverResult(result: ActResult): DriverResult {
  if (result.state === 'ok') {
    return result.observed === undefined
      ? { state: 'succeeded' }
      : { state: 'succeeded', observed: result.observed }
  }
  if (result.state === 'unknown') {
    // `unknown` is never success: the driver reports failure with the reason.
    return { state: 'failed', code: result.code ?? 'CLIENT_TIMEOUT' }
  }
  return { state: 'failed', code: result.code ?? 'ACT_FAILED' }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : 'DRIVER_FAULT'
}

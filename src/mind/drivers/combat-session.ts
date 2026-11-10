import type { JsonValue } from '../../contracts/types.ts'
import type { CombatPort, MeleeOptions, MeleeResult } from '../../motion/combat/types.ts'
import { CombatSession } from '../../motion/combat/session.ts'
import type { DriverHandle, DriverResult } from '../types.ts'

export type CombatPrep = {
  port: CombatPort
  targetId: string
  options: MeleeOptions
  shieldAutoEquip?: MeleeResult['observed']['shieldAutoEquip']
}

/**
 * The attack driver's tick handle. The one-time equip prep runs before the
 * session starts; after that the mind loop's 50ms tick is the only clock.
 */
export class CombatSessionHandle implements DriverHandle {
  private session: CombatSession | undefined
  private resultValue: DriverResult = { state: 'running' }
  private stopRequested = false
  private settled = false
  private shieldAutoEquip: MeleeResult['observed']['shieldAutoEquip']

  constructor(
    private readonly key: string,
    prep: Promise<CombatPrep>,
  ) {
    void prep.then(
      ready => {
        this.shieldAutoEquip = ready.shieldAutoEquip
        if (this.stopRequested) {
          this.resultValue = { state: 'interrupted' }
          this.settled = true
          return
        }
        this.session = new CombatSession(ready.port, ready.targetId, ready.options)
      },
      (error: unknown) => {
        this.resultValue = {
          state: this.stopRequested ? 'interrupted' : 'failed',
          code: errorCode(error),
        }
        this.settled = true
      },
    )
  }

  tick(): void {
    this.session?.tick()
    if (this.session === undefined) return
    const result = this.session.result()
    if (result === undefined) {
      this.resultValue = { state: 'running' }
      return
    }
    this.resultValue = {
      state: result.state,
      ...(result.code === undefined ? {} : { code: result.code }),
      observed: {
        ...result.observed,
        ...(this.shieldAutoEquip === undefined ? {} : { shieldAutoEquip: this.shieldAutoEquip }),
      } as unknown as JsonValue,
    }
    this.settled = true
  }

  requestStop(): void {
    this.stopRequested = true
    this.session?.requestStop()
    if (this.resultValue.state === 'running') {
      this.resultValue = { state: 'interrupted' }
      this.settled = true
    }
  }

  stopStatus(): 'stopping' | 'stopped' | 'unconfirmed' {
    if (!this.stopRequested) return 'stopping'
    return this.settled ? 'stopped' : 'stopping'
  }

  result(): DriverResult {
    return this.resultValue
  }

  continuationKey(): string {
    return this.key
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : 'ATTACK_PREP_FAILED'
}

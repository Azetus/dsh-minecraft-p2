/** Bounded normal-work slots; stop/heartbeat/status are intentionally outside it. */
export class WorkQuota {
  private active = 0
  private readonly max: number

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 0) throw new Error('quota max must be a non-negative integer')
    this.max = max
  }

  get inUse(): number {
    return this.active
  }

  tryAcquire(): boolean {
    if (this.active >= this.max) return false
    this.active += 1
    return true
  }

  release(): void {
    if (this.active > 0) this.active -= 1
  }
}



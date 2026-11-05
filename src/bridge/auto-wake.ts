import type { StatusResult } from '../contracts/index.ts'
import type { AutoWakeConfig } from './workspace.ts'

export type AutoWakeActivity = {
  ordersAccepted: number | null
  dutyId: string | null
}

export type AutoWakeGateInput = {
  now: number
  config: AutoWakeConfig
  bodyState: 'inactive' | 'starting' | 'active' | 'stopping' | 'faulted'
  agentStatus: 'idle' | 'running'
  ownerPresent: boolean
  status: StatusResult | undefined
  pendingWake: boolean
  goalActive: boolean
  lastWake: AutoWakeActivity | undefined
}

export type AutoWakeGateResult =
  | { ok: true; summary: string; snapshot: AutoWakeActivity }
  | { ok: false; reason: string; backoff?: boolean; activity?: boolean }

export type AutoWakeLogEntry = {
  at: number
  action: 'skip' | 'wake' | 'error'
  reason: string
  silenceMs: number
  delayMs: number
  text?: string
}

export type AutoWakeTickResult = {
  action: AutoWakeLogEntry['action']
  reason: string
  delayMs: number
}

export type AutoWakeSchedulerOptions = {
  config: AutoWakeConfig
  getAgentStatus: () => 'idle' | 'running' | 'missing'
  probe: (lastWake: AutoWakeActivity | undefined) => Promise<AutoWakeGateResult>
  wake: (text: string) => boolean
  log: (entry: AutoWakeLogEntry) => void
  now?: () => number
  tickMs?: number
  schedule?: (callback: () => void, delayMs: number) => unknown
  clearSchedule?: (handle: unknown) => void
}

/**
 * Silence-driven wake. The scheduler only decides when to offer the owner
 * agent a turn; it never decides what the agent may do. All authorization is
 * the agent's own and the tools' existing semantics.
 */
export class AutoWakeScheduler {
  private readonly now: () => number
  private readonly tickMs: number
  private readonly scheduleFn: (callback: () => void, delayMs: number) => unknown
  private readonly clearFn: (handle: unknown) => void
  private timer: unknown
  private stopped = true
  private running = false
  private idleSince: number | undefined
  private currentSilenceMs: number
  private lastWake: AutoWakeActivity | undefined
  private dayKey = ''
  private wakeCount = 0

  constructor(private readonly options: AutoWakeSchedulerOptions) {
    this.now = options.now ?? Date.now
    this.tickMs = options.tickMs ?? 60_000
    this.currentSilenceMs = options.config.silenceMs
    this.scheduleFn = options.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      timer.unref?.()
      return timer
    })
    this.clearFn = options.clearSchedule ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  get silenceMs(): number {
    return this.currentSilenceMs
  }

  get wakeTotal(): number {
    return this.wakeCount
  }

  start(): void {
    if (!this.stopped) return
    if (!this.options.config.enabled) return
    this.stopped = false
    this.idleSince = undefined
    this.scheduleNext()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.clearFn(this.timer)
      this.timer = undefined
    }
  }

  /** Exposed for deterministic tests; starts no timers. */
  async tick(): Promise<AutoWakeTickResult> {
    if (this.stopped) return { action: 'skip', reason: 'stopped', delayMs: this.tickMs }
    if (this.running) return { action: 'skip', reason: 'reentrant', delayMs: this.tickMs }
    this.running = true
    try {
      return await this.runTick()
    } finally {
      this.running = false
    }
  }

  private async runTick(): Promise<AutoWakeTickResult> {
    const now = this.now()
    this.rollDay(now)
    const status = this.options.getAgentStatus()
    if (status !== 'idle') {
      this.idleSince = undefined
      return this.skip('agent-' + status, now, false)
    }
    if (this.idleSince === undefined) {
      this.idleSince = now
      return this.skip('silence-started', now, false)
    }
    if (now - this.idleSince < this.currentSilenceMs) {
      return this.skip('silence-pending', now, false)
    }
    if (inQuietHours(this.options.config.quietHours, new Date(now).getHours())) {
      return this.skip('quiet-hours', now, true)
    }
    if (this.options.config.dailyCap > 0 && this.wakeCount >= this.options.config.dailyCap) {
      return this.skip('daily-cap', now, true)
    }
    let gate: AutoWakeGateResult
    try {
      gate = await this.options.probe(this.lastWake)
    } catch (error) {
      return this.skip(`probe-error:${formatError(error)}`, now, true)
    }
    if (!gate.ok) {
      if (gate.activity === true) {
        this.lastWake = undefined
        this.currentSilenceMs = this.options.config.silenceMs
        return this.skip('activity', now, true)
      }
      if (gate.backoff === true) {
        this.currentSilenceMs = Math.min(
          this.options.config.silenceMs * 4,
          this.currentSilenceMs * 2,
        )
        return this.skip('idle-noop', now, true)
      }
      return this.skip(gate.reason, now, true)
    }
    const text = formatAutoWake(this.currentSilenceMs, gate.summary)
    let sent: boolean
    try {
      sent = this.options.wake(text)
    } catch (error) {
      return this.skip(`wake-error:${formatError(error)}`, now, true)
    }
    if (!sent) return this.skip('wake-failed', now, true)
    this.lastWake = gate.snapshot
    this.currentSilenceMs = this.options.config.silenceMs
    this.wakeCount += 1
    this.idleSince = undefined
    const entry: AutoWakeLogEntry = {
      at: now,
      action: 'wake',
      reason: 'ok',
      silenceMs: this.currentSilenceMs,
      delayMs: this.tickMs,
      text,
    }
    this.options.log(entry)
    return { action: 'wake', reason: 'ok', delayMs: this.tickMs }
  }

  private skip(reason: string, now: number, logIt: boolean): AutoWakeTickResult {
    if (logIt) {
      this.options.log({
        at: now,
        action: 'skip',
        reason,
        silenceMs: this.currentSilenceMs,
        delayMs: this.tickMs,
      })
    }
    return { action: 'skip', reason, delayMs: this.tickMs }
  }

  private scheduleNext(): void {
    if (this.stopped) return
    this.timer = this.scheduleFn(() => {
      this.timer = undefined
      void this.tick().finally(() => this.scheduleNext())
    }, this.tickMs)
  }

  private rollDay(now: number): void {
    const key = new Date(now).toDateString()
    if (key === this.dayKey) return
    this.dayKey = key
    this.wakeCount = 0
  }
}

export function evaluateAutoWakeGate(input: AutoWakeGateInput): AutoWakeGateResult {
  if (!input.config.enabled) return { ok: false, reason: 'disabled' }
  if (!input.ownerPresent) return { ok: false, reason: 'no-owner' }
  if (input.bodyState !== 'active') return { ok: false, reason: 'body-' + input.bodyState }
  if (input.agentStatus !== 'idle') return { ok: false, reason: 'agent-' + input.agentStatus }
  if (input.pendingWake) return { ok: false, reason: 'pending-wake' }
  const status = input.status
  if (status === undefined) return { ok: false, reason: 'no-status' }
  if (status.health !== 'ready') return { ok: false, reason: 'body-not-ready' }
  if (status.connection !== 'connected') return { ok: false, reason: 'disconnected' }
  if (status.providerState?.paused === true) return { ok: false, reason: 'paused' }
  const mind = status.mind
  if (mind === undefined || mind === null) return { ok: false, reason: 'no-mind' }
  if (mind.suspended === true) return { ok: false, reason: 'suspended' }
  if (mind.activity?.layer === 'constant') return { ok: false, reason: 'danger' }
  if (input.config.skipActiveWork) {
    if (mind.activeOrder !== null || mind.queuedOrders > 0) return { ok: false, reason: 'active-order' }
    if (mind.plan !== null && mind.plan !== undefined && !mind.plan.satisfied) {
      return { ok: false, reason: 'active-plan' }
    }
    if (mind.duty !== null && mind.duty !== undefined
      && mind.duty.state !== 'completed' && mind.duty.state !== 'cancelled') {
      return { ok: false, reason: 'active-duty' }
    }
    if (input.goalActive) return { ok: false, reason: 'active-goal' }
  }
  if (input.config.noOpBackoff && input.lastWake !== undefined) {
    const snapshot = activityOf(mind)
    if (snapshot.ordersAccepted !== null && snapshot.ordersAccepted === input.lastWake.ordersAccepted
      && snapshot.dutyId === input.lastWake.dutyId) {
      return { ok: false, reason: 'idle-noop', backoff: true }
    }
    if (snapshot.ordersAccepted !== null) {
      return { ok: false, reason: 'activity', activity: true }
    }
  }
  return {
    ok: true,
    summary: summarize(status, input.goalActive),
    snapshot: activityOf(mind),
  }
}

export function formatAutoWake(silenceMs: number, summary: string): string {
  return [
    '[p2 auto-wake]',
    `你已静默约 ${formatDuration(silenceMs)}。这是 runtime 自动唤醒，不是人类指令。`,
    '你的角色关系由人格文本定义；本次是否行动、说话、等待、拒绝或什么都不做，由你决定。',
    `门控摘要：${summary}`,
    '需要时读 p2_status；需要人类输入可以问；不需要就不必说话。',
    '如果行动，使用现有 p2_order/p2_duty；P2Mind 执行。',
  ].join('\n')
}

function activityOf(mind: NonNullable<StatusResult['mind']>): AutoWakeActivity {
  return {
    ordersAccepted: mind.metrics?.orders.accepted ?? null,
    dutyId: mind.duty?.id ?? null,
  }
}

function summarize(status: StatusResult, goalActive: boolean): string {
  const mind = status.mind
  const orders = mind === null || mind === undefined
    ? 'none'
    : `${mind.activeOrder === null ? 0 : 1}/${mind.queuedOrders}`
  const duty = mind?.duty === null || mind?.duty === undefined ? 'none' : `${mind.duty.kind}:${mind.duty.state}`
  const base = mind?.baseActivity === null || mind?.baseActivity === undefined
    ? 'unknown'
    : `${mind.baseActivity.kind}:${mind.baseActivity.state}`
  return [
    'body=active',
    `epoch=${status.bodyEpoch}`,
    `orders=${orders}`,
    `duty=${duty}`,
    `base=${base}`,
    `goal=${goalActive ? 'active' : 'none'}`,
  ].join(' ')
}

function inQuietHours(quiet: AutoWakeConfig['quietHours'], hour: number): boolean {
  if (quiet === null) return false
  if (quiet.start === quiet.end) return false
  return quiet.start < quiet.end
    ? hour >= quiet.start && hour < quiet.end
    : hour >= quiet.start || hour < quiet.end
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.round(minutes / 60 * 10) / 10
  return `${hours} 小时`
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

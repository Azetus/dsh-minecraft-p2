import { describe, expect, it } from 'vitest'

import {
  AutoWakeScheduler,
  evaluateAutoWakeGate,
  formatAutoWake,
} from '../src/bridge/auto-wake.ts'
import type { AutoWakeGateResult } from '../src/bridge/auto-wake.ts'
import type { AutoWakeConfig } from '../src/bridge/workspace.ts'
import type { AutoWakeLogEntry } from '../src/bridge/auto-wake.ts'
import { DEFAULT_AUTO_WAKE } from '../src/bridge/workspace.ts'
import type { MindStatusView, StatusResult } from '../src/contracts/protocol.ts'

function status(
  mind: Partial<MindStatusView> = {},
  top: Partial<StatusResult> = {},
): StatusResult {
  return {
    bodyEpoch: 'epoch-1' as StatusResult['bodyEpoch'],
    version: '0.1.5',
    owner: { sessionId: 's', agentId: 'a', cwd: 'c' },
    health: 'ready',
    connection: 'connected',
    bindingId: null,

    provider: null,
    ...top,
    mind: {
      tracker: 'idle',
      job: null,
      fault: null,
      home: null,
      activeOrder: null,
      queuedOrders: 0,
      eventsSeq: 0,
      plan: null,
      duty: null,
      baseActivity: { kind: 'wandering', state: 'active', params: { radius: 8 }, waitingReason: null },
      activity: { layer: 'base', kind: 'wandering', state: 'active', pausedBy: null },
      reaction: null,
      metrics: {
        orders: { accepted: 0, succeeded: 0, failed: 0, blocked: 0, cancelled: 0 },
        jobs: { started: 0, succeeded: 0, failed: 0, interrupted: 0, retried: 0, preempted: 0 },
        holds: 0,
        holdReasons: {},
        failureCodes: {},
        completionRate: null,
        lastFailure: null,
        updatedAt: 0,
      },
      ...mind,
    },
  }
}

function input(overrides: Partial<Parameters<typeof evaluateAutoWakeGate>[0]> = {}) {
  return {
    now: 1_000,
    config: { ...DEFAULT_AUTO_WAKE },
    bodyState: 'active' as const,
    agentStatus: 'idle' as const,
    ownerPresent: true,
    status: status(),
    pendingWake: false,
    goalActive: false,
    lastWake: undefined,
    ...overrides,
  }
}

describe('auto-wake gate', () => {
  it('passes for an idle owner with no pending work', () => {
    const result = evaluateAutoWakeGate(input())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.summary).toContain('body=active')
      expect(result.summary).toContain('orders=0/0')
      expect(result.snapshot).toEqual({ ordersAccepted: 0, dutyId: null })
    }
  })

  it('skips a disabled scheduler, missing owner and non-active body', () => {
    expect(evaluateAutoWakeGate(input({ config: { ...DEFAULT_AUTO_WAKE, enabled: false } })))
      .toMatchObject({ ok: false, reason: 'disabled' })
    expect(evaluateAutoWakeGate(input({ ownerPresent: false })))
      .toMatchObject({ ok: false, reason: 'no-owner' })
    expect(evaluateAutoWakeGate(input({ bodyState: 'faulted' })))
      .toMatchObject({ ok: false, reason: 'body-faulted' })
  })

  it('skips a running agent, pending wake and missing status', () => {
    expect(evaluateAutoWakeGate(input({ agentStatus: 'running' })))
      .toMatchObject({ ok: false, reason: 'agent-running' })
    expect(evaluateAutoWakeGate(input({ pendingWake: true })))
      .toMatchObject({ ok: false, reason: 'pending-wake' })
    expect(evaluateAutoWakeGate(input({ status: undefined })))
      .toMatchObject({ ok: false, reason: 'no-status' })
  })

  it('skips a disconnected, paused or suspended body and the danger layer', () => {
    expect(evaluateAutoWakeGate(input({ status: status({}, { connection: 'disconnected' }) })))
      .toMatchObject({ ok: false, reason: 'disconnected' })
    expect(evaluateAutoWakeGate(input({
      status: status({}, { providerState: { connected: true, paused: true, serverAge: 1, idleMs: 1 } }),
    }))).toMatchObject({ ok: false, reason: 'paused' })
    expect(evaluateAutoWakeGate(input({ status: status({ suspended: true }) })))
      .toMatchObject({ ok: false, reason: 'suspended' })
    expect(evaluateAutoWakeGate(input({
      status: status({ activity: { layer: 'constant', kind: 'escape', state: 'active', pausedBy: null } }),
    }))).toMatchObject({ ok: false, reason: 'danger' })
  })

  it('treats active work as a scheduling preference, not an authorization gate', () => {
    const active = status({
      activeOrder: { id: 'ord-1', verb: 'go' },
      queuedOrders: 1,
      plan: { id: 'plan-1', template: 'demo', satisfied: false, blocked: false },
      duty: {
        id: 'duty-1', kind: 'gather', item: 'dirt', quota: 2, baseline: 0, collected: 0,
        progress: 0, jobs: 0, state: 'active', startedAt: 1, activeMs: 0, pausedMs: 0,
      },
    })
    expect(evaluateAutoWakeGate(input({ status: active }))).toMatchObject({ ok: true })
    expect(evaluateAutoWakeGate(input({
      status: active,
      config: { ...DEFAULT_AUTO_WAKE, skipActiveWork: true },
    }))).toMatchObject({ ok: false, reason: 'active-order' })
    expect(evaluateAutoWakeGate(input({
      status: status({ activeOrder: null, queuedOrders: 0 }),
      config: { ...DEFAULT_AUTO_WAKE, skipActiveWork: true },
      goalActive: true,
    }))).toMatchObject({ ok: false, reason: 'active-goal' })
  })

  it('detects a no-op after the previous wake and resets on activity', () => {
    const same = evaluateAutoWakeGate(input({
      lastWake: { ordersAccepted: 0, dutyId: null },
    }))
    expect(same).toMatchObject({ ok: false, reason: 'idle-noop', backoff: true })
    const changed = evaluateAutoWakeGate(input({
      status: (() => {
        const base = status()
        return status({
          metrics: {
            ...base.mind!.metrics!,
            orders: { ...base.mind!.metrics!.orders, accepted: 1 },
          },
        })
      })(),
      lastWake: { ordersAccepted: 0, dutyId: null },
    }))
    expect(changed).toMatchObject({ ok: false, reason: 'activity', activity: true })
  })
})

describe('auto-wake prompt', () => {
  it('describes a runtime turn without prescribing or forbidding tasks', () => {
    const text = formatAutoWake(30 * 60_000, 'body=active epoch=e orders=0/0 duty=none base=wandering:active goal=none')
    expect(text.startsWith('[p2 auto-wake]')).toBe(true)
    expect(text).toContain('不是人类指令')
    expect(text).toContain('由你决定')
    expect(text).toContain('P2Mind 执行')
    expect(text).not.toContain('不要下单')
    expect(text).not.toContain('不是新任务授权')
  })
})

function scheduler(
  config: Partial<AutoWakeConfig> = {},
  overrides: {
    agentStatus?: () => 'idle' | 'running' | 'missing'
    probe?: (lastWake: unknown) => Promise<AutoWakeGateResult>
  } = {},
): {
  scheduler: AutoWakeScheduler
  logs: AutoWakeLogEntry[]
  wakes: string[]
  setNow: (value: number) => void
  now: () => number
} {
  let now = new Date(2026, 0, 1, 12, 0, 0).getTime()
  const logs: AutoWakeLogEntry[] = []
  const wakes: string[] = []
  const instance = new AutoWakeScheduler({
    config: {
      ...DEFAULT_AUTO_WAKE,
      silenceMs: 1_000,
      quietHours: null,
      dailyCap: 0,
      noOpBackoff: false,
      ...config,
    },
    now: () => now,
    getAgentStatus: overrides.agentStatus ?? (() => 'idle'),
    probe: overrides.probe ?? (async () => ({
      ok: true,
      summary: 'body=active epoch=e orders=0/0 duty=none base=wandering:active goal=none',
      snapshot: { ordersAccepted: 0, dutyId: null },
    })),
    wake: text => {
      wakes.push(text)
      return true
    },
    log: entry => logs.push(entry),
    schedule: () => ({ fake: true }),
    clearSchedule: () => {},
  })
  return {
    scheduler: instance,
    logs,
    wakes,
    setNow: value => { now = value },
    now: () => now,
  }
}

describe('auto-wake scheduler', () => {
  it('starts the silence clock, then wakes once at the threshold', async () => {
    const harness = scheduler()
    harness.scheduler.start()
    expect(await harness.scheduler.tick()).toMatchObject({ action: 'skip', reason: 'silence-started' })
    harness.setNow(harness.now() + 1_000)
    expect(await harness.scheduler.tick()).toMatchObject({ action: 'wake' })
    expect(harness.wakes).toHaveLength(1)
    expect(harness.wakes[0]).toContain('[p2 auto-wake]')
    expect(harness.logs.some(entry => entry.action === 'wake')).toBe(true)
    harness.scheduler.stop()
    expect(await harness.scheduler.tick()).toMatchObject({ reason: 'stopped' })
  })

  it('skips quiet hours without consuming the wake budget', async () => {
    const harness = scheduler({ quietHours: { start: 0, end: 8 } })
    harness.setNow(new Date(2026, 0, 1, 3, 0, 0).getTime())
    harness.scheduler.start()
    await harness.scheduler.tick()
    harness.setNow(harness.now() + 1_000)
    expect(await harness.scheduler.tick()).toMatchObject({ action: 'skip', reason: 'quiet-hours' })
    expect(harness.wakes).toHaveLength(0)
    harness.scheduler.stop()
  })

  it('enforces the daily cap', async () => {
    const harness = scheduler({ dailyCap: 1 })
    harness.scheduler.start()
    await harness.scheduler.tick()
    harness.setNow(harness.now() + 1_000)
    await harness.scheduler.tick()
    expect(harness.wakes).toHaveLength(1)
    await harness.scheduler.tick()
    harness.setNow(harness.now() + 1_000)
    expect(await harness.scheduler.tick()).toMatchObject({ action: 'skip', reason: 'daily-cap' })
    harness.scheduler.stop()
  })

  it('backs off after an idle no-op and resets on activity', async () => {
    let mode: 'wake' | 'noop' = 'wake'
    const harness = scheduler({}, {
      probe: async (): Promise<AutoWakeGateResult> => mode === 'wake'
        ? { ok: true, summary: 'ok', snapshot: { ordersAccepted: 0, dutyId: null } }
        : { ok: false, reason: 'idle-noop', backoff: true },
    })
    harness.scheduler.start()
    await harness.scheduler.tick()
    harness.setNow(harness.now() + 1_000)
    await harness.scheduler.tick()
    expect(harness.wakes).toHaveLength(1)
    expect(harness.scheduler.silenceMs).toBe(1_000)
    mode = 'noop'
    await harness.scheduler.tick()
    harness.setNow(harness.now() + 1_000)
    expect(await harness.scheduler.tick()).toMatchObject({ reason: 'idle-noop' })
    expect(harness.scheduler.silenceMs).toBe(2_000)
    harness.scheduler.stop()
  })

  it('does not wake a running or missing agent', async () => {
    let agent: 'idle' | 'running' | 'missing' = 'running'
    const harness = scheduler({}, { agentStatus: () => agent })
    harness.scheduler.start()
    await harness.scheduler.tick()
    harness.setNow(harness.now() + 1_000)
    expect(await harness.scheduler.tick()).toMatchObject({ reason: 'agent-running' })
    expect(harness.wakes).toHaveLength(0)
    agent = 'missing'
    expect(await harness.scheduler.tick()).toMatchObject({ reason: 'agent-missing' })
    harness.scheduler.stop()
  })
})

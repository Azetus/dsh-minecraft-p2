import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

import {
  createStdioTransport,
  PROTOCOL_VERSION,
} from '../contracts/index.ts'
import type {
  GuardCondition,
  GuardEvent,
  JsonValue,
  MessageTransport,
  OwnerContext,
  StatusResult,
} from '../contracts/index.ts'
import { EventQueue } from '../core/events.ts'
import type { RuntimeEvent } from '../core/events.ts'
import { BodyClient } from './body-client.ts'

export type BodyExit = { code: number | null; signal: NodeJS.Signals | null }

export type BodyHandle = {
  pid?: number
  transport: MessageTransport
  kill(signal?: NodeJS.Signals): void
  /** Force-kill the whole process tree where the platform supports it. */
  killTree?(): void
  waitForExit(): Promise<BodyExit>
}

export type BodySpawner = (entry: string, cwd: string) => BodyHandle

export type BodyManagerState = 'inactive' | 'starting' | 'active' | 'stopping' | 'faulted'

export type BodyFaultReason = 'heartbeat-missed' | 'process-exit' | 'restart-failed'
export type AutoRestartDecision = 'scheduled' | 'exhausted' | 'disabled'

/** One fault record: the previous run's control conclusion is never `released`. */
export type BodyFault = {
  at: number
  reason: BodyFaultReason
  epoch?: string
  detail?: string
  activeRunId?: string | null
  control: 'unknown'
  guardsCleared: true
  autoRestart: AutoRestartDecision
}

export type RestartInfo = {
  fault: BodyFault
  epoch: string
  attempt: number
  maxRestarts: number
}

export type AutoRestartOptions = {
  enabled?: boolean
  /** Maximum restarts inside one window. */
  maxRestarts?: number
  windowMs?: number
  backoffMs?: number[]
}

export type BodyManagerOptions = {
  bodyEntry: string
  spawnBody?: BodySpawner
  heartbeatMs?: number
  stopTimeoutMs?: number
  /** Timeout for one body request; shorter values make fault detection faster. */
  requestTimeoutMs?: number
  autoRestart?: AutoRestartOptions
  onFault?: (fault: BodyFault) => void
  onRestart?: (info: RestartInfo) => void
  /** Test seam for backoff scheduling. */
  delay?: (ms: number) => Promise<void>
  now?: () => number
  log?: (line: string) => void
  /** Called once per body guard event, after deduplication by body seq. */
  onGuardEvent?: (event: GuardEvent) => void
  /** Called when the body event cursor skipped events it no longer retained. */
  onGuardGap?: (fromSeq: number, toSeq: number) => void
}

export type StartResult = {
  state: 'active'
  epoch: string
}

export type BodyStatus =
  | { state: 'inactive' | 'starting' | 'stopping' }
  | { state: 'faulted'; fault?: BodyFault }
  | { state: 'active'; status: StatusResult; lastFault?: BodyFault }

export type StopResult = {
  state: 'inactive' | 'faulted'
  error?: string
}

/** One body process at a time; the DSH plugin owns this instance. */
export class BodyManager {
  private state: BodyManagerState = 'inactive'
  private client: BodyClient | undefined
  private handle: BodyHandle | undefined
  private owner: OwnerContext | undefined
  private epoch: string | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private heartbeatSeq = 0
  private readonly spawnBody: BodySpawner
  private readonly heartbeatMs: number
  private readonly stopTimeoutMs: number
  private readonly log: (line: string) => void
  private readonly events = new EventQueue(128)
  private eventSeq = 0
  private lastStatusSignature: string | undefined
  private lastGuardSeq = 0
  private readonly requestTimeoutMs: number
  private readonly livenessMs: number
  private readonly autoRestart: { enabled: boolean; maxRestarts: number; windowMs: number; backoffMs: number[] }
  private readonly restartTimes: number[] = []
  private readonly delay: (ms: number) => Promise<void>
  private readonly now: () => number
  private restartAttempt = 0
  private lastFaultValue: BodyFault | undefined
  private lastActiveRunId: string | null = null
  private lastContactAt = 0
  private heartbeatInFlight = false

  constructor(private readonly options: BodyManagerOptions) {
    this.spawnBody = options.spawnBody ?? createProcessSpawner(options.log)
    this.heartbeatMs = options.heartbeatMs ?? 2000
    this.stopTimeoutMs = options.stopTimeoutMs ?? 2000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000
    this.livenessMs = this.heartbeatMs * 3
    this.log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
    const auto = options.autoRestart
    this.autoRestart = {
      enabled: auto?.enabled ?? false,
      maxRestarts: Math.max(1, Math.floor(auto?.maxRestarts ?? 3)),
      windowMs: Math.max(0, auto?.windowMs ?? 60_000),
      backoffMs: auto?.backoffMs ?? [1000, 2000, 4000],
    }
    this.delay = options.delay ?? (ms => new Promise(resolve => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    }))
    this.now = options.now ?? Date.now
  }

  get currentState(): BodyManagerState {
    return this.state
  }

  get currentOwner(): OwnerContext | undefined {
    return this.owner
  }

  get bodyEpoch(): string | undefined {
    return this.epoch
  }

  drainEvents(): { events: RuntimeEvent[]; gap: boolean; dropped: number } {
    const drained = this.events.drain()
    return { ...drained, dropped: this.events.droppedCount }
  }

  async start(owner: OwnerContext): Promise<StartResult> {
    if (this.state === 'active' && this.epoch !== undefined) {
      return { state: 'active', epoch: this.epoch }
    }
    if (this.state !== 'inactive' && this.state !== 'faulted') {
      throw new Error(`body is ${this.state}`)
    }

    this.state = 'starting'
    this.owner = owner
    if (this.handle !== undefined) await this.cleanup(this.handle)
    let handle: BodyHandle | undefined
    try {
      handle = this.spawnBody(this.options.bodyEntry, owner.cwd)
      this.handle = handle
      const client = new BodyClient(handle.transport, { log: this.log, timeoutMs: this.requestTimeoutMs })
      this.client = client
      const hello = await client.hello([PROTOCOL_VERSION], owner)
      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`body negotiated unsupported protocol ${hello.protocolVersion}`)
      }
      const description = await client.describe()
      if (description.protocolVersion !== PROTOCOL_VERSION
        || description.body.manifestDigest !== hello.body.manifestDigest) {
        throw new Error('body describe does not match the hello handshake')
      }
      this.epoch = hello.bodyEpoch
      this.state = 'active'
      this.lastContactAt = this.now()
      this.lastGuardSeq = 0
      this.lastStatusSignature = undefined
      this.startHeartbeat()
      this.watchExit(handle)
      void this.pumpStatus()
      return { state: 'active', epoch: hello.bodyEpoch }
    } catch (error) {
      await this.cleanup(handle)
      this.state = 'inactive'
      throw error
    }
  }

  async status(): Promise<BodyStatus> {
    if (this.state !== 'active' || this.client === undefined) {
      if (this.state === 'faulted') {
        return {
          state: 'faulted',
          ...(this.lastFaultValue === undefined ? {} : { fault: this.lastFaultValue }),
        }
      }
      return { state: this.state === 'active' ? 'faulted' : this.state }
    }
    try {
      const status = await this.client.request('status', {}) as unknown as StatusResult
      this.lastContactAt = this.now()
      this.lastActiveRunId = status.activeRun?.runId ?? null
      this.processGuardEvents(status)
      return {
        state: 'active',
        status,
        ...(this.lastFaultValue === undefined ? {} : { lastFault: this.lastFaultValue }),
      }
    } catch (error) {
      this.log(`body status failed: ${errorText(error)}`)
      void this.fault('heartbeat-missed', `status request failed: ${errorText(error)}`)
      throw error
    }
  }

  check(sourcePath: string, options: { sourceRoot?: string; timeoutMs?: number; artifactKind?: 'behavior' | 'act' | 'policy' | 'op'; format?: 'ir' | 'js' } = {}): Promise<JsonValue> {
    return this.activeClient().check(sourcePath, options)
  }

  rescue(params: JsonValue): Promise<JsonValue> {
    return this.activeClient().rescue(params)
  }

  activate(artifactId: string): Promise<JsonValue> {
    return this.activeClient().activate(artifactId)
  }

  switch(artifactId: string, params: JsonValue = {}): Promise<JsonValue> {
    return this.activeClient().switch(artifactId, params)
  }

  confirm(runId: string, confirmationId: string, decision: 'confirm' | 'deny'): Promise<JsonValue> {
    return this.activeClient().confirm(runId, confirmationId, decision)
  }

  stopBehavior(runId?: string): Promise<JsonValue> {
    return this.activeClient().behaviorStop(runId)
  }

  guardSet(input: {
    guardId?: string
    priority?: number
    condition: GuardCondition
    targetArtifactId: string
    params: JsonValue
    ttlMs: number
  }): Promise<JsonValue> {
    return this.activeClient().guardSet(input)
  }

  guardClear(guardId?: string): Promise<JsonValue> {
    return this.activeClient().guardClear(guardId)
  }

  commandGet(commandId: string): Promise<JsonValue> {
    return this.activeClient().commandGet(commandId)
  }

  observe(op: string, args: JsonValue = {}): Promise<JsonValue> {
    return this.activeClient().observe(op, args)
  }

  trace(params: JsonValue = {}): Promise<JsonValue> {
    return this.activeClient().trace(params)
  }

  private activeClient(): BodyClient {
    if (this.state !== 'active' || this.client === undefined) {
      throw new Error(`body is ${this.state}`)
    }
    return this.client
  }

  async stop(): Promise<StopResult> {
    if (this.state === 'inactive') return { state: 'inactive' }
    if (this.state === 'faulted') {
      await this.cleanup(this.handle)
      return { state: 'faulted' }
    }

    this.state = 'stopping'
    let shutdownError: string | undefined
    if (this.client !== undefined) {
      try {
        await this.client.shutdown()
      } catch (error) {
        shutdownError = errorText(error)
      }
    }

    const handle = this.handle
    let exited = handle === undefined ? true : await this.waitForExit(handle, this.stopTimeoutMs)
    if (!exited && handle !== undefined) {
      handle.kill('SIGTERM')
      exited = await this.waitForExit(handle, 500)
    }
    this.stopHeartbeat()
    this.client?.close()
    this.client = undefined
    this.handle = undefined
    this.owner = undefined
    this.epoch = undefined
    if (!exited) {
      this.state = 'faulted'
      return {
        state: 'faulted',
        ...(shutdownError === undefined ? {} : { error: shutdownError }),
      }
    }
    this.state = 'inactive'
    return {
      state: 'inactive',
      ...(shutdownError === undefined ? {} : { error: shutdownError }),
    }
  }

  async dispose(): Promise<void> {
    try {
      await this.stop()
    } catch (error) {
      this.log(`body dispose failed: ${errorText(error)}`)
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastContactAt = this.now()
    this.heartbeatTimer = setInterval(() => {
      this.checkLiveness()
      void this.sendHeartbeat()
    }, this.heartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    this.heartbeatInFlight = false
  }

  /** Three consecutive missing heartbeat intervals count as a fault. */
  private checkLiveness(): void {
    if (this.state !== 'active') return
    if (this.now() - this.lastContactAt < this.livenessMs) return
    void this.fault('heartbeat-missed', `no body contact for ${this.livenessMs}ms`)
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.state !== 'active' || this.client === undefined || this.heartbeatInFlight) return
    this.heartbeatInFlight = true
    this.heartbeatSeq += 1
    try {
      await this.client.request('heartbeat', { seq: this.heartbeatSeq })
      this.lastContactAt = this.now()
      await this.pumpStatus()
    } catch (error) {
      this.log(`heartbeat failed: ${errorText(error)}`)
    } finally {
      this.heartbeatInFlight = false
    }
  }

  private async pumpStatus(): Promise<void> {
    if (this.state !== 'active' || this.client === undefined) return
    try {
      const status = await this.client.request('status', {}) as unknown as StatusResult
      this.lastContactAt = this.now()
      this.lastActiveRunId = status.activeRun?.runId ?? null
      this.processGuardEvents(status)
      const signature = JSON.stringify({
        run: status.activeRun,
        lastRun: status.lastRun,
        confirmation: status.pendingConfirmation,
        health: status.health,
        providerPaused: status.providerState?.paused ?? null,
        serverAge: status.providerState?.serverAge ?? null,
      })
      if (signature === this.lastStatusSignature) return
      this.lastStatusSignature = signature
      this.eventSeq += 1
      this.events.push({
        eventId: `${this.epoch ?? 'epoch'}:status:${this.eventSeq}`,
        seq: this.eventSeq,
        kind: 'status',
        data: status as unknown as JsonValue,
      })
    } catch (error) {
      this.log(`body status poll failed: ${errorText(error)}`)
    }
  }

  private processGuardEvents(status: StatusResult): void {
    const events = status.guardEvents ?? []
    for (const event of events) {
      if (event.seq <= this.lastGuardSeq) continue
      if (this.lastGuardSeq > 0 && event.seq > this.lastGuardSeq + 1) {
        this.options.onGuardGap?.(this.lastGuardSeq + 1, event.seq - 1)
      }
      this.lastGuardSeq = event.seq
      this.eventSeq += 1
      this.events.push({
        eventId: `${this.epoch ?? 'epoch'}:guard:${event.seq}`,
        seq: this.eventSeq,
        kind: 'guard',
        data: event as unknown as JsonValue,
      })
      this.options.onGuardEvent?.(event)
    }
  }

  private watchExit(handle: BodyHandle): void {
    void handle.waitForExit().then(exit => {
      if (this.handle !== handle) return
      this.stopHeartbeat()
      this.client?.close()
      this.client = undefined
      this.handle = undefined
      if (this.state === 'stopping') {
        this.state = 'inactive'
        return
      }
      if (this.state === 'active' || this.state === 'starting') {
        this.log(`body exited unexpectedly (code=${exit.code ?? 'null'}, signal=${exit.signal ?? 'none'})`)
        void this.fault('process-exit', `code=${exit.code ?? 'null'} signal=${exit.signal ?? 'none'}`)
      }
    })
  }

  /**
   * Freeze the current epoch as faulted: kill the process tree, record the
   * fault, then restart within the development budget. Stopping or manual stop
   * already changed the state, so neither schedules a restart.
   */
  private async fault(reason: BodyFaultReason, detail?: string): Promise<void> {
    if (this.state !== 'active' && this.state !== 'starting') return
    this.state = 'faulted'
    this.stopHeartbeat()
    const handle = this.handle
    const fault: BodyFault = {
      at: this.now(),
      reason,
      ...(this.epoch === undefined ? {} : { epoch: this.epoch }),
      ...(detail === undefined ? {} : { detail }),
      activeRunId: this.lastActiveRunId,
      control: 'unknown',
      guardsCleared: true,
      autoRestart: 'disabled',
    }
    this.client?.close()
    this.client = undefined
    this.handle = undefined
    this.epoch = undefined
    if (handle !== undefined) {
      try {
        if (handle.killTree !== undefined) handle.killTree()
        else handle.kill('SIGKILL')
      } catch {
        // The tree may already be gone; the fault is still recorded.
      }
      await this.waitForExit(handle, 200)
    }
    fault.autoRestart = this.planRestart()
    this.lastFaultValue = fault
    this.emitEvent('fault', fault)
    this.safeCallback(this.options.onFault, fault)
    if (fault.autoRestart !== 'scheduled') return
    const index = Math.min(this.restartTimes.length - 1, this.autoRestart.backoffMs.length - 1)
    await this.delay(this.autoRestart.backoffMs[index] ?? 0)
    await this.restart(fault)
  }

  private planRestart(): AutoRestartDecision {
    if (!this.autoRestart.enabled) return 'disabled'
    const now = this.now()
    while (this.restartTimes.length > 0 && now - (this.restartTimes[0] as number) >= this.autoRestart.windowMs) {
      this.restartTimes.shift()
    }
    if (this.restartTimes.length >= this.autoRestart.maxRestarts) return 'exhausted'
    this.restartTimes.push(now)
    return 'scheduled'
  }

  private async restart(fault: BodyFault): Promise<void> {
    const owner = this.owner
    if (owner === undefined || this.state !== 'faulted') return
    this.restartAttempt += 1
    try {
      const started = await this.start(owner)
      const info: RestartInfo = {
        fault,
        epoch: started.epoch,
        attempt: this.restartAttempt,
        maxRestarts: this.autoRestart.maxRestarts,
      }
      this.emitEvent('restart', info)
      this.safeCallback(this.options.onRestart, info)
    } catch (error) {
      this.log(`body restart failed: ${errorText(error)}`)
      if (this.isTerminating()) return
      this.state = 'faulted'
      const failure: BodyFault = {
        ...fault,
        at: this.now(),
        reason: 'restart-failed',
        detail: errorText(error),
        autoRestart: 'exhausted',
      }
      this.lastFaultValue = failure
      this.emitEvent('fault', failure)
      this.safeCallback(this.options.onFault, failure)
    }
  }

  private isTerminating(): boolean {
    return this.state === 'stopping' || this.state === 'inactive'
  }

  private emitEvent(kind: string, data: unknown): void {
    this.eventSeq += 1
    this.events.push({
      eventId: `${this.epoch ?? 'body'}:${kind}:${this.eventSeq}`,
      seq: this.eventSeq,
      kind,
      data: data as JsonValue,
    })
  }

  private safeCallback<T>(callback: ((value: T) => void) | undefined, value: T): void {
    if (callback === undefined) return
    try {
      callback(value)
    } catch (error) {
      this.log(`body callback failed: ${errorText(error)}`)
    }
  }

  private async cleanup(handle: BodyHandle | undefined): Promise<void> {
    this.stopHeartbeat()
    this.client?.close()
    this.client = undefined
    this.handle = undefined
    this.owner = undefined
    this.epoch = undefined
    if (handle !== undefined) {
      handle.kill('SIGTERM')
      await this.waitForExit(handle, 500)
    }
  }

  private async waitForExit(handle: BodyHandle, timeoutMs: number): Promise<boolean> {
    return Promise.race([
      handle.waitForExit().then(() => true),
      delay(timeoutMs).then(() => false),
    ])
  }
}

/** Spawn the body bundle next to the bridge with a dedicated stdio channel. */
export function createProcessSpawner(log: (line: string) => void = line => process.stderr.write(`${line}\n`)): BodySpawner {
  return (entry, cwd) => {
    const child = spawn(process.execPath, [entry], {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (child.stdout === null || child.stdin === null) {
      throw new Error('body process did not expose stdio pipes')
    }
    child.stderr?.on('data', chunk => log(`body: ${String(chunk).trimEnd()}`))
    return {
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      transport: createStdioTransport(child.stdout, child.stdin),
      kill(signal = 'SIGTERM') {
        if (child.exitCode === null) child.kill(signal)
      },
      killTree() {
        if (child.exitCode !== null) return
        if (process.platform === 'win32' && child.pid !== undefined) {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          })
          killer.on('error', () => {
            try { child.kill('SIGKILL') } catch { /* already gone */ }
          })
          return
        }
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      },
      waitForExit: () => waitForChild(child),
    }
  }
}

function waitForChild(child: ChildProcess): Promise<BodyExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

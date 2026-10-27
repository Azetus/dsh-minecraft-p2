import type { JsonValue } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import { BehaviorHost } from './host.ts'
import type { HostStatus, SwitchInput, SwitchResult } from './host.ts'
import type { ConfirmInput, ConfirmResult, RunStatus } from './run.ts'

export type MultiBindingSwitch = SwitchInput & { bindingId: string }

/** Per-binding hosts with one actively switched run across bindings. */
export class MultiBindingHost {
  private readonly hosts = new Map<string, BehaviorHost>()
  private activeBinding: string | undefined

  add(bindingId: string, host: BehaviorHost): void {
    this.hosts.set(bindingId, host)
  }

  async check(bindingId: string, request: { sourcePath: string; sourceRoot?: string; timeoutMs?: number }): Promise<{ artifactId: string }> {
    return this.requireHost(bindingId).check(request)
  }

  activate(bindingId: string, artifactId: string): { artifactId: string; bindingId: string; enabled: true } {
    return this.requireHost(bindingId).activate(artifactId)
  }

  switch(input: MultiBindingSwitch): SwitchResult {
    const target = this.hosts.get(input.bindingId)
    if (target === undefined) {
      return {
        accepted: false,
        runId: null,
        status: 'rejected',
        error: p2Error('BINDING_NOT_FOUND', 'validation', `unknown binding: ${input.bindingId}`, { module: 'core.multi-host' }),
      }
    }

    if (this.activeBinding !== undefined) {
      const current = this.hosts.get(this.activeBinding)
      const active = current?.status().activeRun
      if (current !== undefined && active !== null && active !== undefined) {
        const stopped = current.stop(active.runId)
        if (!stopped.accepted && stopped.status !== 'cancelled') {
          return {
            accepted: false,
            runId: active.runId,
            status: 'superseded',
            error: p2Error('SWITCH_TIMEOUT', 'runtime', 'old binding run did not stop', { module: 'core.multi-host' }),
          }
        }
        current.tick()
      }
    }

    const result = target.switch(input)
    if (result.accepted) this.activeBinding = input.bindingId
    return result
  }

  tick(now = Date.now()): RunStatus | undefined {
    if (this.activeBinding === undefined) return undefined
    return this.hosts.get(this.activeBinding)?.tick(now)
  }

  confirm(input: ConfirmInput): ConfirmResult {
    if (this.activeBinding === undefined) {
      return {
        outcome: 'rejected',
        status: 'cancelled',
        error: p2Error('RUN_NOT_FOUND', 'validation', 'no active binding run', { module: 'core.multi-host' }),
      }
    }
    return this.hosts.get(this.activeBinding)?.confirm(input) as ConfirmResult
  }

  stop(runId: string): { accepted: boolean; status: RunStatus } {
    if (this.activeBinding === undefined) {
      return { accepted: false, status: 'cancelled' }
    }
    const host = this.hosts.get(this.activeBinding) as BehaviorHost
    const result = host.stop(runId)
    return { accepted: result.accepted, status: result.status }
  }

  status(): (HostStatus & { bindingId: string }) | undefined {
    if (this.activeBinding === undefined) return undefined
    const status = this.hosts.get(this.activeBinding)?.status()
    return status === undefined ? undefined : { ...status, bindingId: this.activeBinding }
  }

  retire(bindingId: string, artifactId: string): void {
    this.requireHost(bindingId).retire(artifactId)
  }

  activeBindingId(): string | undefined {
    return this.activeBinding
  }

  private requireHost(bindingId: string): BehaviorHost {
    const host = this.hosts.get(bindingId)
    if (host === undefined) throw new Error(`unknown binding: ${bindingId}`)
    return host
  }
}

export type { JsonValue }

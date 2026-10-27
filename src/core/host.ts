import type { BehaviorArtifact } from '../contracts/ir.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import { CheckerError, checkBehavior } from './checker.ts'
import type { CheckerCredential } from './checker.ts'
import { CommandLedger } from './logging.ts'
import { BehaviorRun } from './run.ts'
import type { ConfirmInput, ConfirmResult, RunStatus } from './run.ts'
import { ArtifactRegistry, RegistryError } from './registry.ts'
import type { ActPort, QueryPort } from './node-runtime.ts'

export type CheckHostRequest = {
  sourcePath: string
  sourceRoot?: string
  timeoutMs?: number
}

export type SwitchInput = {
  artifactId: string
  params: Record<string, JsonValue>
  commandId: string
}

export type SwitchResult = {
  accepted: boolean
  runId: string | null
  status: RunStatus | 'rejected' | 'superseded'
  error?: P2Error
}

export type HostStatus = {
  bindingId: string
  activeRun: null | {
    runId: string
    status: RunStatus
    artifactId: string
    completion: string | null
  }
  pendingConfirmation: null | {
    id: string
    runId: string
  }
  commandCount: number
}

export type BehaviorHostOptions = {
  bindingId: string
  query: QueryPort
  act: ActPort
  owner?: string
  builtinsDigest?: string
  newRunId?: () => string
}

/** Library-level behavior host used by M1 tests; body wiring remains separate. */
export class BehaviorHost {
  private readonly registry: ArtifactRegistry
  private readonly bindingId: string
  private readonly credentials = new Map<string, CheckerCredential>()
  private readonly ledger = new CommandLedger<SwitchResult | ConfirmResult | { artifactId: string }>()
  private readonly query: QueryPort
  private readonly act: ActPort
  private owner: string
  private readonly newRunId: () => string
  private run: BehaviorRun | undefined
  private runArtifact: string | undefined
  private sequence = 0

  constructor(options: BehaviorHostOptions) {
    this.bindingId = options.bindingId
    this.registry = new ArtifactRegistry({
      bindingId: options.bindingId,
      ...(options.builtinsDigest === undefined ? {} : { builtinsDigest: options.builtinsDigest }),
    })
    this.query = options.query
    this.act = options.act
    this.owner = options.owner ?? 'host'
    this.newRunId = options.newRunId ?? (() => `run-${++this.sequence}`)
  }

  async check(request: CheckHostRequest): Promise<{ artifactId: string; artifact: BehaviorArtifact }> {
    try {
      const result = await checkBehavior({
        sourcePath: request.sourcePath,
        ...(request.sourceRoot === undefined ? {} : { sourceRoot: request.sourceRoot }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        bindingId: this.registryBinding,
      })
      this.credentials.set(result.artifact.artifactId, result.credential)
      this.registry.add(result.artifact, result.credential)
      return { artifactId: result.artifact.artifactId, artifact: result.artifact }
    } catch (error) {
      if (error instanceof CheckerError || error instanceof RegistryError) throw error
      throw error
    }
  }

  setOwner(owner: string): void {
    this.owner = owner
  }

  activate(artifactId: string): { artifactId: string; bindingId: string; enabled: true } {    const credential = this.credentials.get(artifactId)
    if (credential === undefined) {
      throw new RegistryError('CHECKER_CREDENTIAL_MISSING', `no checker credential for ${artifactId}`)
    }
    this.registry.enable(artifactId, credential)
    return { artifactId, bindingId: this.registryBinding, enabled: true }
  }

  switch(input: SwitchInput): SwitchResult {
    const duplicate = this.ledger.get(input.commandId)
    if (duplicate !== undefined && 'accepted' in duplicate) return duplicate

    const record = this.registry.get(input.artifactId)
    if (record === undefined || record.retired || !record.enabled) {
      const result: SwitchResult = {
        accepted: false,
        runId: null,
        status: 'rejected',
        error: p2Error('ARTIFACT_NOT_ACTIVE', 'validation', 'artifact is not active', { module: 'core.host' }),
      }
      this.ledger.record(input.commandId, result)
      return result
    }

    if (this.run !== undefined && !isTerminal(this.run.status)) {
      this.run.stop()
      for (let index = 0; index < 100 && !isTerminal(this.run.status); index += 1) this.run.tick()
      if (!isTerminal(this.run.status)) {
        const result: SwitchResult = {
          accepted: false,
          runId: this.run.runId,
          status: 'superseded',
          error: p2Error('SWITCH_TIMEOUT', 'runtime', 'old run did not stop', { module: 'core.host' }),
        }
        this.ledger.record(input.commandId, result)
        return result
      }
    }

    const runId = this.newRunId()
    this.run = new BehaviorRun({
      runId,
      owner: this.owner,
      definition: record.artifact.definition,
      params: input.params,
      query: this.query,
      act: this.act,
    })
    this.runArtifact = input.artifactId
    const result: SwitchResult = { accepted: true, runId, status: 'running' }
    this.ledger.record(input.commandId, result)
    return result
  }

  tick(now = Date.now()): RunStatus | undefined {
    return this.run?.tick(now)
  }

  confirm(input: ConfirmInput): ConfirmResult {
    if (this.run === undefined) {
      return {
        outcome: 'rejected',
        status: 'cancelled',
        error: p2Error('RUN_NOT_FOUND', 'validation', 'no active run', { module: 'core.host' }),
      }
    }
    const result = this.run.confirm(input)
    this.ledger.record(input.commandId, result)
    return result
  }

  stop(runId: string): { accepted: true; status: RunStatus } | { accepted: false; status: RunStatus; error: P2Error } {
    if (this.run === undefined || this.run.runId !== runId) {
      return {
        accepted: false,
        status: 'cancelled',
        error: p2Error('RUN_NOT_FOUND', 'validation', 'run is not active', { module: 'core.host' }),
      }
    }
    if (isTerminal(this.run.status)) {
      return {
        accepted: false,
        status: this.run.status,
        error: p2Error('ALREADY_TERMINAL', 'validation', 'run is already terminal', { module: 'core.host' }),
      }
    }
    this.run.stop()
    this.run.tick()
    return { accepted: true, status: this.run.status }
  }

  retire(artifactId: string): void {
    this.registry.retire(artifactId)
  }

  status(): HostStatus {
    const run = this.run
    return {
      bindingId: this.registryBinding,
      activeRun: run === undefined || isTerminal(run.status)
        ? null
        : {
            runId: run.runId,
            status: run.status,
            artifactId: this.runArtifact ?? '',
            completion: run.definition.completion?.kind ?? null,
          },
      pendingConfirmation: run?.confirmation?.status === 'pending'
        ? { id: run.confirmation.id, runId: run.runId }
        : null,
      commandCount: this.ledger.size,
    }
  }

  dispose(): void {
    if (this.run !== undefined && !isTerminal(this.run.status)) {
      this.run.stop()
      this.run.tick()
    }
  }

  private get registryBinding(): string {
    return this.bindingId
  }
}

function isTerminal(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

import { p2Error } from '../contracts/protocol.ts'
import type { ArtifactRef } from '../contracts/artifacts.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import type { PolicyOutcome, PolicyPort } from './node-runtime.ts'
import type { RunnerClient } from './runner-client.ts'

export type PolicySource = {
  artifactId: string
  code: string
}

/** Policy calls routed to the isolated runner; waiting never blocks the tick. */
export class RunnerPolicyPort implements PolicyPort {
  private readonly loaded = new Map<string, Promise<void>>()
  private readonly getClient: () => RunnerClient

  constructor(
    client: RunnerClient | (() => RunnerClient),
    private readonly resolveArtifact: (artifactId: string) => PolicySource | undefined,
  ) {
    this.getClient = typeof client === 'function' ? client : () => client
  }

  /** Drop cached artifact loads after the runner process was replaced. */
  reset(): void {
    this.loaded.clear()
  }

  call(ref: ArtifactRef, inputs: Record<string, JsonValue>): PolicyOutcome {
    const artifactId = ref.artifactId
    if (artifactId === undefined) {
      return { status: 'failed', error: p2Error('POLICY_REF_UNRESOLVED', 'validation', `policy ${ref.definitionId} has no artifactId`, { module: 'core.policy-port' }) }
    }
    const source = this.resolveArtifact(artifactId)
    if (source === undefined) {
      return { status: 'failed', error: p2Error('POLICY_NOT_FOUND', 'validation', `policy artifact is not registered: ${artifactId}`, { module: 'core.policy-port' }) }
    }
    let state: 'running' | 'ok' | 'failed' = 'running'
    let value: JsonValue | undefined
    let failure: P2Error | undefined
    const poll = (): PolicyOutcome => {
      if (state === 'running') return { status: 'pending', poll }
      if (state === 'failed') return { status: 'failed', error: failure ?? p2Error('POLICY_FAILED', 'runtime', 'policy failed', { module: 'core.policy-port' }) }
      return { status: 'ok', value: value ?? null }
    }
    void this.load(source)
      .then(() => this.getClient().runPolicy(artifactId, inputs))
      .then(result => {
        value = result
        state = 'ok'
      })
      .catch((error: unknown) => {
        state = 'failed'
        failure = p2Error(
          typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'POLICY_FAILED',
          'runtime',
          error instanceof Error ? error.message : String(error),
          { module: 'core.policy-port' },
        )
      })
    return poll()
  }

  private load(source: PolicySource): Promise<void> {
    const existing = this.loaded.get(source.artifactId)
    if (existing !== undefined) return existing
    const promise = this.getClient().load('policy', source.artifactId, source.code).then(() => undefined)
    this.loaded.set(source.artifactId, promise)
    promise.catch(() => this.loaded.delete(source.artifactId))
    return promise
  }
}



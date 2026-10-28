import type { JsonValue } from '../contracts/types.ts'

export type RunnerHookResult =
  | { kind: 'running'; progress?: JsonValue }
  | { kind: 'complete'; result?: JsonValue }
  | { kind: 'failed'; error: { code: string; message: string; category?: string } }

export type RunnerStopReason = 'completed' | 'failed' | 'cancelled'

export type RunnerRequest =
  | { type: 'load'; id: number; kind: 'act' | 'policy'; artifactId: string; code: string }
  | { type: 'act.start'; id: number; artifactId: string; args: JsonValue }
  | { type: 'act.update'; id: number; inputs: JsonValue }
  | { type: 'act.stop'; id: number; reason: RunnerStopReason }
  | { type: 'act.cleanup'; id: number; inputs: JsonValue }
  | { type: 'policy.run'; id: number; artifactId: string; inputs: JsonValue }
  | { type: 'ping'; id: number }
  | { type: 'shutdown'; id: number }

export type RunnerEvent =
  | { type: 'ready' }
  | { type: 'loaded'; id: number; manifest: JsonValue }
  | { type: 'hook'; id: number; result: RunnerHookResult }
  | { type: 'policyResult'; id: number; ok: boolean; value?: JsonValue; error?: { code: string; message: string } }
  | { type: 'op'; callId: number; kind: 'query' | 'control'; name: string; args: JsonValue }
  | { type: 'error'; id: number; code: string; message: string }
  | { type: 'done'; id: number }

export const RUNNER_LOAD_TIMEOUT_MS = 2000
export const RUNNER_HOOK_TIMEOUT_MS = 500
export const RUNNER_POLICY_TIMEOUT_MS = 200

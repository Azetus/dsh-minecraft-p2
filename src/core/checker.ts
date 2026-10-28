import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import {
  artifactDigest,
  artifactId,
  digest,
  sourceDigest,
} from '../contracts/digest.ts'
import type { BehaviorDefinition, BehaviorArtifact, Node } from '../contracts/ir.ts'
import type { ArtifactManifest, JsonValue } from '../contracts/types.ts'
import { BehaviorValidationError, validateBehavior } from './validate.ts'

export const CHECKER_VERSION = '0.1.0'

export type CheckerCredential = {
  checkerVersion: string
  bindingId: string
  network: false
  builtinsDigest: string
}

export type CheckRequest = {
  sourcePath: string
  bindingId: string
  sourceRoot?: string
  timeoutMs?: number
  builtinsDigest?: string
  /** Resolve an act definitionId to the enabled artifactId for this binding. */
  resolveAct?: (definitionId: string) => string | undefined
  /** Resolve a policy definitionId to its checked artifactId. */
  resolvePolicy?: (definitionId: string) => string | undefined
}

export type CheckResult = {
  artifact: BehaviorArtifact
  credential: CheckerCredential
}

export class CheckerError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CheckerError'
    this.code = code
  }
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const module = await import(workerData.url);
    const value = module.default ?? module.behavior;
    if (value === undefined) throw new Error('behavior module has no default export');
    parentPort.postMessage({ ok: true, value });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
  }
})();
`

/**
 * Run the authoring module in a worker with a hard timeout, then validate the
 * returned IR in the host. The worker has no operation ports; a build loop can
 * be terminated without blocking the body.
 */
export async function checkBehavior(request: CheckRequest): Promise<CheckResult> {
  const sourcePath = resolve(request.sourcePath)
  const sourceRoot = resolve(request.sourceRoot ?? dirname(sourcePath))
  const relativePath = relative(sourceRoot, sourcePath)
  if (relativePath === '' || relativePath.startsWith('..') || relativePath.split(sep).includes('..')) {
    throw new CheckerError('SOURCE_OUTSIDE_ROOT', 'source path must be inside the source root')
  }

  let bytes: Buffer
  try {
    bytes = await readFile(sourcePath)
  } catch (error) {
    throw new CheckerError('SOURCE_UNREADABLE', error instanceof Error ? error.message : String(error))
  }
  const normalizedRelative = relativePath.split(sep).join('/')
  const sourceHash = sourceDigest([{ path: normalizedRelative, bytes }])

  const loaded = await loadModule(sourcePath, request.timeoutMs ?? 1000)
  // Work on a private copy: resolution mutates the IR and the module cache must not leak it.
  const definition = JSON.parse(JSON.stringify(loaded)) as BehaviorDefinition
  resolveActRefs(definition, request.resolveAct, request.resolvePolicy)
  try {
    validateBehavior(definition)
  } catch (error) {
    if (error instanceof BehaviorValidationError) {
      throw new CheckerError(error.code, `${error.path}: ${error.message}`)
    }
    throw error
  }

  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    kind: 'behavior',
    definitionId: definition.id,
    sourceDigest: sourceHash,
    irVersion: 1,
    irDigest: digest('p2-ir-v1', definition as unknown as JsonValue),
    codeDigest: null,
    buildToolVersion: CHECKER_VERSION,
    bindingId: request.bindingId,
    dependencies: [],
  }
  const digestValue = artifactDigest(manifest)
  const id = artifactId(manifest)
  return {
    artifact: {
      kind: 'behavior',
      definition,
      manifest,
      artifactId: id,
      artifactDigest: digestValue,
      bindingId: request.bindingId,
      sourceDigest: sourceHash,
    },
    credential: {
      checkerVersion: CHECKER_VERSION,
      bindingId: request.bindingId,
      network: false,
      builtinsDigest: request.builtinsDigest ?? 'none',
    },
  }
}

/** Fill exact act/policy artifact ids into the IR before validation. */
function resolveActRefs(
  definition: BehaviorDefinition,
  resolveAct: CheckRequest['resolveAct'],
  resolvePolicy: CheckRequest['resolvePolicy'],
): void {
  const visit = (node: Node): void => {
    switch (node.kind) {
      case 'sequence':
        for (const child of node.children) visit(child)
        return
      case 'if':
        visit(node.then)
        if (node.else !== undefined) visit(node.else)
        return
      case 'reactivePriority':
        for (const branch of node.branches) visit(branch.child)
        return
      case 'repeat':
        visit(node.child)
        return
      case 'subtree':
        visit(node.tree)
        return
      case 'recover':
        visit(node.child)
        for (const rule of node.rules) if (rule.fallback !== undefined) visit(rule.fallback)
        return
      case 'act': {
        if (node.act.artifactId !== undefined && node.act.artifactId.length > 0) return
        const artifactIdValue = resolveAct?.(node.act.definitionId)
        if (artifactIdValue === undefined) {
          throw new CheckerError(
            'ACT_NOT_RESOLVED',
            `act ${node.act.definitionId} has no enabled artifact in this binding; check and activate it first`,
          )
        }
        node.act = { definitionId: node.act.definitionId, artifactId: artifactIdValue }
        return
      }
      case 'decide': {
        if (node.policy.artifactId !== undefined && node.policy.artifactId.length > 0) return
        const artifactIdValue = resolvePolicy?.(node.policy.definitionId)
        if (artifactIdValue === undefined) {
          throw new CheckerError(
            'POLICY_NOT_RESOLVED',
            `policy ${node.policy.definitionId} has not been checked in this binding; check it first`,
          )
        }
        node.policy = { definitionId: node.policy.definitionId, artifactId: artifactIdValue }
        return
      }
      default:
        return
    }
  }
  visit(definition.root)
}

function loadModule(sourcePath: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolveValue, rejectValue) => {
    let settled = false
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { url: pathToFileURL(sourcePath).href },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    })
    const finish = (error: Error | undefined, value?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      if (error === undefined) resolveValue(value)
      else rejectValue(error)
    }
    const timer = setTimeout(() => {
      finish(new CheckerError('CHECK_TIMEOUT', `behavior build exceeded ${timeoutMs}ms`))
    }, timeoutMs)

    worker.once('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null) {
        finish(new CheckerError('CHECK_INVALID', 'behavior worker returned an invalid message'))
        return
      }
      const result = message as { ok?: unknown; value?: unknown; error?: { message?: unknown } }
      if (result.ok === true) {
        finish(undefined, result.value)
        return
      }
      const detail = typeof result.error?.message === 'string' ? result.error.message : 'build failed'
      finish(new CheckerError('CHECK_FAILED', detail))
    })
    worker.once('error', (error: Error) => finish(new CheckerError('CHECK_FAILED', error.message)))
    worker.once('exit', (code: number) => {
      if (!settled) finish(new CheckerError('CHECK_EXITED', `behavior worker exited with code ${code}`))
    })
  })
}

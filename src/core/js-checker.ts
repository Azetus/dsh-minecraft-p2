import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import vm from 'node:vm'

import { artifactDigest, artifactId, sourceDigest } from '../contracts/digest.ts'
import type { BehaviorArtifact, BehaviorDefinition } from '../contracts/ir.ts'
import type { ArtifactManifest, JsonValue } from '../contracts/types.ts'
import { forbiddenIn, lineColumn } from './js-forbidden.ts'
import { CHECKER_VERSION, CheckerError } from './checker.ts'
import type { CheckerCredential } from './checker.ts'

export type BehaviorJsCheckRequest = {
  sourcePath: string
  sourceRoot?: string
  bindingId: string
  builtinsDigest?: string
  timeoutMs?: number
  /** Resolve a declared act/policy definitionId to the exact artifact for this binding. */
  resolveDependency?: (kind: 'act' | 'policy', definitionId: string) => { artifactId: string; digest: string } | undefined
  /** Load the module in the sandbox runner instead of a body-local vm. */
  loadManifest?: (code: string, artifactId: string) => Promise<JsonValue>
}

export type BehaviorJsCheckResult = {
  artifact: BehaviorArtifact
  credential: CheckerCredential
}

type JsBehaviorDependencies = {
  acts: string[]
  policies: string[]
}

type JsBehaviorManifest = {
  id: string
  description?: string
  mode: 'finite' | 'continuous'
  parameters: Record<string, unknown>
  dependencies?: Partial<JsBehaviorDependencies>
}

/** A checked JS behavior keeps a synthetic IR definition for the host surface. */
export function jsBehaviorDefinition(manifest: JsBehaviorManifest): BehaviorDefinition {
  return {
    id: manifest.id,
    description: manifest.description ?? manifest.id,
    mode: manifest.mode,
    parameters: manifest.parameters as BehaviorDefinition['parameters'],
    locals: {},
    root: { kind: 'fail', id: 'js-placeholder', code: 'JS_BEHAVIOR_NOT_IR', message: 'JS behaviors are executed by the step runner' },
    ...(manifest.mode === 'finite'
      ? { completion: { kind: 'externalConfirmation' as const, description: 'JS behavior completion' } }
      : {}),
  }
}

function validateManifest(captured: unknown): JsBehaviorManifest {
  if (typeof captured !== 'object' || captured === null) {
    throw new CheckerError('INVALID_MANIFEST', 'JS behavior must call defineBehavior({ manifest, run })')
  }
  const manifest = captured as Partial<JsBehaviorManifest>
  if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
    throw new CheckerError('INVALID_MANIFEST', 'JS behavior manifest.id is required')
  }
  if (manifest.mode !== 'finite' && manifest.mode !== 'continuous') {
    throw new CheckerError('INVALID_MANIFEST', 'JS behavior mode must be finite or continuous')
  }
  if (typeof manifest.parameters !== 'object' || manifest.parameters === null) {
    throw new CheckerError('INVALID_MANIFEST', 'JS behavior parameters must be an object')
  }
  readDependencies(manifest.dependencies)
  return manifest as JsBehaviorManifest
}

function readManifest(code: string, timeoutMs: number): JsBehaviorManifest {
  let captured: unknown
  const context = vm.createContext({
    defineBehavior: (value: unknown) => { captured = value },
  })
  try {
    vm.runInContext(code, context, { timeout: timeoutMs })
  } catch (error) {
    throw new CheckerError('JS_LOAD_FAILED', error instanceof Error ? error.message : String(error))
  }
  if (typeof captured !== 'object' || captured === null) {
    throw new CheckerError('INVALID_MANIFEST', 'JS behavior must call defineBehavior({ manifest, run })')
  }
  const module = captured as { manifest?: unknown; run?: unknown }
  if (typeof module.run !== 'function') {
    throw new CheckerError('INVALID_MANIFEST', 'JS behavior must provide a generator function run(ctx)')
  }
  if (Object.prototype.toString.call(module.run) !== '[object GeneratorFunction]') {
    throw new CheckerError('INVALID_MANIFEST', 'JS behavior run(ctx) must be a synchronous generator function')
  }
  return validateManifest(module.manifest)
}

function readDependencies(value: unknown): JsBehaviorDependencies {
  if (value === undefined) return { acts: [], policies: [] }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CheckerError('INVALID_MANIFEST', 'JS behavior dependencies must be an object')
  }
  const record = value as { acts?: unknown; policies?: unknown }
  return {
    acts: readDefinitionList(record.acts, 'acts'),
    policies: readDefinitionList(record.policies, 'policies'),
  }
}

function readDefinitionList(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new CheckerError('INVALID_MANIFEST', `JS behavior dependencies.${field} must be an array`)
  }
  const names: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new CheckerError('INVALID_MANIFEST', `JS behavior dependencies.${field} must contain definition ids`)
    }
    if (!names.includes(entry)) names.push(entry)
  }
  return names
}

export async function checkBehaviorJs(request: BehaviorJsCheckRequest): Promise<BehaviorJsCheckResult> {
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
  const code = bytes.toString('utf8')
  const forbidden = forbiddenIn(code)
  if (forbidden !== undefined) {
    const { line, column } = lineColumn(code, forbidden.index)
    throw new CheckerError(
      'FORBIDDEN_SYNTAX',
      `line ${line}, column ${column}: JS behavior must not use ${forbidden.token}`,
    )
  }
  const normalizedRelative = relativePath.split(sep).join('/')
  const sourceHash = sourceDigest([{ path: normalizedRelative, bytes }])
  const manifestInfo = request.loadManifest === undefined
    ? readManifest(code, request.timeoutMs ?? 1000)
    : validateManifest(await request.loadManifest(code, `p2:behavior:check-${sourceHash.slice(0, 16)}`))
  const declared = readDependencies(manifestInfo.dependencies)
  const dependencies: ArtifactManifest['dependencies'] = []
  const resolved: { acts: Record<string, string>; policies: Record<string, string> } = { acts: {}, policies: {} }
  for (const kind of ['act', 'policy'] as const) {
    const names = kind === 'act' ? declared.acts : declared.policies
    for (const definitionId of names) {
      const artifact = request.resolveDependency?.(kind, definitionId)
      if (artifact === undefined) {
        throw new CheckerError(
          'DEPENDENCY_NOT_FOUND',
          `${kind} ${definitionId} is not available in binding ${request.bindingId}`,
        )
      }
      if (kind === 'act') resolved.acts[definitionId] = artifact.artifactId
      else resolved.policies[definitionId] = artifact.artifactId
      if (!dependencies.some(entry => entry.kind === kind && entry.id === artifact.artifactId)) {
        dependencies.push({ kind, id: artifact.artifactId, digest: artifact.digest })
      }
    }
  }
  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    kind: 'behavior',
    definitionId: manifestInfo.id,
    sourceDigest: sourceHash,
    irVersion: 0,
    irDigest: null,
    codeDigest: createHash('sha256').update(bytes).digest('hex'),
    buildToolVersion: CHECKER_VERSION,
    bindingId: request.bindingId,
    dependencies,
  }
  const artifact: BehaviorArtifact = {
    kind: 'behavior',
    format: 'js',
    code,
    resolvedDependencies: resolved,
    definition: jsBehaviorDefinition(manifestInfo),
    manifest,
    artifactId: artifactId(manifest),
    artifactDigest: artifactDigest(manifest),
    bindingId: request.bindingId,
    sourceDigest: sourceHash,
  }
  return {
    artifact,
    credential: {
      checkerVersion: CHECKER_VERSION,
      bindingId: request.bindingId,
      network: false,
      builtinsDigest: request.builtinsDigest ?? 'none',
    },
  }
}


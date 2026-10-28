import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import vm from 'node:vm'

import { artifactDigest, artifactId, sourceDigest } from '../contracts/digest.ts'
import type { BehaviorArtifact, BehaviorDefinition } from '../contracts/ir.ts'
import type { ArtifactManifest } from '../contracts/types.ts'
import { forbiddenToken } from './act-checker.ts'
import { CHECKER_VERSION, CheckerError } from './checker.ts'
import type { CheckerCredential } from './checker.ts'

export type BehaviorJsCheckRequest = {
  sourcePath: string
  sourceRoot?: string
  bindingId: string
  builtinsDigest?: string
  timeoutMs?: number
}

export type BehaviorJsCheckResult = {
  artifact: BehaviorArtifact
  credential: CheckerCredential
}

type JsBehaviorManifest = {
  id: string
  description?: string
  mode: 'finite' | 'continuous'
  parameters: Record<string, unknown>
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
  if (typeof module.manifest !== 'object' || module.manifest === null) {
    throw new CheckerError('INVALID_MANIFEST', 'JS behavior manifest must be an object')
  }
  const manifest = module.manifest as Partial<JsBehaviorManifest>
  if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
    throw new CheckerError('INVALID_MANIFEST', 'JS behavior manifest.id is required')
  }
  if (manifest.mode !== 'finite' && manifest.mode !== 'continuous') {
    throw new CheckerError('INVALID_MANIFEST', 'JS behavior mode must be finite or continuous')
  }
  if (typeof manifest.parameters !== 'object' || manifest.parameters === null) {
    throw new CheckerError('INVALID_MANIFEST', 'JS behavior parameters must be an object')
  }
  return manifest as JsBehaviorManifest
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
  const token = forbiddenToken(code)
  if (token !== undefined) {
    throw new CheckerError('FORBIDDEN_SYNTAX', `JS behavior must not use ${token}`)
  }
  const manifestInfo = readManifest(code, request.timeoutMs ?? 1000)
  const normalizedRelative = relativePath.split(sep).join('/')
  const sourceHash = sourceDigest([{ path: normalizedRelative, bytes }])
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
    dependencies: [],
  }
  const artifact: BehaviorArtifact = {
    kind: 'behavior',
    format: 'js',
    code,
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

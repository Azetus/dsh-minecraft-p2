/**
 * Checker for strategy artifacts. The module is loaded in a throwaway vm to
 * capture `defineStrategy({ manifest, evaluate })`; act dependencies are
 * resolved to exact artifact ids so the strategy can only propose content that
 * exists in its binding.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import vm from 'node:vm'

import { artifactDigest, artifactId, sourceDigest } from '../contracts/digest.ts'
import type { StrategyArtifact } from '../contracts/artifacts.ts'
import { StrategyManifestError, parseStrategyManifest } from '../contracts/strategy.ts'
import type { StrategyManifest } from '../contracts/strategy.ts'
import type { ArtifactManifest } from '../contracts/types.ts'
import { CHECKER_VERSION, CheckerError } from './checker-errors.ts'
import type { CheckerCredential } from './checker-errors.ts'
import { forbiddenIn, lineColumn } from './js-forbidden.ts'

export type StrategyCheckRequest = {
  sourcePath: string
  sourceRoot?: string
  bindingId: string
  timeoutMs?: number
  builtinsDigest?: string
  /** Resolve an act definitionId to the enabled exact artifact for this binding. */
  resolveAct?: (definitionId: string) => { artifactId: string; digest: string } | undefined
}

export type StrategyCheckResult = {
  artifact: StrategyArtifact
  credential: CheckerCredential
}

type LoadedStrategy = {
  manifest: StrategyManifest
  evaluate: (...args: unknown[]) => unknown
}

function loadModule(code: string, timeoutMs: number): LoadedStrategy {
  let captured: unknown
  const context = vm.createContext({
    defineStrategy: (value: unknown) => { captured = value },
  })
  try {
    vm.runInContext(code, context, { timeout: timeoutMs })
  } catch (error) {
    throw new CheckerError('JS_LOAD_FAILED', error instanceof Error ? error.message : String(error))
  }
  if (typeof captured !== 'object' || captured === null) {
    throw new CheckerError('INVALID_STRATEGY_MANIFEST', 'strategy must call defineStrategy({ manifest, evaluate })')
  }
  const module = captured as { manifest?: unknown; evaluate?: unknown }
  if (typeof module.evaluate !== 'function') {
    throw new CheckerError('INVALID_STRATEGY_MANIFEST', 'strategy must provide a synchronous evaluate(ctx) function')
  }
  const tag = Object.prototype.toString.call(module.evaluate)
  if (tag === '[object AsyncFunction]' || tag === '[object GeneratorFunction]') {
    throw new CheckerError('INVALID_STRATEGY_MANIFEST', 'strategy evaluate(ctx) must be a plain synchronous function')
  }
  if (module.evaluate.length !== 1) {
    throw new CheckerError('INVALID_STRATEGY_MANIFEST', 'strategy evaluate must take exactly one ctx argument')
  }
  let manifest: StrategyManifest
  try {
    manifest = parseStrategyManifest(module.manifest)
  } catch (error) {
    if (error instanceof StrategyManifestError) throw new CheckerError(error.code, error.message)
    throw error
  }
  return { manifest, evaluate: module.evaluate as (...args: unknown[]) => unknown }
}

export async function checkStrategyJs(request: StrategyCheckRequest): Promise<StrategyCheckResult> {
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
      `line ${line}, column ${column}: strategy must not use ${forbidden.token}`,
    )
  }

  const normalizedRelative = relativePath.split(sep).join('/')
  const sourceHash = sourceDigest([{ path: normalizedRelative, bytes }])
  const module = loadModule(code, request.timeoutMs ?? 1000)
  const declaredActs = module.manifest.acts ?? []
  const resolvedActs: Record<string, string> = {}
  const dependencies: ArtifactManifest['dependencies'] = []
  for (const definitionId of declaredActs) {
    const artifact = request.resolveAct?.(definitionId)
    if (artifact === undefined) {
      throw new CheckerError(
        'DEPENDENCY_NOT_FOUND',
        `act ${definitionId} has no enabled artifact in binding ${request.bindingId}; check and activate it first`,
      )
    }
    resolvedActs[definitionId] = artifact.artifactId
    if (!dependencies.some(entry => entry.kind === 'act' && entry.id === artifact.artifactId)) {
      dependencies.push({ kind: 'act', id: artifact.artifactId, digest: artifact.digest })
    }
  }

  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    kind: 'strategy',
    definitionId: module.manifest.id,
    sourceDigest: sourceHash,
    codeDigest: createHash('sha256').update(bytes).digest('hex'),
    buildToolVersion: CHECKER_VERSION,
    bindingId: request.bindingId,
    dependencies,
  }
  const artifact: StrategyArtifact = {
    kind: 'strategy',
    definitionId: module.manifest.id,
    version: module.manifest.version,
    slot: module.manifest.slot,
    facts: [...module.manifest.facts],
    acts: [...declaredActs],
    resolvedActs,
    code,
    manifest,
    artifactId: artifactId(manifest),
    artifactDigest: artifactDigest(manifest),
    bindingId: request.bindingId,
    sourceDigest: sourceHash,
    ...(module.manifest.hazardClass === undefined ? {} : { hazardClass: module.manifest.hazardClass }),
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




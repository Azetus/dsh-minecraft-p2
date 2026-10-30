import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import { artifactDigest, artifactId, canonicalJson, sourceDigest } from '../contracts/digest.ts'
import type { OpArtifact } from '../contracts/artifacts.ts'
import type { ArtifactManifest, JsonValue } from '../contracts/types.ts'
import { CHECKER_VERSION, CheckerError } from './checker-errors.ts'
import type { CheckerCredential } from './checker-errors.ts'
import { forbiddenToken } from './act-checker.ts'
import { OpLoadError, loadOpModule } from './op-artifact.ts'

export type OpCheckRequest = {
  sourcePath: string
  sourceRoot?: string
  bindingId: string
  builtinsDigest?: string
  timeoutMs?: number
}

export type OpCheckResult = {
  artifact: OpArtifact
  credential: CheckerCredential
}

export type ParsedOpManifest = {
  name: string
  opKind: 'query' | 'control'
  effects: 'none' | 'active'
  stop: 'none' | 'poll'
  capabilities: string[]
  parameters?: JsonValue
  resultSchema?: JsonValue
  limits?: { totalMs?: number }
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/u
const MAX_SCHEMA_BYTES = 64 * 1024

/**
 * Check an authored operation: syntax, `defineOp` assembly and manifest shape.
 * It never connects to the game and deliberately does not review the code.
 */
export async function checkOp(request: OpCheckRequest): Promise<OpCheckResult> {
  const sourcePath = resolve(request.sourcePath)
  const sourceRoot = resolve(request.sourceRoot ?? dirname(sourcePath))
  const relativePath = relative(sourceRoot, sourcePath)
  if (relativePath === '' || relativePath.startsWith('..') || relativePath.split(sep).includes('..')) {
    throw new CheckerError('SOURCE_OUTSIDE_ROOT', 'source path must be inside the source root')
  }
  let realRoot: string
  let realSource: string
  try {
    realRoot = await realpath(sourceRoot)
    realSource = await realpath(sourcePath)
  } catch (error) {
    throw new CheckerError('SOURCE_UNREADABLE', error instanceof Error ? error.message : String(error))
  }
  const realRelative = relative(realRoot, realSource)
  if (realRelative.startsWith('..') || realRelative.split(sep).includes('..')) {
    throw new CheckerError('SOURCE_OUTSIDE_ROOT', 'source path escapes the source root through a link')
  }

  let bytes: Buffer
  try {
    bytes = await readFile(realSource)
  } catch (error) {
    throw new CheckerError('SOURCE_UNREADABLE', error instanceof Error ? error.message : String(error))
  }
  const code = bytes.toString('utf8')
  const token = forbiddenToken(code)
  if (token !== undefined) {
    throw new CheckerError('FORBIDDEN_SYNTAX', `op code must not use ${token}; ops are single-file modules`)
  }

  const normalizedRelative = relativePath.split(sep).join('/')
  const sourceHash = sourceDigest([{ path: normalizedRelative, bytes }])

  let captured: unknown
  let module: unknown
  try {
    const loaded = loadOpModule(code, request.timeoutMs ?? 1000)
    module = loaded.module
    captured = loaded.module.manifest
  } catch (error) {
    if (error instanceof OpLoadError) throw new CheckerError(error.code, error.message)
    throw new CheckerError('OP_LOAD_FAILED', error instanceof Error ? error.message : String(error))
  }
  const info = parseOpManifest(captured)
  requireImplementation(module, info.opKind, info.name)

  const codeDigest = createHash('sha256').update(bytes).digest('hex')
  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    kind: 'op',
    definitionId: info.name,
    sourceDigest: sourceHash,
    codeDigest: `sha256:${codeDigest}`,
    buildToolVersion: CHECKER_VERSION,
    bindingId: request.bindingId,
    dependencies: [],
    op: {
      opKind: info.opKind,
      effects: info.effects,
      stop: info.stop,
      capabilities: info.capabilities,
      ...(info.parameters === undefined ? {} : { parameters: info.parameters }),
      ...(info.resultSchema === undefined ? {} : { result: info.resultSchema }),
    },
    ...(info.limits === undefined ? {} : { limits: info.limits }),
  }
  const artifact: OpArtifact = {
    kind: 'op',
    definitionId: info.name,
    code,
    opKind: info.opKind,
    effects: info.effects,
    stop: info.stop,
    capabilities: info.capabilities,
    ...(info.parameters === undefined ? {} : { parameters: info.parameters }),
    ...(info.resultSchema === undefined ? {} : { resultSchema: info.resultSchema }),
    ...(info.limits === undefined ? {} : { limits: info.limits }),
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

/** Validate the manifest shape; unknown fields are ignored, not promoted. */
export function parseOpManifest(value: unknown): ParsedOpManifest {  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CheckerError('INVALID_OP_MANIFEST', 'op manifest must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) {
    throw new CheckerError('INVALID_OP_MANIFEST', 'op manifest schemaVersion must be 1')
  }
  if (record.kind !== 'op') {
    throw new CheckerError('INVALID_OP_MANIFEST', 'op manifest kind must be "op"')
  }
  const name = record.name
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new CheckerError('INVALID_OP_MANIFEST', 'op manifest name must be a bare identifier such as "scan" or "dig-area"')
  }
  const opKind = record.opKind
  if (opKind !== 'query' && opKind !== 'control') {
    throw new CheckerError('INVALID_OP_MANIFEST', 'op manifest opKind must be query or control')
  }
  const effects = readEffects(record.effects, opKind)
  const stop = readStop(record.stop, opKind, effects)
  const capabilities = readCapabilities(record.capabilities)
  const parameters = readSchema(record.parameters, 'parameters')
  const resultSchema = readSchema(record.result, 'result')
  const limits = readLimits(record.limits)
  return {
    name,
    opKind,
    effects,
    stop,
    capabilities,
    ...(parameters === undefined ? {} : { parameters }),
    ...(resultSchema === undefined ? {} : { resultSchema }),
    ...(limits === undefined ? {} : { limits }),
  }
}

function readEffects(value: unknown, opKind: 'query' | 'control'): 'none' | 'active' {
  if (opKind === 'query') {
    if (value !== undefined && value !== 'none') {
      throw new CheckerError('INVALID_OP_MANIFEST', 'a query op cannot declare an active effect')
    }
    return 'none'
  }
  if (value === undefined) return 'active'
  if (value !== 'none' && value !== 'active') {
    throw new CheckerError('INVALID_OP_MANIFEST', 'op manifest effects must be none or active')
  }
  return value
}

function readStop(
  value: unknown,
  opKind: 'query' | 'control',
  effects: 'none' | 'active',
): 'none' | 'poll' {
  if (opKind === 'query') {
    if (value !== undefined && value !== 'none') {
      throw new CheckerError('INVALID_OP_MANIFEST', 'a query op cannot declare a stop mode')
    }
    return 'none'
  }
  if (value === undefined) return effects === 'active' ? 'poll' : 'none'
  if (value !== 'none' && value !== 'poll') {
    throw new CheckerError('INVALID_OP_MANIFEST', 'op manifest stop must be none or poll')
  }
  return value
}

function readCapabilities(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new CheckerError('INVALID_OP_MANIFEST', 'op manifest capabilities must be an array')
  }
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new CheckerError('INVALID_OP_MANIFEST', 'op manifest capabilities must be non-empty strings')
    }
    if (!result.includes(item)) result.push(item)
  }
  return result.sort()
}

function readSchema(value: unknown, field: string): JsonValue | undefined {
  if (value === undefined) return undefined
  let encoded: string
  try {
    encoded = canonicalJson(value as JsonValue)
  } catch {
    throw new CheckerError('INVALID_OP_MANIFEST', `op manifest ${field} must be plain JSON`)
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_SCHEMA_BYTES) {
    throw new CheckerError('INVALID_OP_MANIFEST', `op manifest ${field} exceeds ${MAX_SCHEMA_BYTES} bytes`)
  }
  return JSON.parse(encoded) as JsonValue
}

function readLimits(value: unknown): { totalMs?: number } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CheckerError('INVALID_OP_MANIFEST', 'op manifest limits must be an object')
  }
  const record = value as Record<string, unknown>
  const limits: { totalMs?: number } = {}
  if (record.totalMs !== undefined) {
    if (typeof record.totalMs !== 'number' || !Number.isFinite(record.totalMs) || record.totalMs <= 0) {
      throw new CheckerError('INVALID_OP_MANIFEST', 'limits.totalMs must be a positive number')
    }
    limits.totalMs = record.totalMs
  }
  return Object.keys(limits).length === 0 ? undefined : limits
}

function requireImplementation(module: unknown, opKind: 'query' | 'control', name: string): void {
  const record = module as { query?: unknown; start?: unknown }
  if (opKind === 'query' && typeof record.query !== 'function') {
    throw new CheckerError('INVALID_OP_MANIFEST', `query op ${name} must provide query(ctx, args)`)
  }
  if (opKind === 'control' && typeof record.start !== 'function') {
    throw new CheckerError('INVALID_OP_MANIFEST', `control op ${name} must provide start(ctx, args)`)
  }
}



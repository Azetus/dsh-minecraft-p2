import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import { artifactDigest, artifactId, sourceDigest } from '../contracts/digest.ts'
import type { ActArtifact, ActLimits } from '../contracts/ir.ts'
import type { ArtifactManifest, JsonValue } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import { requireOperation } from '../operation/index.ts'
import type { OperationContract } from '../operation/index.ts'
import { CHECKER_VERSION, CheckerError } from './checker.ts'
import type { CheckerCredential } from './checker.ts'

export type ActCheckRequest = {
  sourcePath: string
  sourceRoot?: string
  bindingId: string
  /** Loads the code in a sandbox and returns its manifest (no host access). */
  loadManifest: (code: string, artifactId: string) => Promise<JsonValue>
  /** An activated authored op declaration that is not in the static catalog. */
  resolveOperation?: (name: string) => OperationContract | undefined
  builtinsDigest?: string
  timeoutMs?: number
}

export type ActCheckResult = {
  artifact: ActArtifact
  credential: CheckerCredential
}

/** Tokens that must not appear in a single-file act artifact. */
const FORBIDDEN = /(?<![\w$])(import|require|eval|Function|WebAssembly|process|globalThis\.process|fetch|XMLHttpRequest)(?![\w$])/gu

export function forbiddenToken(code: string): string | undefined {
  const match = FORBIDDEN.exec(code)
  FORBIDDEN.lastIndex = 0
  return match?.[0]
}

export async function checkAct(request: ActCheckRequest): Promise<ActCheckResult> {
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
    throw new CheckerError('FORBIDDEN_SYNTAX', `act code must not use ${token}; acts are single-file and sandboxed`)
  }

  const normalizedRelative = relativePath.split(sep).join('/')
  const sourceHash = sourceDigest([{ path: normalizedRelative, bytes }])
  const provisionalId = `p2:act:check-${sourceHash.slice(0, 16)}`
  const loaded = await request.loadManifest(code, provisionalId)
  const info = parseActManifest(loaded)

  const queryOps = [...new Set(info.queryOps)].sort()
  const controlOps = [...new Set(info.controlOps)].sort()
  for (const op of queryOps) requireDeclaredOperation(op, 'query', request.resolveOperation)
  for (const op of controlOps) requireDeclaredOperation(op, 'control', request.resolveOperation)

  const codeDigest = createHash('sha256').update(bytes).digest('hex')
  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    kind: 'act',
    definitionId: info.id,
    sourceDigest: sourceHash,
    irVersion: 1,
    irDigest: null,
    codeDigest: `sha256:${codeDigest}`,
    buildToolVersion: CHECKER_VERSION,
    bindingId: request.bindingId,
    dependencies: [],
    ops: { query: queryOps, control: controlOps },
    ...(info.limits === undefined ? {} : { limits: info.limits }),
  }
  const digestValue = artifactDigest(manifest)
  const id = artifactId(manifest)
  return {
    artifact: {
      kind: 'act',
      definitionId: info.id,
      code,
      ops: { query: queryOps, control: controlOps },
      ...(info.limits === undefined ? {} : { limits: info.limits }),
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

function parseActManifest(value: JsonValue): { id: string; queryOps: string[]; controlOps: string[]; limits?: ActLimits } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CheckerError('INVALID_ACT_MANIFEST', 'act manifest must be an object')
  }
  const record = value as Record<string, JsonValue>
  const id = record.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new CheckerError('INVALID_ACT_MANIFEST', 'act manifest requires a non-empty id')
  }
  const queryOps = stringList(record.queryOps, 'queryOps')
  const controlOps = stringList(record.controlOps, 'controlOps')
  let limits: ActLimits | undefined
  if (record.limits !== undefined) {
    if (record.limits === null || typeof record.limits !== 'object' || Array.isArray(record.limits)) {
      throw new CheckerError('INVALID_ACT_MANIFEST', 'act limits must be an object')
    }
    const raw = record.limits as Record<string, JsonValue>
    limits = {}
    if (raw.totalMs !== undefined) {
      if (typeof raw.totalMs !== 'number' || !Number.isFinite(raw.totalMs) || raw.totalMs <= 0) {
        throw new CheckerError('INVALID_ACT_MANIFEST', 'limits.totalMs must be a positive number')
      }
      limits.totalMs = raw.totalMs
    }
    if (raw.hookMs !== undefined) {
      if (typeof raw.hookMs !== 'number' || !Number.isFinite(raw.hookMs) || raw.hookMs <= 0) {
        throw new CheckerError('INVALID_ACT_MANIFEST', 'limits.hookMs must be a positive number')
      }
      limits.hookMs = raw.hookMs
    }
  }
  return {
    id,
    queryOps,
    controlOps,
    ...(limits === undefined ? {} : { limits }),
  }
}

function stringList(value: JsonValue | undefined, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new CheckerError('INVALID_ACT_MANIFEST', `act manifest ${field} must be an array`)
  }
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new CheckerError('INVALID_ACT_MANIFEST', `act manifest ${field} entries must be non-empty strings`)
    }
    result.push(item)
  }
  return result
}

/** Prefer an activated authored declaration, then the static operation catalog. */
function requireDeclaredOperation(
  op: string,
  kind: 'query' | 'control',
  resolve: ActCheckRequest['resolveOperation'],
): OperationContract {
  const resolved = resolve?.(op)
  if (resolved === undefined) return requireOperation(op, kind, 'core.act-checker')
  if (resolved.kind !== kind) {
    throw p2Error(
      'OP_KIND_MISMATCH',
      'validation',
      `operation ${op} is ${resolved.kind}, not ${kind}`,
      { module: 'core.act-checker', opId: op },
      { operation: op, expected: kind, actual: resolved.kind },
    )
  }
  return resolved
}

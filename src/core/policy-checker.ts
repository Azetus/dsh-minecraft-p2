import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import { artifactDigest, artifactId, sourceDigest } from '../contracts/digest.ts'
import type { PolicyArtifact } from '../contracts/artifacts.ts'
import type { ArtifactManifest, JsonValue } from '../contracts/types.ts'
import { CHECKER_VERSION, CheckerError } from './checker-errors.ts'
import type { CheckerCredential } from './checker-errors.ts'
import { forbiddenToken } from './act-checker.ts'

export type PolicyCheckRequest = {
  sourcePath: string
  sourceRoot?: string
  bindingId: string
  loadManifest: (code: string, artifactId: string) => Promise<JsonValue>
  builtinsDigest?: string
}

export type PolicyCheckResult = {
  artifact: PolicyArtifact
  credential: CheckerCredential
}

export async function checkPolicy(request: PolicyCheckRequest): Promise<PolicyCheckResult> {
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
    throw new CheckerError('FORBIDDEN_SYNTAX', `policy code must not use ${token}; policies are pure single-file functions`)
  }

  const normalizedRelative = relativePath.split(sep).join('/')
  const sourceHash = sourceDigest([{ path: normalizedRelative, bytes }])
  const provisionalId = `p2:policy:check-${sourceHash.slice(0, 16)}`
  const loaded = await request.loadManifest(code, provisionalId)
  const info = parsePolicyManifest(loaded)

  const codeDigest = createHash('sha256').update(bytes).digest('hex')
  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    kind: 'policy',
    definitionId: info.id,
    sourceDigest: sourceHash,
    codeDigest: `sha256:${codeDigest}`,
    buildToolVersion: CHECKER_VERSION,
    bindingId: request.bindingId,
    dependencies: [],
  }
  const digestValue = artifactDigest(manifest)
  const id = artifactId(manifest)
  return {
    artifact: {
      kind: 'policy',
      definitionId: info.id,
      code,
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

function parsePolicyManifest(value: JsonValue): { id: string; inputs: string[]; outputs: string[] } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CheckerError('INVALID_POLICY_MANIFEST', 'policy manifest must be an object')
  }
  const record = value as Record<string, JsonValue>
  const id = record.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new CheckerError('INVALID_POLICY_MANIFEST', 'policy manifest requires a non-empty id')
  }
  return {
    id,
    inputs: stringList(record.inputs, 'inputs'),
    outputs: stringList(record.outputs, 'outputs'),
  }
}

function stringList(value: JsonValue | undefined, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new CheckerError('INVALID_POLICY_MANIFEST', `policy manifest ${field} must be an array`)
  }
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new CheckerError('INVALID_POLICY_MANIFEST', `policy manifest ${field} entries must be non-empty strings`)
    }
    result.push(item)
  }
  return result
}



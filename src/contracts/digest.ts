import { createHash } from 'node:crypto'

import type { BindingManifest, BodyManifest, JsonValue } from './types.ts'

export const DIGEST_DOMAIN = {
  body: 'p2-body-v1',
  binding: 'p2-binding-v1',
} as const

/** Serialize a JSON value with sorted object keys; arrays keep their order. */
export function canonicalJson(value: JsonValue): string {
  return serialize(value, new Set<object>())
}

function serialize(value: JsonValue, stack: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers')
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        if (stack.has(value)) throw new Error('canonical JSON rejects cycles')
        stack.add(value)
        const encoded = value.map(item => serialize(item, stack))
        stack.delete(value)
        return `[${encoded.join(',')}]`
      }
      if (stack.has(value)) throw new Error('canonical JSON rejects cycles')
      stack.add(value)
      const record = value as Record<string, JsonValue>
      const encoded = Object.keys(record)
        .sort(compareKeys)
        .map(key => `${JSON.stringify(key)}:${serialize(record[key] as JsonValue, stack)}`)
      stack.delete(value)
      return `{${encoded.join(',')}}`
    }
    default:
      throw new Error(`canonical JSON rejects ${typeof value}`)
  }
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Normalize a project-relative path to `/` separators and reject escapes. */
export function normalizeRelativePath(path: string): string {
  if (path.includes('\0')) throw new Error('path contains NUL')
  const replaced = path.replaceAll('\\', '/')
  if (replaced.startsWith('/') || /^[A-Za-z]:\//u.test(replaced)) {
    throw new Error(`absolute path is not allowed: ${path}`)
  }
  const parts: string[] = []
  for (const part of replaced.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') throw new Error(`path escapes the root: ${path}`)
    parts.push(part)
  }
  if (parts.length === 0) throw new Error(`path is empty: ${path}`)
  return parts.join('/')
}

/** SHA-256 of raw bytes, as lowercase hex. */
export function bytesDigest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Domain-separated SHA-256 over canonical JSON. */
export function digest(kind: string, value: JsonValue): string {
  return bytesDigest(`${kind}\u0000${canonicalJson(value)}`)
}

/** Digest the body manifest, excluding any fields not declared by the shape. */
export function bodyManifestDigest(manifest: BodyManifest): string {
  return digest(DIGEST_DOMAIN.body, {
    schemaVersion: 1,
    bodyVersion: manifest.bodyVersion,
    protocolVersion: manifest.protocolVersion,
    entry: manifest.entry,
    files: sortedRecord(manifest.files),
  })
}

/** Build the canonical binding manifest, discarding audit-only fields. */
export function normalizeBindingManifest(manifest: BindingManifest): BindingManifest {
  return {
    schemaVersion: 1,
    body: {
      version: manifest.body.version,
      protocolVersion: manifest.body.protocolVersion,
      manifestDigest: manifest.body.manifestDigest,
    },
    provider: manifest.provider === null
      ? null
      : {
          id: manifest.provider.id,
          version: manifest.provider.version,
          manifestDigest: manifest.provider.manifestDigest,
        },
    irVersion: manifest.irVersion,
    opContractVersion: manifest.opContractVersion,
    capabilities: [...new Set(manifest.capabilities)].sort(compareKeys),
    driver: manifest.driver ?? null,
    config: manifest.config,
  }
}

/** Content identity for an execution environment. */
export function bindingId(manifest: BindingManifest): string {
  return digest(DIGEST_DOMAIN.binding, normalizeBindingManifest(manifest))
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, value]) => [normalizeRelativePath(key), value] as const)
      .sort(([left], [right]) => compareKeys(left, right)),
  )
}

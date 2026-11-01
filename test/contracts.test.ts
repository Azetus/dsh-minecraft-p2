import { describe, expect, it } from 'vitest'

import {
  bindingId,
  bodyManifestDigest,
  canonicalJson,
  digest,
  normalizeRelativePath,
} from '../src/contracts/index.ts'
import type {
  BindingManifest,
  BodyManifest,
  JsonValue,
} from '../src/contracts/index.ts'

const binding: BindingManifest = {
  schemaVersion: 1,
  body: {
    version: '0.1.0',
    protocolVersion: 1,
    manifestDigest: 'a'.repeat(64),
  },
  provider: null,
  irVersion: 1,
  opContractVersion: '1',
  capabilities: ['query.inventory', 'control.move'],
  driver: null,
  config: { tickMs: 100 },
}

const body: BodyManifest = {
  schemaVersion: 1,
  bodyVersion: '0.1.0',
  protocolVersion: 1,
  entry: 'body.mjs',
  files: { 'body.mjs': 'b'.repeat(64) },
}

describe('canonical JSON and digests', () => {
  it('sorts object keys but preserves array order', () => {
    expect(canonicalJson({ b: 1, a: [2, 3] })).toBe('{"a":[2,3],"b":1}')
    expect(canonicalJson({ a: [2, 3] })).not.toBe(canonicalJson({ a: [3, 2] }))
  })

  it('rejects values that are not finite JSON', () => {
    expect(() => canonicalJson(Number.NaN as unknown as JsonValue)).toThrow(/non-finite/)
    expect(() => canonicalJson({ x: Infinity as unknown as JsonValue })).toThrow(/non-finite/)
  })

  it('rejects cyclic values instead of hashing a self-reference', () => {
    const cyclic: Record<string, JsonValue> = {}
    cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrow(/cycles/)
  })

  it('separates digest domains', () => {
    expect(digest('p2-a-v1', { x: 1 })).not.toBe(digest('p2-b-v1', { x: 1 }))
  })

  it('produces a stable fixed digest for a fixed canonical value', () => {
    expect(digest('p2-test-v1', { b: 2, a: [1, 2] }))
      .toBe('481daf299a8179989cacf56bd7ccb07851c61c18197feda5949c6b44b9294cde')
  })

  it('normalizes relative paths and rejects escapes', () => {
    expect(normalizeRelativePath('a\\b\\c.txt')).toBe('a/b/c.txt')
    expect(() => normalizeRelativePath('C:/secret.txt')).toThrow(/absolute/)
    expect(() => normalizeRelativePath('/secret.txt')).toThrow(/absolute/)
    expect(() => normalizeRelativePath('a/../secret.txt')).toThrow(/escapes/)
  })
})

describe('manifest identities', () => {
  it('ignores audit metadata outside the declared manifest shape', () => {
    const audited = { ...binding, checkedAt: '2026-10-27T00:00:00Z' } as BindingManifest
    expect(bindingId(audited)).toBe(bindingId(binding))
  })

  it('does not depend on capability order or duplicates', () => {
    const reordered = {
      ...binding,
      capabilities: ['control.move', 'query.inventory', 'query.inventory'],
    }
    expect(bindingId(reordered)).toBe(bindingId(binding))
    expect(bindingId(binding)).toBe('c4616e39fd5dea53382b16ff0d3d76de4c6c21ade23268523e31679cb6a19dd8')
  })

  it('changes when body, provider, IR, contract or config changes', () => {
    expect(bindingId({ ...binding, irVersion: 2 })).not.toBe(bindingId(binding))
    expect(bindingId({ ...binding, opContractVersion: '2' })).not.toBe(bindingId(binding))
    expect(bindingId({ ...binding, config: { tickMs: 50 } })).not.toBe(bindingId(binding))
    expect(bindingId({
      ...binding,
      body: { ...binding.body, manifestDigest: '9'.repeat(64) },
    })).not.toBe(bindingId(binding))
  })

  it('ignores body audit fields and stays stable for the same files', () => {
    const audited = { ...body, checkedAt: '2026-10-27T00:00:00Z' } as BodyManifest
    expect(bodyManifestDigest(audited)).toBe(bodyManifestDigest(body))
  })
})

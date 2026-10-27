import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { checkBehavior, CheckerError } from '../src/core/checker.ts'
import { ArtifactRegistry, RegistryError } from '../src/core/registry.ts'
import type { CheckerCredential } from '../src/core/checker.ts'
import { artifactDigest, artifactId } from '../src/contracts/digest.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function sourceDirectory(): string {
  const directory = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-checker-'))
  directories.push(directory)
  return directory
}

function writeSource(directory: string, name: string, body: string): string {
  const path = join(directory, name)
  writeFileSync(path, body)
  return path
}

const validSource = `
export default {
  id: 'check-behavior',
  description: 'checker fixture',
  mode: 'finite',
  parameters: {},
  locals: {},
  root: { kind: 'sequence', id: 'root', children: [] },
  completion: { kind: 'predicate', condition: { kind: 'expr', expr: { kind: 'literal', value: true } } },
}
`

describe('checkBehavior isolation', () => {
  it('builds a valid module in a worker and derives a stable artifact id', async () => {
    const directory = sourceDirectory()
    const path = writeSource(directory, 'behavior.mjs', validSource)
    const first = await checkBehavior({ sourcePath: path, bindingId: 'binding-1' })
    const second = await checkBehavior({ sourcePath: path, bindingId: 'binding-1' })
    expect(first.artifact.artifactId).toBe(second.artifact.artifactId)
    expect(first.artifact.manifest.sourceDigest).toBe(first.artifact.sourceDigest)
    expect(first.artifact.manifest.irDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(first.credential.network).toBe(false)
  })

  it('terminates an infinite build without blocking the host', async () => {
    const directory = sourceDirectory()
    const path = writeSource(directory, 'loop.mjs', 'while (true) {}\n')
    await expect(checkBehavior({ sourcePath: path, bindingId: 'binding-1', timeoutMs: 100 }))
      .rejects.toMatchObject({ code: 'CHECK_TIMEOUT' })
  })

  it('rejects invalid IR and missing exports', async () => {
    const directory = sourceDirectory()
    const duplicate = writeSource(directory, 'duplicate.mjs', validSource.replace(
      "root: { kind: 'sequence', id: 'root', children: [] }",
      "root: { kind: 'sequence', id: 'root', children: [{ kind: 'wait', id: 'root', durationMs: 1 }] }",
    ))
    await expect(checkBehavior({ sourcePath: duplicate, bindingId: 'binding-1' }))
      .rejects.toBeInstanceOf(CheckerError)

    const missing = writeSource(directory, 'missing.mjs', 'export const value = 1\n')
    await expect(checkBehavior({ sourcePath: missing, bindingId: 'binding-1' }))
      .rejects.toMatchObject({ code: 'CHECK_FAILED' })
  })

  it('rejects a source outside its declared root', async () => {
    const directory = sourceDirectory()
    const path = writeSource(directory, 'outside.mjs', validSource)
    await expect(checkBehavior({
      sourcePath: path,
      sourceRoot: join(directory, 'root'),
      bindingId: 'binding-1',
    })).rejects.toMatchObject({ code: 'SOURCE_OUTSIDE_ROOT' })
  })
})

describe('ArtifactRegistry', () => {
  it('adds, enables, switches and retires per binding', async () => {
    const directory = sourceDirectory()
    const path = writeSource(directory, 'behavior.mjs', validSource)
    const checked = await checkBehavior({ sourcePath: path, bindingId: 'binding-1' })
    const registry = new ArtifactRegistry({ bindingId: 'binding-1' })
    registry.add(checked.artifact, checked.credential)
    expect(registry.resolve()).toBeUndefined()
    registry.enable(checked.artifact.artifactId, checked.credential)
    expect(registry.resolve()?.artifactId).toBe(checked.artifact.artifactId)
    expect(registry.closure(checked.artifact.artifactId)).toHaveLength(1)

    registry.retire(checked.artifact.artifactId)
    expect(registry.resolve()).toBeUndefined()
    expect(() => registry.enable(checked.artifact.artifactId, checked.credential))
      .toThrow(/retired/)
  })

  it('rejects binding, network and builtins mismatches', async () => {
    const directory = sourceDirectory()
    const path = writeSource(directory, 'behavior.mjs', validSource)
    const checked = await checkBehavior({ sourcePath: path, bindingId: 'binding-1' })
    const registry = new ArtifactRegistry({ bindingId: 'binding-2' })
    expect(() => registry.add(checked.artifact, checked.credential))
      .toThrow(RegistryError)
    const own = new ArtifactRegistry({ bindingId: 'binding-1' })
    const network = { ...checked.credential, network: true } as unknown as CheckerCredential
    expect(() => own.add(checked.artifact, network)).toThrow(/network/)
    const builtins: CheckerCredential = { ...checked.credential, builtinsDigest: 'other' }
    expect(() => own.add(checked.artifact, builtins)).toThrow(/built-in/)
  })

  it('rejects an artifact whose id does not match its manifest', async () => {
    const directory = sourceDirectory()
    const path = writeSource(directory, 'behavior.mjs', validSource)
    const checked = await checkBehavior({ sourcePath: path, bindingId: 'binding-1' })
    const registry = new ArtifactRegistry({ bindingId: 'binding-1' })
    const tampered = { ...checked.artifact, artifactDigest: '0'.repeat(64) }
    try {
      registry.add(tampered, checked.credential)
      throw new Error('expected ARTIFACT_INTEGRITY')
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError)
      expect((error as RegistryError).code).toBe('ARTIFACT_INTEGRITY')
    }
  })

  it('keeps H1/H2 bindings isolated and distinguishes artifacts from one source', async () => {
    const directory = sourceDirectory()
    const path = writeSource(directory, 'behavior.mjs', validSource)
    const h1 = await checkBehavior({ sourcePath: path, bindingId: 'binding-1' })
    const h2 = await checkBehavior({ sourcePath: path, bindingId: 'binding-2' })
    expect(h1.artifact.artifactId).not.toBe(h2.artifact.artifactId)
    expect(h1.artifact.sourceDigest).toBe(h2.artifact.sourceDigest)

    const registry1 = new ArtifactRegistry({ bindingId: 'binding-1' })
    const registry2 = new ArtifactRegistry({ bindingId: 'binding-2' })
    registry1.add(h1.artifact, h1.credential)
    registry2.add(h2.artifact, h2.credential)
    registry1.enable(h1.artifact.artifactId, h1.credential)
    registry2.enable(h2.artifact.artifactId, h2.credential)
    registry1.retire(h1.artifact.artifactId)
    expect(registry1.resolve()).toBeUndefined()
    expect(registry2.resolve()?.artifactId).toBe(h2.artifact.artifactId)
  })

  it('rejects an artifact with a missing dependency closure', async () => {
    const directory = sourceDirectory()
    const path = writeSource(directory, 'behavior.mjs', validSource)
    const checked = await checkBehavior({ sourcePath: path, bindingId: 'binding-1' })
    const registry = new ArtifactRegistry({ bindingId: 'binding-1' })
    const manifest = {
      ...checked.artifact.manifest,
      dependencies: [{ kind: 'behavior', id: 'p2:behavior:missing', digest: '0'.repeat(64) }],
    }
    const artifact = {
      ...checked.artifact,
      manifest,
      artifactDigest: artifactDigest(manifest),
      artifactId: artifactId(manifest),
    }
    try {
      registry.add(artifact, checked.credential)
      throw new Error('expected DEPENDENCY_CLOSURE')
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError)
      expect((error as RegistryError).code).toBe('DEPENDENCY_CLOSURE')
    }
  })
})

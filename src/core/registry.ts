import { artifactDigest, artifactId } from '../contracts/digest.ts'
import type { BehaviorArtifact, ContentArtifact } from '../contracts/ir.ts'
import type { CheckerCredential } from './checker.ts'

export type ArtifactRecord = {
  artifact: ContentArtifact
  enabled: boolean
  retired: boolean
}

export class RegistryError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
  }
}

function definitionIdOf(artifact: ContentArtifact): string {
  return artifact.kind === 'behavior' ? artifact.definition.id : artifact.definitionId
}

function defaultKey(artifact: ContentArtifact): string {
  return `${artifact.kind}:${definitionIdOf(artifact)}`
}

/** In-memory, per-binding registry; artifacts are immutable once added. */
export class ArtifactRegistry {
  private readonly records = new Map<string, ArtifactRecord>()
  private readonly defaults = new Map<string, string>()
  private readonly bindingId: string
  private readonly builtinsDigest: string

  constructor(options: { bindingId: string; builtinsDigest?: string }) {
    this.bindingId = options.bindingId
    this.builtinsDigest = options.builtinsDigest ?? 'none'
  }

  add(artifact: ContentArtifact, credential: CheckerCredential): ArtifactRecord {
    this.checkCredential(credential)
    if (artifact.bindingId !== this.bindingId) {
      throw new RegistryError('BINDING_MISMATCH', 'artifact belongs to a different binding')
    }
    const digestValue = artifactDigest(artifact.manifest)
    const id = artifactId(artifact.manifest)
    if (digestValue !== artifact.artifactDigest || id !== artifact.artifactId) {
      throw new RegistryError('ARTIFACT_INTEGRITY', 'artifact id/digest does not match its manifest')
    }
    const existing = this.records.get(id)
    if (existing !== undefined) return existing

    for (const dependency of artifact.manifest.dependencies) {
      const record = this.records.get(dependency.id)
      if (record === undefined || record.artifact.artifactDigest !== dependency.digest) {
        throw new RegistryError('DEPENDENCY_CLOSURE', `dependency ${dependency.id} is not in the registry`)
      }
    }

    const record: ArtifactRecord = { artifact, enabled: false, retired: false }
    this.records.set(id, record)
    return record
  }

  enable(id: string, credential: CheckerCredential): ArtifactRecord {
    this.checkCredential(credential)
    const record = this.require(id)
    if (record.retired) throw new RegistryError('ARTIFACT_RETIRED', `artifact ${id} is retired`)
    record.enabled = true
    this.defaults.set(defaultKey(record.artifact), id)
    return record
  }

  retire(id: string): void {
    const record = this.require(id)
    record.retired = true
    record.enabled = false
    const key = defaultKey(record.artifact)
    if (this.defaults.get(key) === id) this.defaults.delete(key)
  }

  /** Resolve the enabled default for one definition, if any. */
  resolveDefault(kind: 'behavior' | 'act' | 'policy' | 'op', definitionId: string): ContentArtifact | undefined {
    const id = this.defaults.get(`${kind}:${definitionId}`)
    if (id === undefined) return undefined
    const record = this.records.get(id)
    if (record === undefined || record.retired || !record.enabled) return undefined
    return record.artifact
  }

  /** Any checked artifact for one definition; policy artifacts are never enabled. */
  find(kind: 'behavior' | 'act' | 'policy' | 'op', definitionId: string): ContentArtifact | undefined {
    let fallback: ContentArtifact | undefined
    for (const record of this.records.values()) {
      if (record.artifact.kind !== kind || record.retired) continue
      if (definitionIdOf(record.artifact) !== definitionId) continue
      if (record.enabled) return record.artifact
      fallback = record.artifact
    }
    return fallback
  }

  resolve(): BehaviorArtifact | undefined {
    for (const record of this.records.values()) {
      if (record.artifact.kind === 'behavior' && record.enabled && !record.retired) return record.artifact
    }
    return undefined
  }

  get(id: string): ArtifactRecord | undefined {
    return this.records.get(id)
  }

  list(): ArtifactRecord[] {
    return [...this.records.values()]
  }

  closure(id: string): ContentArtifact[] {
    const root = this.require(id).artifact
    const result: ContentArtifact[] = []
    const seen = new Set<string>()
    const visit = (artifact: ContentArtifact): void => {
      if (seen.has(artifact.artifactId)) return
      seen.add(artifact.artifactId)
      for (const dependency of artifact.manifest.dependencies) {
        const record = this.records.get(dependency.id)
        if (record === undefined || record.artifact.artifactDigest !== dependency.digest) {
          throw new RegistryError('DEPENDENCY_CLOSURE', `dependency ${dependency.id} is not in the registry`)
        }
        visit(record.artifact)
      }
      result.push(artifact)
    }
    visit(root)
    return result
  }

  private require(id: string): ArtifactRecord {
    const record = this.records.get(id)
    if (record === undefined) throw new RegistryError('ARTIFACT_NOT_FOUND', `unknown artifact: ${id}`)
    return record
  }

  private checkCredential(credential: CheckerCredential): void {
    if (credential.bindingId !== this.bindingId) {
      throw new RegistryError('CHECKER_BINDING_MISMATCH', 'checker credential belongs to a different binding')
    }
    if (credential.network !== false) {
      throw new RegistryError('CHECKER_NETWORK', 'checker credential does not allow network access')
    }
    if (credential.builtinsDigest !== this.builtinsDigest) {
      throw new RegistryError('CHECKER_BUILTINS_MISMATCH', 'checker built-in digest does not match')
    }
    if (credential.checkerVersion.length === 0) {
      throw new RegistryError('CHECKER_VERSION', 'checker version is required')
    }
  }
}

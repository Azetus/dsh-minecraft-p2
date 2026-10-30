/**
 * Developer-mode operation hook.
 *
 * The released product keeps operations compiled into the body/provider bundle.
 * During development we want to add (or shadow) operations from a project file
 * without rebuilding and reinstalling the plugin:
 *
 *   .p2/dev-ops.mjs
 *     export const operations = [
 *       { id: 'digArea', kind: 'control', capabilities: ['dig'], start(args, ctx) { ... } },
 *       { id: 'scan', kind: 'query', query(args, ctx) { ... } },
 *     ]
 *
 * The file is re-imported whenever its mtime changes and the registry is swapped
 * in place, so a new operation becomes usable on the next act/run without a body
 * restart. This mode is explicitly a development aid: it is off by default, it
 * breaks binding/epoch identity assumptions, and it must stay disabled for any
 * recorded experiment.
 */

import { watchFile, unwatchFile } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Bot } from 'mineflayer'

import type { ValueMeta } from '../contracts/types.ts'
import type { JsonValue } from '../contracts/types.ts'
import type { ActHandle, QueryOutcome } from '../core/node-runtime.ts'
import type { OpSource } from '../core/op-broker.ts'
import { setExternalOperations } from '../operation/index.ts'
import type {
  OperationContract,
  OperationEffects,
  OperationStop,
} from '../operation/index.ts'

export type DevOpContext = {
  /** The live Mineflayer bot. Only developer-mode code ever sees this. */
  bot: Bot
  meta: (scope: string) => ValueMeta
  now: () => number
}

export type DevOperationDefinition = {
  id: string
  kind: 'query' | 'control'
  effects?: OperationEffects
  stop?: OperationStop
  capabilities?: string[]
  query?: (args: Record<string, JsonValue>, ctx: DevOpContext) => QueryOutcome
  start?: (args: Record<string, JsonValue>, ctx: DevOpContext) => ActHandle
}

export type DevOpsInfo = {
  enabled: boolean
  path: string
  generation: number
  operations: string[]
  lastError: string | null
}

type LoadedModule = {
  operations?: unknown
}

const EMPTY_INFO: DevOpsInfo = {
  enabled: false,
  path: '',
  generation: 0,
  operations: [],
  lastError: null,
}

/**
 * Load and watch the developer operation module.
 *
 * A load failure keeps the previous generation registered and is reported in
 * `status.devOps.lastError`; it never crashes the body.
 */
export class DevOpsHost {
  private definitions = new Map<string, DevOperationDefinition>()
  private generation = 0
  private lastError: string | null = null
  private watching = false
  private loading: Promise<void> | undefined

  private constructor(
    private readonly path: string,
    private readonly bot: Bot,
  ) {}

  static async create(path: string, bot: Bot): Promise<DevOpsHost> {
    const host = new DevOpsHost(resolve(path), bot)
    await host.reload()
    host.startWatching()
    return host
  }

  /** Current view for status reporting. */
  info(): DevOpsInfo {
    if (this.path.length === 0) return { ...EMPTY_INFO }
    return {
      enabled: true,
      path: this.path,
      generation: this.generation,
      operations: [...this.definitions.keys()].sort(),
      lastError: this.lastError,
    }
  }

  operation(id: string): DevOperationDefinition | undefined {
    return this.definitions.get(id)
  }

  async reload(): Promise<void> {
    if (this.loading !== undefined) return this.loading
    this.loading = this.load().finally(() => {
      this.loading = undefined
    })
    return this.loading
  }

  dispose(): void {
    if (this.watching) {
      unwatchFile(this.path)
      this.watching = false
    }
    this.definitions.clear()
    setExternalOperations([])
  }

  private async load(): Promise<void> {
    try {
      this.generation += 1
      const url = `${pathToFileURL(this.path).href}?generation=${this.generation}`
      const module = await import(url) as LoadedModule
      const operations = parseOperations(module.operations)
      this.definitions = new Map(operations.map(definition => [definition.id, definition]))
      setExternalOperations(operations.map(toContract))
      this.lastError = null
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  private startWatching(): void {
    if (this.watching) return
    this.watching = true
    watchFile(this.path, { interval: 500, persistent: false }, () => {
      void this.reload()
    })
  }
}

function parseOperations(value: unknown): DevOperationDefinition[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('dev-ops: `operations` must be an array')
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const record = entry as Partial<DevOperationDefinition> | null
    if (record === null || typeof record !== 'object') {
      throw new Error(`dev-ops: operation #${index} is not an object`)
    }
    const id = record.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`dev-ops: operation #${index} has no id`)
    }
    if (seen.has(id)) throw new Error(`dev-ops: duplicate operation id ${id}`)
    seen.add(id)
    if (record.kind !== 'query' && record.kind !== 'control') {
      throw new Error(`dev-ops: operation ${id} has an invalid kind`)
    }
    if (record.kind === 'query' && typeof record.query !== 'function') {
      throw new Error(`dev-ops: query operation ${id} has no query function`)
    }
    if (record.kind === 'control' && typeof record.start !== 'function') {
      throw new Error(`dev-ops: control operation ${id} has no start function`)
    }
    if (record.effects !== undefined && record.effects !== 'none' && record.effects !== 'active') {
      throw new Error(`dev-ops: operation ${id} has invalid effects`)
    }
    if (record.stop !== undefined && record.stop !== 'none' && record.stop !== 'poll') {
      throw new Error(`dev-ops: operation ${id} has invalid stop semantics`)
    }
    if (record.capabilities !== undefined
      && (!Array.isArray(record.capabilities) || record.capabilities.some(item => typeof item !== 'string'))) {
      throw new Error(`dev-ops: operation ${id} has invalid capabilities`)
    }
    return record as DevOperationDefinition
  })
}

function toContract(definition: DevOperationDefinition): OperationContract {
  return {
    id: definition.id,
    kind: definition.kind,
    effects: definition.kind === 'control' ? (definition.effects ?? 'active') : 'none',
    stop: definition.kind === 'control' ? (definition.stop ?? 'poll') : 'none',
    capabilities: definition.capabilities ?? [],
  }
}

/** Capabilities contributed by the current developer operations. */
export function devCapabilities(host: DevOpsHost | undefined): string[] {
  if (host === undefined) return []
  const capabilities = new Set<string>()
  for (const info of host.info().operations) {
    const definition = host.operation(info)
    for (const capability of definition?.capabilities ?? []) capabilities.add(capability)
  }
  return [...capabilities].sort()
}

/** Build the developer context handed to every dev operation. */
export function devContext(host: DevOpsHost, bot: Bot, now: () => number = Date.now): DevOpContext {
  void host
  return {
    bot,
    now,
    meta: (scope: string): ValueMeta => {
      const sampledAt = now()
      return { source: 'query', scope, sampledAt, validUntil: sampledAt + 1000 }
    },
  }
}

/**
 * Merge the built-in provider with the developer operations. Developer
 * definitions shadow built-in operations with the same id, which is how an
 * existing operation can be iterated on without rebuilding the bundle.
 */
export function createCompositeOpSource(
  base: OpSource,
  host: DevOpsHost | undefined,
  bot: Bot,
): OpSource {
  return {
    get capabilities(): readonly string[] {
      return [...(base.capabilities ?? []), ...devCapabilities(host)]
    },
    query: (name, args) => {
      const dev = host?.operation(name)
      if (dev?.query !== undefined && host !== undefined) return dev.query(args, devContext(host, bot))
      return base.query(name, args)
    },
    start: (name, args) => {
      const dev = host?.operation(name)
      if (dev?.start !== undefined && host !== undefined) return dev.start(args, devContext(host, bot))
      return base.start(name, args)
    },
    ...(base.controlState === undefined
      ? {}
      : { controlState: () => base.controlState?.() ?? 'unknown' }),
  }
}



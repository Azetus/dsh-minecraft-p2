import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type MinecraftProviderConfig = {
  host: string
  port: number
  username: string
  /**
   * `auto` (default) lets mineflayer resolve the version from the server's
   * advertised protocol number; any other value is used verbatim.
   */
  version: string
  connectTimeoutMs: number
  serverIdleMs: number
  /** Stable recovery identity for the world; defaults to host:port. */
  worldId: string
  /** Development-only: crash the body after the first pending action write. */
  crashAfterPending: boolean
}

export type ProviderConfigSource = 'file' | 'env' | 'file+env'

export type LoadedProviderConfig = {
  config: MinecraftProviderConfig
  source: ProviderConfigSource
}

type UnknownRecord = Record<string, unknown>

const DEFAULTS = {
  port: 25575,
  username: 'P2_Bot',
  /**
   * `auto` resolves the server version from its advertised protocol number
   * before connecting; pinning a literal version is still supported.
   */
  version: 'auto',
  connectTimeoutMs: 15_000,
  serverIdleMs: 1500,
} as const

/** The configured `version` value that means "ask the server". */
export const AUTO_VERSION = 'auto'

/**
 * Translate the configured version into a mineflayer `version` option.
 * `undefined` lets mineflayer ping the server and resolve the version itself.
 */
export function resolveMinecraftVersion(version: string): string | undefined {
  return version === AUTO_VERSION ? undefined : version
}

function asVersion(value: string): string {
  return value.trim().toLowerCase() === AUTO_VERSION ? AUTO_VERSION : value
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`provider config: ${field} must be a non-empty string`)
  }
  return value
}

function asPort(value: unknown): number {
  const port = value === undefined ? DEFAULTS.port : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('provider config: port must be an integer between 1 and 65535')
  }
  return port
}

function asPositive(value: unknown, field: string, fallback: number): number {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`provider config: ${field} must be a positive number`)
  }
  return number
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  return value === undefined || value.length === 0 ? undefined : value
}

/**
 * Resolve the one provider configuration used by a body.
 *
 * The MC target (host/port) is supplied by the bridge at start time and is
 * never read from `.p2/config.json`; the project file only carries character
 * and connection behaviour (username/version/timeouts/worldId). A missing
 * `P2_MC_HOST` means the body starts provider-unavailable.
 */
export async function loadProviderConfig(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedProviderConfig | undefined> {
  const path = join(cwd, '.p2', 'config.json')
  let file: UnknownRecord | undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRecord(parsed)) throw new Error('provider config: root must be an object')
    const minecraft = parsed.minecraft
    if (minecraft !== undefined) {
      if (!isRecord(minecraft)) throw new Error('provider config: minecraft must be an object')
      file = minecraft
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }

  const envHost = envValue(env, 'P2_MC_HOST')
  // The target is runtime input from `/p2 start`, not a config-file field.
  if (envHost === undefined) return undefined
  const host = asString(envHost, 'host')
  const port = asPort(envValue(env, 'P2_MC_PORT'))
  const username = asString(
    envValue(env, 'P2_MC_USERNAME') ?? file?.username,
    'username',
    DEFAULTS.username,
  )
  const version = asVersion(asString(
    envValue(env, 'P2_MC_VERSION') ?? file?.version,
    'version',
    DEFAULTS.version,
  ))
  const connectTimeoutMs = asPositive(
    envValue(env, 'P2_MC_CONNECT_TIMEOUT_MS') ?? file?.connectTimeoutMs,
    'connectTimeoutMs',
    DEFAULTS.connectTimeoutMs,
  )
  const serverIdleMs = asPositive(
    envValue(env, 'P2_MC_SERVER_IDLE_MS') ?? file?.serverIdleMs,
    'serverIdleMs',
    DEFAULTS.serverIdleMs,
  )
  const worldId = asString(
    envValue(env, 'P2_WORLD_ID') ?? file?.worldId,
    'worldId',
    `${host}:${port}`,
  )
  const crashAfterPending = envValue(env, 'P2_CRASH_AFTER_PENDING') === '1'
    || file?.crashAfterPending === true
  if (file?.crashAfterPending !== undefined && typeof file.crashAfterPending !== 'boolean') {
    throw new Error('provider config: crashAfterPending must be a boolean')
  }

  return {
    source: file === undefined ? 'env' : 'file+env',
    config: {
      host,
      port,
      username,
      version,
      connectTimeoutMs,
      serverIdleMs,
      worldId,
      crashAfterPending,
    },
  }
}



import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type MinecraftProviderConfig = {
  host: string
  port: number
  username: string
  version: string
  connectTimeoutMs: number
  serverIdleMs: number
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
  version: '1.21.1',
  connectTimeoutMs: 15_000,
  serverIdleMs: 1500,
} as const

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
 * The project file is `.p2/config.json` under the body cwd. Environment
 * variables are explicit overrides, so existing probes and DSH launches keep
 * working without a file. A missing file and missing P2_MC_HOST means the
 * body stays provider-unavailable rather than failing startup.
 */
export async function loadProviderConfig(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedProviderConfig | undefined> {
  const path = join(cwd, '.p2', 'config.json')
  let file: UnknownRecord | undefined
  let source: ProviderConfigSource = 'env'
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRecord(parsed)) throw new Error('provider config: root must be an object')
    const minecraft = parsed.minecraft
    if (minecraft !== undefined) {
      if (!isRecord(minecraft)) throw new Error('provider config: minecraft must be an object')
      file = minecraft
      source = 'file'
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }

  const envHost = envValue(env, 'P2_MC_HOST')
  if (file === undefined && envHost === undefined) return undefined

  const host = asString(envHost ?? file?.host, 'host')
  const port = asPort(envValue(env, 'P2_MC_PORT') ?? file?.port)
  const username = asString(
    envValue(env, 'P2_MC_USERNAME') ?? file?.username,
    'username',
    DEFAULTS.username,
  )
  const version = asString(
    envValue(env, 'P2_MC_VERSION') ?? file?.version,
    'version',
    DEFAULTS.version,
  )
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

  if (envHost !== undefined) source = file === undefined ? 'env' : 'file+env'
  return {
    config: {
      host,
      port,
      username,
      version,
      connectTimeoutMs,
      serverIdleMs,
    },
    source,
  }
}



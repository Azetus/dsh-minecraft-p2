import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadProviderConfig } from '../src/body/provider-config.ts'

const dirs: string[] = []

function configDir(minecraft: Record<string, unknown> | undefined, experiment?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-provider-config-'))
  dirs.push(dir)
  if (minecraft !== undefined) {
    mkdirSync(join(dir, '.p2'))
    writeFileSync(join(dir, '.p2', 'config.json'), JSON.stringify({ minecraft, ...(experiment === undefined ? {} : { experiment }) }))
  }
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('provider config', () => {
  it('is absent when there is no file and no host environment variable', async () => {
    await expect(loadProviderConfig(configDir(undefined), {})).resolves.toBeUndefined()
  })

  it('loads the project file with defaults', async () => {
    const loaded = await loadProviderConfig(configDir({
      host: '127.0.0.1',
      port: 25575,
      username: 'P2_Bot',
    }), {})
    expect(loaded).toEqual({
      source: 'file',
      config: {
        host: '127.0.0.1',
        port: 25575,
        username: 'P2_Bot',
        version: '1.21.1',
        connectTimeoutMs: 15000,
        serverIdleMs: 1500,
        allowRescue: false,
        rescueTpRadius: 32,
        devOps: false,
        devOpsPath: '.p2/dev-ops.mjs',
      },
    })
  })

  it('reads the experiment rescue switch', async () => {
    const loaded = await loadProviderConfig(configDir({ host: '127.0.0.1' }, { allowRescue: true, rescueTpRadius: 16 }), {})
    expect(loaded?.config.allowRescue).toBe(true)
    expect(loaded?.config.rescueTpRadius).toBe(16)
  })

  it('lets environment variables override file fields', async () => {
    const loaded = await loadProviderConfig(configDir({
      host: 'file-host',
      port: 25575,
      username: 'FileBot',
    }), {
      P2_MC_HOST: 'env-host',
      P2_MC_PORT: '25576',
      P2_MC_USERNAME: 'EnvBot',
      P2_MC_SERVER_IDLE_MS: '2500',
    })
    expect(loaded?.source).toBe('file+env')
    expect(loaded?.config).toMatchObject({
      host: 'env-host',
      port: 25576,
      username: 'EnvBot',
      serverIdleMs: 2500,
    })
  })

  it('supports environment-only configuration', async () => {
    const loaded = await loadProviderConfig(configDir(undefined), { P2_MC_HOST: '127.0.0.1' })
    expect(loaded?.source).toBe('env')
    expect(loaded?.config).toMatchObject({ host: '127.0.0.1', port: 25575, username: 'P2_Bot' })
  })

  it('rejects invalid config values', async () => {
    await expect(loadProviderConfig(configDir({ host: '127.0.0.1', port: 0 }), {})).rejects.toThrow(/port/)
    await expect(loadProviderConfig(configDir({}), {})).rejects.toThrow(/host/)
  })
})



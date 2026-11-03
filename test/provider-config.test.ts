import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadProviderConfig } from '../src/body/provider-config.ts'

const dirs: string[] = []

function configDir(minecraft: Record<string, unknown> | undefined): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-provider-config-'))
  dirs.push(dir)
  if (minecraft !== undefined) {
    mkdirSync(join(dir, '.p2'))
    writeFileSync(join(dir, '.p2', 'config.json'), JSON.stringify({ minecraft }))
  }
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('provider config', () => {
  it('is absent without a start target, even when a config file exists', async () => {
    await expect(loadProviderConfig(configDir(undefined), {})).resolves.toBeUndefined()
    await expect(loadProviderConfig(configDir({
      host: 'old-host',
      port: 25575,
      username: 'P2_Bot',
    }), {})).resolves.toBeUndefined()
  })

  it('loads role and connection behaviour from the file with an env target', async () => {
    const loaded = await loadProviderConfig(configDir({
      host: 'ignored-host',
      port: 1,
      username: 'FileBot',
      version: '1.20.1',
      connectTimeoutMs: 9000,
      serverIdleMs: 2500,
      worldId: 'devworld',
    }), {
      P2_MC_HOST: '127.0.0.1',
      P2_MC_PORT: '25575',
    })
    expect(loaded).toEqual({
      source: 'file+env',
      config: {
        host: '127.0.0.1',
        port: 25575,
        username: 'FileBot',
        version: '1.20.1',
        connectTimeoutMs: 9000,
        serverIdleMs: 2500,
        worldId: 'devworld',
        crashAfterPending: false,
      },
    })
  })

  it('ignores file host/port and lets environment fields override the file', async () => {
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

  it('accepts an explicit world identity and crash flag', async () => {
    const loaded = await loadProviderConfig(configDir({
      username: 'P2_Bot',
      worldId: 'devworld',
      crashAfterPending: true,
    }), { P2_MC_HOST: '127.0.0.1' })
    expect(loaded?.config.worldId).toBe('devworld')
    expect(loaded?.config.crashAfterPending).toBe(true)
  })

  it('rejects invalid target or config values', async () => {
    await expect(loadProviderConfig(configDir(undefined), {
      P2_MC_HOST: '127.0.0.1',
      P2_MC_PORT: '0',
    })).rejects.toThrow(/port/)
    await expect(loadProviderConfig(configDir({ username: '' }), {
      P2_MC_HOST: '127.0.0.1',
    })).rejects.toThrow(/username/)
  })
})

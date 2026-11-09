import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStdioTransport } from '../contracts/index.ts'
import type { BodyInfo, ProviderRuntimeStatus } from '../contracts/index.ts'
import type { BodyApi, Vec3 } from './api.ts'
import { createMind } from './mind.ts'
import type { MindRuntime } from './mind.ts'
import { loadBodyInfo } from './manifest.ts'
import { loadProviderConfig } from './provider-config.ts'
import type { MinecraftProviderConfig } from './provider-config.ts'
import { BodyRuntime } from './runtime.ts'
import { BodyServer } from './server.ts'

// The stdio transport owns stdout. Library logs (mineflayer/protodef) must not
// corrupt the JSON-lines protocol, so send console output to stderr instead.
console.log = (...args: unknown[]): void => { console.error(...args) }
console.info = (...args: unknown[]): void => { console.error(...args) }

type ConnectedProvider = {
  body: BodyApi
  config: MinecraftProviderConfig
  liveStatus(): ProviderRuntimeStatus
  dispose(): void
}

async function main(): Promise<void> {
  // Before BodyServer owns stdin, a bridge crash/close must not leave this
  // process stuck inside provider connect. Once the server is ready its
  // onClose path performs the provider dispose.
  let serverReady = false
  const exitBeforeServer = (): void => {
    if (!serverReady) process.exit(0)
  }
  process.stdin.once('end', exitBeforeServer)
  process.stdin.once('close', exitBeforeServer)
  process.once('SIGINT', exitBeforeServer)
  process.once('SIGTERM', exitBeforeServer)

  let body: BodyInfo
  try {
    body = await loadBodyInfo(import.meta.url)
  } catch (error) {
    process.stderr.write(`dsh-minecraft-p2 body: cannot load body manifest: ${String(error)}\n`)
    process.exitCode = 1
    return
  }

  const provider = await connectProvider(body)
  let mind: MindRuntime | undefined
  if (provider !== undefined) {
    try {
      const home = startHome(provider.body)
      let identity: { worldId: string; characterId: string } | undefined
      try {
        identity = provider.body.identity()
      } catch {
        identity = undefined
      }
      mind = createMind({
        body: provider.body,
        ...(home === undefined ? {} : { home }),
        ...(identity === undefined ? {} : { identity }),
        providerStatus: () => provider.liveStatus(),
        crashAfterPending: provider.config.crashAfterPending,
        plansDir: fileURLToPath(new URL('../../content/plans', import.meta.url)),
        journalPath: process.env.P2_JOURNAL_PATH ?? join(process.cwd(), '.p2', 'journal.jsonl'),
      })
    } catch (error) {
      process.stderr.write(`dsh-minecraft-p2 body: mind init failed: ${error instanceof Error ? error.message : JSON.stringify(error)}\n`)
      provider.dispose()
      process.exitCode = 1
      return
    }
  }
  const runtime = new BodyRuntime({
    body,
    heartbeatTimeoutMs: 10_000,
    ...(provider === undefined ? {} : { providerStatus: () => provider.liveStatus() }),
    ...(provider === undefined ? {} : { game: provider.body }),
    ...(mind === undefined ? {} : { mind }),
  })
  const transport = createStdioTransport(process.stdin, process.stdout)
  const server = new BodyServer(runtime, transport)

  server.onClose(() => {
    provider?.dispose()
    // Give a shutdown response one turn to reach stdout before exiting.
    setTimeout(() => process.exit(0), 10)
  })

  const stop = (): void => {
    server.stop()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  server.start()
  serverReady = true
}

function startHome(body: BodyApi): Vec3 | undefined {
  try {
    const pos = body.self().pos
    return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
  } catch {
    return undefined
  }
}

async function connectProvider(body: BodyInfo): Promise<ConnectedProvider | undefined> {
  const loaded = await loadProviderConfig()
  if (loaded === undefined) return undefined

  try {
    const providerUrl = new URL('../provider/minecraft.mjs', import.meta.url).href
    const providerModule = await import(providerUrl) as typeof import('../provider/index.ts')
    const opened = await providerModule.openMineflayerBody({
      host: loaded.config.host,
      port: loaded.config.port,
      username: loaded.config.username,
      version: loaded.config.version,
      connectTimeoutMs: loaded.config.connectTimeoutMs,
      serverIdleMs: loaded.config.serverIdleMs,
      worldId: loaded.config.worldId,
      providerVersion: body.manifest.bodyVersion,
    })
    body.provider = {
      id: opened.providerId,
      version: opened.providerVersion,
    }
    return {
      body: opened.body,
      config: loaded.config,
      liveStatus: opened.liveStatus,
      dispose: opened.dispose,
    }
  } catch (error) {
    process.stderr.write(`dsh-minecraft-p2 body: provider connection failed: ${error instanceof Error ? error.message : String(error)}\n`)
    throw error
  }
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : JSON.stringify(error)
  process.stderr.write(`dsh-minecraft-p2 body: fatal: ${message}\n`)
  process.exit(1)
}

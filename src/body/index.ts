import { createStdioTransport } from '../contracts/index.ts'
import type { BodyInfo, ProviderRuntimeStatus } from '../contracts/index.ts'
import { loadBodyInfo } from './manifest.ts'
import { loadProviderConfig } from './provider-config.ts'
import { BodyRuntime } from './runtime.ts'
import { BodyServer } from './server.ts'

type ConnectedProvider = {
  liveStatus(): ProviderRuntimeStatus
  dispose(): void
}

async function main(): Promise<void> {
  let body: BodyInfo
  try {
    body = await loadBodyInfo(import.meta.url)
  } catch (error) {
    process.stderr.write(`dsh-minecraft-p2 body: cannot load body manifest: ${String(error)}\n`)
    process.exitCode = 1
    return
  }

  const provider = await connectProvider(body)
  const runtime = new BodyRuntime({
    body,
    heartbeatTimeoutMs: 10_000,
    ...(provider === undefined ? {} : { providerStatus: () => provider.liveStatus() }),
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
}

async function connectProvider(body: BodyInfo): Promise<ConnectedProvider | undefined> {
  const loaded = await loadProviderConfig()
  if (loaded === undefined) return undefined

  try {
    const providerUrl = new URL('../provider/minecraft.mjs', import.meta.url).href
    const providerModule = await import(providerUrl) as typeof import('../provider/mineflayer.ts')
    const bot = await providerModule.connectMineflayer({
      host: loaded.config.host,
      port: loaded.config.port,
      username: loaded.config.username,
      version: loaded.config.version,
      timeoutMs: loaded.config.connectTimeoutMs,
    })
    const provider = new providerModule.MineflayerProvider(bot, {
      serverIdleMs: loaded.config.serverIdleMs,
      providerVersion: body.manifest.bodyVersion,
    })
    // The provider is the only component that knows which capabilities it really
    // implements; report them so later layers can gate on the same list.
    const capabilities = [...providerModule.PROVIDER_CAPABILITIES]
    body.capabilities = capabilities
    body.provider = {
      id: providerModule.PROVIDER_ID,
      version: body.manifest.bodyVersion,
      capabilities,
    }
    return {
      liveStatus: () => provider.liveStatus(),
      dispose: () => {
        try {
          bot.quit('body shutdown')
        } catch {
          // The connection may already be gone; disposal is best effort.
        }
      },
    }
  } catch (error) {
    process.stderr.write(`dsh-minecraft-p2 body: provider connection failed: ${error instanceof Error ? error.message : String(error)}\n`)
    throw error
  }
}

await main()

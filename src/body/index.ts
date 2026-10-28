import { createStdioTransport, p2Error } from '../contracts/index.ts'
import type { BodyInfo } from '../contracts/index.ts'
import { BehaviorHost } from '../core/host.ts'
import { DeclaredOpBroker } from '../core/op-broker.ts'
import { BodyServer } from './server.ts'
import { BodyRuntime } from './runtime.ts'
import { loadBodyInfo } from './manifest.ts'
import { loadProviderConfig } from './provider-config.ts'

async function main(): Promise<void> {
  let body: BodyInfo
  try {
    body = await loadBodyInfo(import.meta.url)
  } catch (error) {
    process.stderr.write(`dsh-minecraft-p2 body: cannot load body manifest: ${String(error)}\n`)
    process.exitCode = 1
    return
  }

  const behavior = await createBehaviorHost(body)
  const runtime = new BodyRuntime({
    body,
    behavior,
    heartbeatTimeoutMs: 10_000,
  })
  const transport = createStdioTransport(process.stdin, process.stdout)
  const server = new BodyServer(runtime, transport)

  server.onClose(() => {
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

async function createBehaviorHost(body: BodyInfo): Promise<BehaviorHost> {
  const loaded = await loadProviderConfig()
  if (loaded === undefined) {
    return new BehaviorHost({
      bindingId: body.bindingId ?? 'unbound',
      query: () => ({
        status: 'failed',
        error: p2Error(
          'PROVIDER_UNAVAILABLE',
          'environment',
          'no provider is connected in this body',
          { module: 'body.provider' },
        ),
      }),
      act: {
        start: () => {
          throw new Error('no provider is connected in this body')
        },
      },
    })
  }

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
    })
    const ops = new DeclaredOpBroker(provider)
    return new BehaviorHost({
      bindingId: body.bindingId ?? 'unbound',
      query: ops.queryPort(),
      act: ops,
      providerStatus: () => provider.liveStatus(),
    })
  } catch (error) {
    process.stderr.write(`dsh-minecraft-p2 body: provider connection failed: ${error instanceof Error ? error.message : String(error)}\n`)
    throw error
  }
}

await main()

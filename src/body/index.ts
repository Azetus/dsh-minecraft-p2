import { fileURLToPath } from 'node:url'

import { createStdioTransport, p2Error } from '../contracts/index.ts'
import type { BodyInfo } from '../contracts/index.ts'
import { BehaviorHost } from '../core/host.ts'
import { DeclaredOpBroker } from '../core/op-broker.ts'
import { RunnerActPort } from '../core/act-port.ts'
import { RunnerPolicyPort } from '../core/policy-port.ts'
import { RunnerClient } from '../core/runner-client.ts'
import { BodyServer } from './server.ts'
import { BodyRuntime } from './runtime.ts'
import { loadBodyInfo } from './manifest.ts'
import { loadProviderConfig } from './provider-config.ts'

type HostBundle = {
  host: BehaviorHost
  dispose: () => void
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

  const bundle = await createBehaviorHost(body)
  const runtime = new BodyRuntime({
    body,
    behavior: bundle.host,
    heartbeatTimeoutMs: 10_000,
  })
  const transport = createStdioTransport(process.stdin, process.stdout)
  const server = new BodyServer(runtime, transport)

  server.onClose(() => {
    bundle.dispose()
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

async function createBehaviorHost(body: BodyInfo): Promise<HostBundle> {
  const loaded = await loadProviderConfig()
  if (loaded === undefined) {
    const host = new BehaviorHost({
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
    return { host, dispose: () => {} }
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

    const runnerEntry = fileURLToPath(new URL('../runner.js', import.meta.url))
    let actPort: RunnerActPort | undefined
    let policyPort: RunnerPolicyPort | undefined
    let host: BehaviorHost | undefined
    const client = new RunnerClient({
      entry: runnerEntry,
      onOp: event => actPort?.handleOp(event),
      onLog: line => process.stderr.write(`[runner] ${line}\n`),
    })
    actPort = new RunnerActPort(client, ops, artifactId => host?.actSource(artifactId))
    policyPort = new RunnerPolicyPort(client, artifactId => host?.policySource(artifactId))
    host = new BehaviorHost({
      bindingId: body.bindingId ?? 'unbound',
      query: ops.queryPort(),
      act: actPort,
      policy: {
        call: (ref, inputs) => policyPort?.call(ref, inputs) ?? {
          status: 'failed',
          error: p2Error('POLICY_UNAVAILABLE', 'capability', 'policy runner is not ready', { module: 'body.policy' }),
        },
      },
      providerStatus: () => provider.liveStatus(),
      loadManifest: (kind, code, artifactId) => client.load(kind, artifactId, code),
    })
    return {
      host,
      dispose: () => {
        host?.dispose()
        actPort?.dispose()
        client.dispose()
      },
    }
  } catch (error) {
    process.stderr.write(`dsh-minecraft-p2 body: provider connection failed: ${error instanceof Error ? error.message : String(error)}\n`)
    throw error
  }
}

await main()

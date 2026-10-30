import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStdioTransport, p2Error } from '../contracts/index.ts'
import type { BodyInfo, DevOpsStatus } from '../contracts/index.ts'
import { ArtifactHost } from '../core/artifact-host.ts'
import { DeclaredOpBroker } from '../core/op-broker.ts'
import { createAuthoredOpSource } from '../core/op-artifact.ts'
import { RunnerActPort } from '../core/act-port.ts'
import { RunnerPolicyPort } from '../core/policy-port.ts'
import { RunnerManager } from '../core/runner-manager.ts'
import { TraceSink } from '../core/trace.ts'
import { BodyController } from './controller-host.ts'
import { BodyServer } from './server.ts'
import { BodyRuntime } from './runtime.ts'
import { DevOpsHost, createCompositeOpSource } from './dev-ops.ts'
import { loadBodyInfo } from './manifest.ts'
import { loadProviderConfig } from './provider-config.ts'
import { executeRescue } from './rescue.ts'

type HostBundle = {
  host: ArtifactHost
  controller?: BodyController
  rescue?: { enabled: boolean; tpRadius: number }
  devOps?: () => DevOpsStatus | null
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

  const trace = new TraceSink({ capacity: 2048 })
  const bundle = await createArtifactHost(body, trace)
  const runtime = new BodyRuntime({
    body,
    host: bundle.host,
    ...(bundle.controller === undefined ? {} : { controller: bundle.controller }),
    heartbeatTimeoutMs: 10_000,
    ...(bundle.rescue === undefined ? {} : { rescue: bundle.rescue }),
    ...(bundle.devOps === undefined ? {} : { devOps: bundle.devOps }),
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

async function createArtifactHost(body: BodyInfo, trace: TraceSink): Promise<HostBundle> {
  const loaded = await loadProviderConfig()
  if (loaded === undefined) {
    const host = new ArtifactHost({
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
      providerVersion: body.manifest.bodyVersion,
    })
    // The provider is the only component that knows which capabilities it really
    // implements; report them and let the op broker gate on the same list.
    const capabilities = [...providerModule.PROVIDER_CAPABILITIES]
    body.capabilities = capabilities
    body.provider = {
      id: providerModule.PROVIDER_ID,
      version: body.manifest.bodyVersion,
      capabilities,
    }

    // Developer mode: extra operations from a project file, hot-reloaded on edit.
    const devHost = loaded.config.devOps
      ? await DevOpsHost.create(join(process.cwd(), loaded.config.devOpsPath), bot)
      : undefined
    if (devHost !== undefined) {
      process.stderr.write(`dsh-minecraft-p2 body: developer operations enabled (${loaded.config.devOpsPath})\n`)
    }
    const devOpsInfo = (): DevOpsStatus | null => devHost?.info() ?? null

    let actPort: RunnerActPort | undefined
    let policyPort: RunnerPolicyPort | undefined
    let host: ArtifactHost | undefined
    let opsBroker: DeclaredOpBroker | undefined
    let controller: BodyController | undefined
    // Activated authored ops are resolved from the host registry; the provider
    // stays behind this seam and the broker remains the only control ledger.
    const opsSource = createAuthoredOpSource(
      createCompositeOpSource(provider, devHost, bot),
      name => host?.opArtifact(name),
      {
        log: message => process.stderr.write(`[op] ${message}\n`),
        now: () => Date.now(),
        onUntracked: input => { opsBroker?.markUntracked(input.runId) },
      },
    )
    opsBroker = new DeclaredOpBroker(opsSource, { trace, now: () => Date.now() })
    const ops = opsBroker

    const runnerEntry = fileURLToPath(new URL('../runner.js', import.meta.url))
    const runner = new RunnerManager({
      entry: runnerEntry,
      onOp: event => actPort?.handleOp(event),
      onLog: line => process.stderr.write(`[runner] ${line}\n`),
      onExit: code => {
        const message = `runner exited with code ${String(code)}`
        actPort?.runnerExited(p2Error('RUNNER_EXITED', 'runtime', message, { module: 'body.runner' }))
        policyPort?.reset()
        host?.runnerExited?.(message)
      },
    })
    actPort = new RunnerActPort(() => runner.ensure(), ops, artifactId => host?.actSource(artifactId), trace)
    const act = actPort
    policyPort = new RunnerPolicyPort(() => runner.ensure(), artifactId => host?.policySource(artifactId))
    const artifactHost = new ArtifactHost({
      bindingId: body.bindingId ?? 'unbound',
      query: ops.queryPort(),
      act,
      policy: {
        call: (ref, inputs) => policyPort?.call(ref, inputs) ?? {
          status: 'failed',
          error: p2Error('POLICY_UNAVAILABLE', 'capability', 'policy runner is not ready', { module: 'body.policy' }),
        },
      },
      providerStatus: () => provider.liveStatus(),
      loadManifest: (kind, code, artifactId) => runner.ensure().load(kind, artifactId, code),
      rescue: (request, context) => executeRescue(provider, request, {
        allowRescue: loaded.config.allowRescue,
        tpRadius: loaded.config.rescueTpRadius,
        auditPath: join(process.cwd(), '.m5-runs', 'rescue.jsonl'),
        owner: context.owner,
      }),
      rescueBusy: () => controller !== undefined && controller.status().action !== null,
    })
    host = artifactHost
    controller = new BodyController({
      act,
      query: ops.queryPort(),
      strategySource: artifactId => artifactHost.strategySource(artifactId),
      providerStatus: () => provider.liveStatus(),
      log: line => process.stderr.write(`[controller] ${line}\n`),
    })
    return {
      host: artifactHost,
      controller,
      rescue: { enabled: loaded.config.allowRescue, tpRadius: loaded.config.rescueTpRadius },
      devOps: devOpsInfo,
      dispose: () => {
        controller?.dispose()
        devHost?.dispose()
        artifactHost.dispose()
        actPort?.dispose()
        runner.dispose()
      },
    }
  } catch (error) {
    process.stderr.write(`dsh-minecraft-p2 body: provider connection failed: ${error instanceof Error ? error.message : String(error)}\n`)
    throw error
  }
}

await main()

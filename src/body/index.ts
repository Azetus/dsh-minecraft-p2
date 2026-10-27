import { createStdioTransport } from '../contracts/index.ts'
import type { BodyInfo } from '../contracts/index.ts'
import { BodyServer } from './server.ts'
import { BodyRuntime } from './runtime.ts'
import { loadBodyInfo } from './manifest.ts'

async function main(): Promise<void> {
  let body: BodyInfo
  try {
    body = await loadBodyInfo(import.meta.url)
  } catch (error) {
    process.stderr.write(`dsh-minecraft-p2 body: cannot load body manifest: ${String(error)}\n`)
    process.exitCode = 1
    return
  }

  const runtime = new BodyRuntime({
    body,
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

await main()

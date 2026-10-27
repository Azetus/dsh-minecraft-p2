#!/usr/bin/env node
/**
 * M3 G3 first pass: start a real body with the Mineflayer provider, run a long
 * move act, then stop it through the body's behavior.stop command and measure
 * the stop response and post-stop position stability.
 *
 * Build first: npm run build
 * Usage: node scripts/m3-g3.mjs [host] [port] [username]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? '25575')
const username = process.argv[4] ?? 'P2_Bot'

const child = spawn(process.execPath, [join(process.cwd(), 'lib/body/body.mjs')], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    P2_MC_HOST: host,
    P2_MC_PORT: String(port),
    P2_MC_USERNAME: username,
    P2_MC_VERSION: '1.21.1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

const stderr = []
child.stderr.on('data', chunk => stderr.push(String(chunk)))
const pending = new Map()
const lines = createInterface({ input: child.stdout })
lines.on('line', line => {
  if (!line.trim().startsWith('{')) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const waiter = pending.get(message.requestId)
  if (waiter !== undefined) {
    pending.delete(message.requestId)
    waiter.resolve(message)
  }
})

let seq = 0
let bodyEpoch
function request(method, params = {}, options = {}) {
  seq += 1
  const requestId = `g3-${seq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`request ${method} timed out`))
    }, 25_000)
    pending.set(requestId, {
      resolve: message => {
        clearTimeout(timer)
        resolve(message)
      },
    })
    child.stdin.write(`${JSON.stringify({
      protocol: 1,
      requestId,
      method,
      params,
      ...(bodyEpoch === undefined ? {} : { bodyEpoch }),
      ...(options.commandId === undefined ? {} : { commandId: options.commandId }),
    })}\n`)
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const valueOf = response => {
  if (response.error !== undefined) throw new Error(`${response.error.code}: ${response.error.message}`)
  return response.result
}
const position = async () => {
  const result = valueOf(await request('observe', { op: 'position' }))
  return result.value
}
const delta = (a, b) => a === null || b === null
  ? null
  : { dx: b.x - a.x, dy: b.y - a.y, dz: b.z - a.z }

try {
  const hello = await request('hello', {
    protocols: [1],
    owner: { sessionId: 'm3-g3', agentId: 'g3', cwd: process.cwd() },
  })
  const helloResult = valueOf(hello)
  bodyEpoch = helloResult.bodyEpoch

  const checked = valueOf(await request('check', {
    sourcePath: join(process.cwd(), 'scripts', 'm3-g3-source.mjs'),
  }, { commandId: 'g3-check' }))
  valueOf(await request('activate', { artifactId: checked.artifactId }, { commandId: 'g3-activate' }))
  const switched = valueOf(await request('switch', {
    artifactId: checked.artifactId,
    params: {},
  }, { commandId: 'g3-switch' }))
  if (!switched.accepted) throw new Error(`switch rejected: ${JSON.stringify(switched)}`)
  const activeRunId = switched.runId
  if (typeof activeRunId !== 'string') throw new Error('switch did not return a runId')

  await sleep(900)
  const before = await position()
  const stopStarted = Date.now()
  const stopped = valueOf(await request('behavior.stop', { runId: activeRunId }, { commandId: 'g3-stop' }))
  const stopResponseMs = Date.now() - stopStarted
  const afterImmediate = await position()
  await sleep(200)
  const after200 = await position()
  await sleep(1000)
  const after1200 = await position()
  const status = valueOf(await request('status', {}))

  process.stdout.write(`${JSON.stringify({
    ok: stopped.accepted === true && after200 !== null && after1200 !== null,
    requestRunId: activeRunId,
    bodyEpoch,
    switched,
    before,
    afterImmediate,
    after200,
    after1200,
    stopResponseMs,
    immediateDelta: delta(before, afterImmediate),
    delta200: delta(before, after200),
    delta1200: delta(before, after1200),
    settledDelta: delta(after200, after1200),
    activeRun: status.activeRun,
    pendingConfirmation: status.pendingConfirmation,
    health: status.owner === null ? null : status.health,
    stderrLines: stderr.length,
  })}\n`)

  await request('shutdown', {}, { commandId: 'g3-shutdown' }).catch(() => {})
  child.stdin.end()
  setTimeout(() => {
    try { child.kill() } catch {}
    process.exit(0)
  }, 100)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stderr: stderr.join('').slice(0, 2000),
  })}\n`)
  try { child.kill() } catch {}
  process.exit(1)
}

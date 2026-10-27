#!/usr/bin/env node
/**
 * M3 G3 kick: run a long move, then wait for the operator to /kick P2_Bot.
 * The body must report a terminal run / lost provider without claiming the
 * world was stopped by the bot.
 *
 * Build first: npm run build
 * Usage: node scripts/m3-g3-kick.mjs [host] [port]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? '25575')
const username = 'P2_Bot'
const stderr = []

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
child.stderr.on('data', chunk => { stderr.push(String(chunk)) })
let bodyExit
child.once('exit', (code, signal) => { bodyExit = { code, signal } })
const pending = new Map()
createInterface({ input: child.stdout }).on('line', line => {
  if (!line.trim().startsWith('{')) return
  let message
  try { message = JSON.parse(line) } catch { return }
  const waiter = pending.get(message.requestId)
  if (waiter !== undefined) { pending.delete(message.requestId); waiter(message) }
})

let seq = 0
let epoch
function request(method, params = {}, commandId) {
  seq += 1
  const requestId = `kick-${seq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 10_000)
    pending.set(requestId, message => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({
      protocol: 1,
      requestId,
      method,
      params,
      ...(epoch === undefined ? {} : { bodyEpoch: epoch }),
      ...(commandId === undefined ? {} : { commandId }),
    })}\n`)
  })
}
const value = response => {
  if (response.error !== undefined) throw new Error(`${response.error.code}: ${response.error.message}`)
  return response.result
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

try {
  const hello = value(await request('hello', {
    protocols: [1],
    owner: { sessionId: 'm3-kick', agentId: 'kick', cwd: process.cwd() },
  }))
  epoch = hello.bodyEpoch
  let heartbeatSeq = 0
  const heartbeat = setInterval(() => {
    heartbeatSeq += 1
    void request('heartbeat', { seq: heartbeatSeq }).catch(() => {})
  }, 1000)
  heartbeat.unref?.()
  const checked = value(await request('check', {
    sourcePath: join(process.cwd(), 'scripts', 'm3-g3-source.mjs'),
  }, 'kick-check'))
  value(await request('activate', { artifactId: checked.artifactId }, 'kick-activate'))
  const switched = value(await request('switch', {
    artifactId: checked.artifactId,
    params: {},
  }, 'kick-switch'))
  process.stdout.write(`SWITCHED: ${JSON.stringify(switched)}\n`)

  await sleep(900)
  const before = value(await request('observe', { op: 'position' })).value
  process.stdout.write(`READY: run a long move; execute /kick ${username} now\n`)
  const started = Date.now()
  let disconnect
  for (let i = 0; i < 120; i += 1) {
    await sleep(500)
    let status
    try {
      status = value(await request('status', {}))
    } catch {
      disconnect = { status: 'body-unavailable', elapsedMs: Date.now() - started }
      break
    }
    if (status.activeRun === null) {
      disconnect = {
        status: 'run-terminal',
        elapsedMs: Date.now() - started,
        activeRun: status.activeRun,
        pendingConfirmation: status.pendingConfirmation,
        health: status.health,
      }
      break
    }
  }
  if (disconnect === undefined) disconnect = { status: 'timeout', elapsedMs: Date.now() - started }
  let observeError
  try {
    value(await request('observe', { op: 'position' }))
  } catch (error) {
    observeError = error instanceof Error ? error.message : String(error)
  }
  process.stdout.write(`${JSON.stringify({
    ok: disconnect.status === 'run-terminal' && disconnect.activeRun === null,
    before,
    disconnect,
    observeError,
    bodyExit,
    heartbeatCount: heartbeatSeq,
    stderr: stderr.join('').slice(-2000),
  })}\n`)
  clearInterval(heartbeat)
  await request('shutdown', {}, 'kick-shutdown').catch(() => {})
  child.stdin.end()
  setTimeout(() => { try { child.kill() } catch {} process.exit(0) }, 100)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    bodyExit,
    stderr: stderr.join('').slice(-2000),
  })}\n`)
  try { child.kill() } catch {}
  process.exit(1)
}

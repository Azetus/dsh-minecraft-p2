#!/usr/bin/env node
/**
 * M4 continuous behavior + target-change probe.
 *
 * Holds target A, then switches the same continuous behavior to target B and
 * verifies the old run is superseded and the bot reaches the new target.
 *
 * Build first: npm run build
 * Usage: node scripts/m4-hold-probe.mjs [host] [port]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? '25575')
const env = { ...process.env }
for (const key of Object.keys(env)) if (key.startsWith('P2_MC_')) delete env[key]

const child = spawn(process.execPath, [join(process.cwd(), 'lib/body/body.mjs')], {
  cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
})
const stderr = []
child.stderr.on('data', chunk => { stderr.push(String(chunk)) })
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
  const requestId = `m4-hold-${seq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 10_000)
    pending.set(requestId, message => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({
      protocol: 1, requestId, method, params,
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
const position = async () => value(await request('observe', { op: 'position' })).value
const distance = (p, target) => Math.hypot(Number(p.x) - target.x, Number(p.z) - target.z)

try {
  const hello = value(await request('hello', {
    protocols: [1], owner: { sessionId: 'm4-hold', agentId: 'probe', cwd: process.cwd() },
  }))
  epoch = hello.bodyEpoch
  let heartbeatSeq = 0
  const heartbeat = setInterval(() => {
    heartbeatSeq += 1
    void request('heartbeat', { seq: heartbeatSeq }).catch(() => {})
  }, 1000)
  heartbeat.unref?.()

  const checked = value(await request('check', {
    sourcePath: join(process.cwd(), 'behaviors', 'hold-position.mjs'),
  }, 'm4-hold-check'))
  value(await request('activate', { artifactId: checked.artifactId }, 'm4-hold-activate'))
  const before = await position()
  const targetA = { x: Number(before.x) + 2, z: Number(before.z), tolerance: 0.8 }
  const targetB = { x: Number(before.x) - 2, z: Number(before.z), tolerance: 0.8 }

  const switchA = value(await request('switch', {
    artifactId: checked.artifactId, params: targetA,
  }, 'm4-hold-switch-a'))
  await sleep(2500)
  const atA = await position()
  const statusA = value(await request('status', {}))
  const switchB = value(await request('switch', {
    artifactId: checked.artifactId, params: targetB,
  }, 'm4-hold-switch-b'))
  await sleep(2500)
  const atB = await position()
  const statusB = value(await request('status', {}))
  const runId = statusB.activeRun?.runId
  const stopped = runId === undefined
    ? { accepted: false, status: 'no-active-run' }
    : value(await request('behavior.stop', { runId }, 'm4-hold-stop'))

  const result = {
    ok: switchA.accepted && switchB.accepted
      && distance(atA, targetA) <= targetA.tolerance
      && distance(atB, targetB) <= targetB.tolerance
      && stopped.accepted === true,
    bodyEpoch: epoch,
    before,
    targetA,
    targetB,
    switchA,
    atA,
    distanceA: distance(atA, targetA),
    statusA: { activeRun: statusA.activeRun, providerState: statusA.providerState },
    switchB,
    atB,
    distanceB: distance(atB, targetB),
    statusB: { activeRun: statusB.activeRun, providerState: statusB.providerState },
    stopped,
    heartbeatCount: heartbeatSeq,
    stderr: stderr.join('').slice(-1000),
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  await request('shutdown', {}, 'm4-hold-shutdown').catch(() => {})
  child.stdin.end()
  setTimeout(() => { try { child.kill() } catch {} process.exit(result.ok ? 0 : 1) }, 100)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stderr: stderr.join('').slice(-1000),
  })}\n`)
  try { child.kill() } catch {}
  process.exit(1)
}

#!/usr/bin/env node
/**
 * M4 first finite behavior probe: check/activate/switch approach-target, then
 * verify P2 stops within tolerance on the real flat test world.
 *
 * Build first: npm run build
 * Usage: node scripts/m4-approach-probe.mjs [host] [port]
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
  const requestId = `m4-approach-${seq}`
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

try {
  const hello = value(await request('hello', {
    protocols: [1], owner: { sessionId: 'm4-approach', agentId: 'probe', cwd: process.cwd() },
  }))
  epoch = hello.bodyEpoch
  let heartbeatSeq = 0
  const heartbeat = setInterval(() => {
    heartbeatSeq += 1
    void request('heartbeat', { seq: heartbeatSeq }).catch(() => {})
  }, 1000)
  heartbeat.unref?.()

  const checked = value(await request('check', {
    sourcePath: join(process.cwd(), 'behaviors', 'approach-target.mjs'),
  }, 'm4-approach-check'))
  value(await request('activate', { artifactId: checked.artifactId }, 'm4-approach-activate'))
  const before = value(await request('observe', { op: 'position' })).value
  const target = {
    x: Number(before.x) + 3,
    z: Number(before.z),
    tolerance: 0.8,
  }
  const switched = value(await request('switch', {
    artifactId: checked.artifactId,
    params: target,
  }, 'm4-approach-switch'))
  const samples = []
  let terminal = false
  let finalStatus
  for (let i = 0; i < 100; i += 1) {
    await sleep(200)
    const status = value(await request('status', {}))
    if (status.activeRun === null) {
      terminal = true
      finalStatus = status
      break
    }
    try {
      const position = value(await request('observe', { op: 'position' })).value
      samples.push(position)
    } catch {}
  }
  const after = value(await request('observe', { op: 'position' })).value
  const distance = Math.hypot(Number(after.x) - target.x, Number(after.z) - target.z)
  const result = {
    ok: terminal && distance <= target.tolerance && finalStatus?.lastRun?.status === 'succeeded',
    bodyEpoch: epoch,
    before,
    target,
    switched,
    terminal,
    lastRun: finalStatus?.lastRun ?? null,
    after,
    distance,
    samples,
    heartbeatCount: heartbeatSeq,
    stderr: stderr.join('').slice(-1000),
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  await request('shutdown', {}, 'm4-approach-shutdown').catch(() => {})
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

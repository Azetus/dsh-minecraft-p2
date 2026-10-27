#!/usr/bin/env node
/**
 * M3 G3 pause: run a long move and sample position while the operator executes
 * `/tick freeze` for about 10 seconds, then `/tick unfreeze`.
 *
 * Build first: npm run build
 * Usage: node scripts/m3-g3-pause.mjs [host] [port]
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
  const requestId = `pause-${seq}`
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
const position = async () => (value(await request('observe', { op: 'position' }))).value

try {
  const hello = value(await request('hello', {
    protocols: [1],
    owner: { sessionId: 'm3-pause', agentId: 'pause', cwd: process.cwd() },
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
  }, 'pause-check'))
  value(await request('activate', { artifactId: checked.artifactId }, 'pause-activate'))
  value(await request('switch', {
    artifactId: checked.artifactId,
    params: {},
  }, 'pause-switch'))

  await sleep(900)
  process.stdout.write(`READY: execute /tick freeze now, wait 10s, then /tick unfreeze\n`)
  const samples = []
  let freezeAt
  let freezeAge
  let unfreezeAt
  for (let i = 0; i < 360; i += 1) {
    await sleep(500)
    try {
      const p = await position()
      const time = (value(await request('observe', { op: 'time' }))).value
      samples.push({ t: i * 500, position: p, time })
    } catch (error) {
      samples.push({ t: i * 500, error: error instanceof Error ? error.message : String(error) })
      break
    }
    const currentAge = samples.at(-1)?.time?.age
    if (freezeAt === undefined && samples.length >= 5 && typeof currentAge === 'number') {
      const recent = samples.slice(-5).map(sample => sample.time?.age)
      if (recent.every(age => age === currentAge)) {
        freezeAt = (samples.length - 1) * 500
        freezeAge = currentAge
      }
    } else if (freezeAt !== undefined && typeof currentAge === 'number' && currentAge > freezeAge) {
      unfreezeAt = (samples.length - 1) * 500
      break
    }
  }
  const frozenDetected = freezeAt !== undefined
  const frozenByTime = frozenDetected
  const status = value(await request('status', {}))
  const stopped = value(await request('behavior.stop', {}, 'pause-stop'))
  clearInterval(heartbeat)
  process.stdout.write(`${JSON.stringify({
    ok: frozenDetected && unfreezeAt !== undefined,
    frozenDetected,
    frozenByTime,
    freezeAt,
    unfreezeAt,
    samples,
    activeRun: status.activeRun,
    stopAccepted: stopped.accepted,
    heartbeatCount: heartbeatSeq,
    stderr: stderr.join('').slice(-1000),
  })}\n`)
  await request('shutdown', {}, 'pause-shutdown').catch(() => {})
  child.stdin.end()
  setTimeout(() => { try { child.kill() } catch {} process.exit(0) }, 100)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stderr: stderr.join('').slice(-1000),
  })}\n`)
  try { child.kill() } catch {}
  process.exit(1)
}

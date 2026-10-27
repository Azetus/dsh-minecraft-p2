#!/usr/bin/env node
/**
 * M4 prep probe: body config + server-age pause semantics.
 *
 * Starts a body using project `.p2/config.json` (no P2_MC_* env), starts a
 * long move, uses a second LAN operator to freeze server ticks, and verifies:
 * - provider detects the stalled age;
 * - the active act fails with GAME_PAUSED;
 * - world queries fail closed while paused;
 * - time query still reports the paused age;
 * - unfreeze restores queries but does not auto-resume the failed run.
 *
 * Build first: npm run build
 * Usage: node scripts/m4-pause-probe.mjs [host] [port]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import mineflayer from 'mineflayer'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? '25575')
const bodyName = 'P2_Bot'
const operatorName = 'P2_Operator'
const env = { ...process.env }
for (const key of Object.keys(env)) if (key.startsWith('P2_MC_')) delete env[key]

const operator = mineflayer.createBot({
  host, port, username: operatorName, auth: 'offline', version: '1.21.1',
})
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('operator spawn timeout')), 15_000)
  operator.once('spawn', () => { clearTimeout(timer); resolve() })
  operator.once('error', error => { clearTimeout(timer); reject(error) })
})
await new Promise(resolve => setTimeout(resolve, 800))

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
  const requestId = `m4-pause-${seq}`
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
const errorOf = async (method, params) => {
  const response = await request(method, params)
  return response.error ?? null
}

try {
  const hello = value(await request('hello', {
    protocols: [1],
    owner: { sessionId: 'm4-pause', agentId: 'probe', cwd: process.cwd() },
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
  }, 'm4-check'))
  value(await request('activate', { artifactId: checked.artifactId }, 'm4-activate'))
  const switched = value(await request('switch', { artifactId: checked.artifactId, params: {} }, 'm4-switch'))
  await sleep(900)
  const before = value(await request('status', {}))
  if (before.activeRun === null) throw new Error('run did not start')

  operator.chat('/tick freeze')
  await sleep(2500)
  const frozenStatus = value(await request('status', {}))
  const frozenPosition = await errorOf('observe', { op: 'position' })
  const frozenTime = value(await request('observe', { op: 'time' })).value

  operator.chat('/tick unfreeze')
  await sleep(1500)
  const resumedStatus = value(await request('status', {}))
  const resumedPosition = value(await request('observe', { op: 'position' })).value

  clearInterval(heartbeat)
  process.stdout.write(`${JSON.stringify({
    ok: frozenStatus.providerState?.paused === true
      && frozenStatus.activeRun === null
      && frozenStatus.pendingConfirmation === null
      && frozenStatus.lastRun?.status === 'failed'
      && frozenStatus.lastRun?.error?.code === 'GAME_PAUSED'
      && frozenPosition?.code === 'GAME_PAUSED'
      && frozenTime.paused === true
      && resumedStatus.providerState?.paused === false
      && resumedStatus.activeRun === null,
    bodyEpoch: epoch,
    before: { activeRun: before.activeRun, providerState: before.providerState },
    frozen: {
      activeRun: frozenStatus.activeRun,
      lastRun: frozenStatus.lastRun,
      providerState: frozenStatus.providerState,
      positionError: frozenPosition,
      time: frozenTime,
    },
    resumed: {
      activeRun: resumedStatus.activeRun,
      lastRun: resumedStatus.lastRun,
      providerState: resumedStatus.providerState,
      position: resumedPosition,
    },
    heartbeatCount: heartbeatSeq,
    stderr: stderr.join('').slice(-1000),
  })}\n`)
  await request('shutdown', {}, 'm4-shutdown').catch(() => {})
  operator.quit('pause probe complete')
  child.stdin.end()
  setTimeout(() => { try { child.kill() } catch {} process.exit(0) }, 100)
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), stderr: stderr.join('').slice(-1000) })}\n`)
  try { operator.quit('pause probe failed') } catch {}
  try { child.kill() } catch {}
  process.exit(1)
}

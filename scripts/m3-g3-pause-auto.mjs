#!/usr/bin/env node
/**
 * M3 G3 automated pause: run a body long move, use a second LAN bot as the
 * operator to issue `/tick freeze` and `/tick unfreeze`, and sample the body's
 * world age/position before, during, and after the freeze.
 *
 * Build first: npm run build
 * Usage: node scripts/m3-g3-pause-auto.mjs [host] [port]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import mineflayer from 'mineflayer'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? '25575')
const operatorName = 'P2_Operator'
const bodyName = 'P2_Bot'

const operator = mineflayer.createBot({
  host,
  port,
  username: operatorName,
  auth: 'offline',
  version: '1.21.1',
})
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('operator spawn timeout')), 15_000)
  operator.once('spawn', () => { clearTimeout(timer); resolve() })
  operator.once('error', error => { clearTimeout(timer); reject(error) })
})
await new Promise(resolve => setTimeout(resolve, 800))

const child = spawn(process.execPath, [join(process.cwd(), 'lib/body/body.mjs')], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    P2_MC_HOST: host,
    P2_MC_PORT: String(port),
    P2_MC_USERNAME: bodyName,
    P2_MC_VERSION: '1.21.1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
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
  const requestId = `auto-${seq}`
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
const sample = async () => {
  const position = (value(await request('observe', { op: 'position' }))).value
  const time = (value(await request('observe', { op: 'time' }))).value
  return { position, age: time.age, timeOfDay: time.timeOfDay }
}

try {
  const hello = value(await request('hello', {
    protocols: [1],
    owner: { sessionId: 'm3-auto-pause', agentId: 'pause', cwd: process.cwd() },
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
  }, 'auto-check'))
  value(await request('activate', { artifactId: checked.artifactId }, 'auto-activate'))
  value(await request('switch', {
    artifactId: checked.artifactId,
    params: {},
  }, 'auto-switch'))
  await sleep(900)

  const before = await sample()
  operator.chat('/tick freeze')
  const during = []
  for (let i = 0; i < 20; i += 1) {
    await sleep(500)
    during.push(await sample())
  }
  operator.chat('/tick unfreeze')
  await sleep(500)
  const afterFreeze = []
  for (let i = 0; i < 8; i += 1) {
    await sleep(500)
    afterFreeze.push(await sample())
  }
  const stopped = value(await request('behavior.stop', {}, 'auto-stop'))
  const status = value(await request('status', {}))
  clearInterval(heartbeat)
  const ages = [before, ...during, ...afterFreeze].map(item => item.age)
  let freezeIndex = -1
  for (let i = 3; i < during.length; i += 1) {
    if (during[i].age === during[i - 3].age) {
      freezeIndex = i - 3
      break
    }
  }
  const freezeAge = freezeIndex >= 0 ? during[freezeIndex].age : undefined
  const unfreezeIndex = freezeAge === undefined
    ? -1
    : afterFreeze.findIndex(item => item.age > freezeAge)
  const frozenDetected = freezeIndex >= 0
  process.stdout.write(`${JSON.stringify({
    ok: frozenDetected && unfreezeIndex >= 0 && status.activeRun === null,
    frozenDetected,
    freezeIndex,
    unfreezeIndex,
    freezeAge,
    unfreezeAge: unfreezeIndex >= 0 ? afterFreeze[unfreezeIndex].age : undefined,
    before,
    during,
    afterFreeze,
    ages,
    stopped,
    activeRun: status.activeRun,
    heartbeatCount: heartbeatSeq,
    stderr: stderr.join('').slice(-1000),
  })}\n`)
  await request('shutdown', {}, 'auto-shutdown').catch(() => {})
  operator.quit('auto pause complete')
  child.stdin.end()
  setTimeout(() => { try { child.kill() } catch {} process.exit(0) }, 100)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stderr: stderr.join('').slice(-1000),
  })}\n`)
  try { operator.quit('auto pause failed') } catch {}
  try { child.kill() } catch {}
  process.exit(1)
}

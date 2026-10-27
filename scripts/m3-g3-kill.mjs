#!/usr/bin/env node
/**
 * M3 G3 forced-body-kill: run a long move, kill the body process, then use a
 * separate observer bot to check that P2_Bot is gone from the server.
 *
 * Build first: npm run build
 * Usage: node scripts/m3-g3-kill.mjs [host] [port]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import mineflayer from 'mineflayer'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? '25575')
const bodyUsername = 'P2_Bot'
const observerUsername = 'M3_Observer'

const child = spawn(process.execPath, [join(process.cwd(), 'lib/body/body.mjs')], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    P2_MC_HOST: host,
    P2_MC_PORT: String(port),
    P2_MC_USERNAME: bodyUsername,
    P2_MC_VERSION: '1.21.1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
child.stderr.on('data', () => {})
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
  const requestId = `kill-${seq}`
  return new Promise(resolve => {
    pending.set(requestId, resolve)
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

async function connectObserver() {
  const observer = mineflayer.createBot({
    host,
    port,
    username: observerUsername,
    auth: 'offline',
    version: '1.21.1',
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('observer spawn timeout')), 15_000)
    observer.once('spawn', () => { clearTimeout(timer); resolve() })
    observer.once('error', error => { clearTimeout(timer); reject(error) })
  })
  await sleep(800)
  const players = Object.keys(observer.players)
  observer.quit('observation complete')
  return players
}

try {
  const hello = value(await request('hello', {
    protocols: [1],
    owner: { sessionId: 'm3-kill', agentId: 'kill', cwd: process.cwd() },
  }))
  epoch = hello.bodyEpoch
  const checked = value(await request('check', {
    sourcePath: join(process.cwd(), 'scripts', 'm3-g3-source.mjs'),
  }, 'kill-check'))
  value(await request('activate', { artifactId: checked.artifactId }, 'kill-activate'))
  const switched = value(await request('switch', {
    artifactId: checked.artifactId,
    params: {},
  }, 'kill-switch'))
  await sleep(900)

  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  child.kill()
  const exit = await Promise.race([
    exited,
    sleep(3000).then(() => ({ code: null, signal: 'kill-timeout' })),
  ])
  await sleep(1000)
  const players = await connectObserver()
  process.stdout.write(`${JSON.stringify({
    ok: !players.includes(bodyUsername),
    bodyUsername,
    switched,
    bodyExit: exit,
    playersAfterKill: players,
    p2Absent: !players.includes(bodyUsername),
  })}\n`)
  process.exit(0)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
  try { child.kill() } catch {}
  process.exit(1)
}

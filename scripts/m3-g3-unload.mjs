#!/usr/bin/env node
/**
 * M3 G3 world unload: run a long move, wait for the operator to save-and-quit
 * the LAN world, then wait for the world/LAN port to return, start a fresh
 * body, and verify a new epoch without replaying the old run.
 *
 * Build first: npm run build
 * Usage: node scripts/m3-g3-unload.mjs [host] [port]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import net from 'node:net'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? '25575')
const username = 'P2_Bot'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function portOpen() {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port })
    const done = value => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(800)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function body() {
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
  const request = (method, params = {}, commandId) => {
    seq += 1
    const requestId = `unload-${seq}`
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
  return {
    child,
    stderr,
    request,
    setEpoch: value => { epoch = value },
    value: response => {
      if (response.error !== undefined) throw new Error(`${response.error.code}: ${response.error.message}`)
      return response.result
    },
  }
}

try {
  const b1 = await (async () => {
    const b = await body()
    const hello = b.value(await b.request('hello', {
      protocols: [1],
      owner: { sessionId: 'm3-unload', agentId: 'unload', cwd: process.cwd() },
    }))
    b.setEpoch(hello.bodyEpoch)
    return b
  })()
  let heartbeatSeq = 0
  const heartbeat = setInterval(() => {
    heartbeatSeq += 1
    void b1.request('heartbeat', { seq: heartbeatSeq }).catch(() => {})
  }, 1000)
  heartbeat.unref?.()

  const checked = b1.value(await b1.request('check', {
    sourcePath: join(process.cwd(), 'scripts', 'm3-g3-source.mjs'),
  }, 'unload-check'))
  b1.value(await b1.request('activate', { artifactId: checked.artifactId }, 'unload-activate'))
  const switched = b1.value(await b1.request('switch', {
    artifactId: checked.artifactId,
    params: {},
  }, 'unload-switch'))
  await sleep(900)
  process.stdout.write('READY: save and quit to title now; keep the world saved.\n')

  const oldEpoch = b1.value(await b1.request('status', {})).bodyEpoch
  let oldRunTerminal
  let oldObserveError
  for (let i = 0; i < 120; i += 1) {
    await sleep(1000)
    try {
      const status = b1.value(await b1.request('status', {}))
      if (status.activeRun === null) {
        oldRunTerminal = status
        try {
          b1.value(await b1.request('observe', { op: 'position' }))
        } catch (error) {
          oldObserveError = error instanceof Error ? error.message : String(error)
        }
        break
      }
    } catch (error) {
      oldObserveError = error instanceof Error ? error.message : String(error)
      break
    }
  }
  clearInterval(heartbeat)

  let down = false
  for (let i = 0; i < 120 && !down; i += 1) {
    await sleep(500)
    down = !(await portOpen())
  }
  process.stdout.write('WORLD_DOWN: reopen the world and LAN on the same port now.\n')

  let up = false
  for (let i = 0; i < 240 && !up; i += 1) {
    await sleep(500)
    up = await portOpen()
  }
  if (!up) throw new Error('LAN port did not return')
  await sleep(1000)

  const b2 = await (async () => {
    const b = await body()
    const hello = b.value(await b.request('hello', {
      protocols: [1],
      owner: { sessionId: 'm3-unload', agentId: 'unload-new', cwd: process.cwd() },
    }))
    b.setEpoch(hello.bodyEpoch)
    return b
  })()
  const observed = b2.value(await b2.request('observe', { op: 'position' }))
  const status2 = b2.value(await b2.request('status', {}))
  const result = {
    ok: oldRunTerminal !== undefined && oldObserveError !== undefined
      && up && status2.bodyEpoch !== oldEpoch && status2.activeRun === null,
    oldEpoch,
    oldRunTerminal,
    oldObserveError,
    worldDown: down,
    worldUp: up,
    newEpoch: status2.bodyEpoch,
    newObserved: observed.value,
    newActiveRun: status2.activeRun,
    switched,
    stderr1: b1.stderr.join('').slice(-1000),
    stderr2: b2.stderr.join('').slice(-1000),
  }
  await b2.request('shutdown', {}, 'unload-shutdown-2').catch(() => {})
  await b1.request('shutdown', {}, 'unload-shutdown-1').catch(() => {})
  b1.child.stdin.end()
  b2.child.stdin.end()
  process.stdout.write(`${JSON.stringify(result)}\n`)
  setTimeout(() => {
    try { b1.child.kill() } catch {}
    try { b2.child.kill() } catch {}
    process.exit(0)
  }, 100)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
  process.exit(1)
}

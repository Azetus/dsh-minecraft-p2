#!/usr/bin/env node
/**
 * M5 G2 harness: drive a real body + real Minecraft through the body protocol
 * and an opped operator bot, then record evidence.
 *
 * Usage: node scripts/m5-g2.mjs s1|s2|s3|s4 [--keep]
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import mineflayer from 'mineflayer'

const scenario = process.argv[2]
const keep = process.argv.includes('--keep')
if (!['s1', 's2', 's3', 's4', 's1x', 's2x', 's3x', 's4x', 's1v', 's2v', 's3v', 's4v'].includes(scenario)) {
  console.error('usage: node scripts/m5-g2.mjs <s1|s2|s3|s4|s1x|s2x|s3x|s4x|s1v|s2v|s3v|s4v> [--keep]')
  process.exit(2)
}

const WORKSPACE = process.cwd()
const HOST = '127.0.0.1'
const PORT = 25575
const VERSION = '1.21.1'
const ARENA = { x1: 100, y: 99, z1: 100, x2: 120, z2: 120, floor: 99, feet: 100 }
const WAYPOINTS = {
  A: { x: 104, y: 100, z: 104 },
  B: { x: 116, y: 100, z: 104 },
  C: { x: 116, y: 100, z: 112 },
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const runsDir = join(WORKSPACE, '.m5-runs')
mkdirSync(runsDir, { recursive: true })

class Body {
  constructor() {
    this.child = spawn(process.execPath, [join(WORKSPACE, 'lib', 'body', 'body.mjs')], {
      cwd: WORKSPACE,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.pending = new Map()
    this.epoch = undefined
    this.logs = []
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', line => this.onLine(line))
    createInterface({ input: this.child.stderr, crlfDelay: Infinity }).on('line', line => this.logs.push(line))
    this.child.once('exit', code => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error(`body exited with ${code}`))
      }
      this.pending.clear()
    })
  }

  onLine(line) {
    if (line.trim() === '') return
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.requestId === undefined) return
    const pending = this.pending.get(message.requestId)
    if (pending === undefined) return
    this.pending.delete(message.requestId)
    clearTimeout(pending.timer)
    if (message.error !== undefined) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code, error: message.error }))
    else pending.resolve(message.result)
  }

  request(method, params, options = {}) {
    const requestId = `m5-${randomUUID()}`
    const envelope = { protocol: 1, requestId, method, params }
    if (this.epoch !== undefined) envelope.bodyEpoch = this.epoch
    if (options.commandId !== undefined) envelope.commandId = options.commandId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`${method} timed out`))
      }, options.timeoutMs ?? 20_000)
      this.pending.set(requestId, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify(envelope)}\n`)
    })
  }

  async hello() {
    const result = await this.request('hello', {
      protocols: [1],
      owner: { sessionId: 'm5-g2', agentId: 'harness', cwd: WORKSPACE },
    })
    this.epoch = result.bodyEpoch
    this.heartbeatSeq = 0
    this.heartbeatTimer = setInterval(() => {
      this.heartbeatSeq += 1
      this.request('heartbeat', { seq: this.heartbeatSeq }, { timeoutMs: 5000 }).catch(() => {})
    }, 2000)
    return result
  }

  close() {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    try { this.child.stdin.write(`${JSON.stringify({ protocol: 1, requestId: `m5-${randomUUID()}`, method: 'shutdown', bodyEpoch: this.epoch, commandId: `shutdown-${Date.now()}`, params: {} })}\n`) } catch {}
    setTimeout(() => { try { this.child.kill() } catch {} }, 500)
  }
}

async function connectBot(name) {
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: name, auth: 'offline', version: VERSION })
  bot.chatLog = []
  bot.on('messagestr', message => bot.chatLog.push(message))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} spawn timeout`)), 20_000)
    bot.once('spawn', () => { clearTimeout(timer); resolve() })
    bot.once('error', error => { clearTimeout(timer); reject(error) })
  })
  return bot
}

async function command(bot, line, waitMs = 250) {
  bot.chat(line.startsWith('/') ? line : `/` + line)
  await sleep(waitMs)
}

async function prepareArena(operator) {
  // The arena chunks must be loaded before any fill/setblock takes effect.
  await command(operator, 'forceload add 96 96 128 128', 800)
  await command(operator, `tp P2_Operator ${ARENA.x1 + 2} ${ARENA.feet} ${ARENA.z1 + 2}`, 500)
  await command(operator, `fill ${ARENA.x1} ${ARENA.floor} ${ARENA.z1} ${ARENA.x2} ${ARENA.floor} ${ARENA.z2} minecraft:stone`, 800)
  await command(operator, `fill ${ARENA.x1} ${ARENA.floor + 1} ${ARENA.z1} ${ARENA.x2} ${ARENA.floor + 5} ${ARENA.z2} minecraft:air`, 800)
  await command(operator, `kill @e[type=minecraft:item,x=${ARENA.x1 - 5},y=-64,z=${ARENA.z1 - 5},dx=40,dy=220,dz=40]`, 300)
  await command(operator, 'time set day', 100)
  await command(operator, 'weather clear', 100)
  await command(operator, 'gamerule doDaylightCycle false', 100)
  await command(operator, 'gamerule doMobSpawning false', 100)
  await command(operator, 'gamerule keepInventory true', 100)
  await command(operator, 'difficulty peaceful', 100)
}

async function waitFor(fn, label, timeoutMs = 120_000, interval = 200) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last !== undefined && last !== false) return last
    await sleep(interval)
  }
  throw new Error(`${label} timed out`)
}

async function inspect(body) {
  return body.request('status', {}, { timeoutMs: 5000 })
}

async function position(body) {
  const result = await body.request('observe', { op: 'position', args: {} })
  return result.value
}

async function inventory(body) {
  const result = await body.request('observe', { op: 'inventory', args: {} })
  return result.value
}

function countItem(items, name) {
  return (items ?? []).filter(item => item.name === name).reduce((sum, item) => sum + (item.count ?? 0), 0)
}

async function checkAndActivate(body, paths) {
  const result = {}
  for (const [kind, path] of paths) {
    const checked = await body.request('check', { sourcePath: path, artifactKind: kind }, { commandId: `check-${kind}-${Date.now()}-${Math.random()}` , timeoutMs: 30_000 })
    result[kind] = checked
    if (kind !== 'policy') {
      await body.request('activate', { artifactId: checked.artifactId }, { commandId: `act-${checked.artifactId}-${Date.now()}` })
    }
  }
  return result
}

async function scenarioS1(context) {
  const { body, operator } = context
  await command(operator, 'clear P2_Bot', 200)
  const items = [[106, 106], [108, 106], [110, 106]]
  for (const [x, z] of items) {
    await command(operator, `summon minecraft:item ${x} ${ARENA.feet} ${z} {Item:{id:"minecraft:apple",Count:1b},PickupDelay:5}`, 200)
  }
  await command(operator, `tp P2_Bot 104 ${ARENA.feet} 104`, 400)
  const debugRaw = await body.request('observe', { op: 'entities', args: {} })
  const debugItems = await body.request('observe', { op: 'entities', args: { objectType: 'Item' } })
  const debug = {
    rawCount: debugRaw.value.length,
    itemLike: debugRaw.value.filter(entity => entity.name === 'item' || entity.objectType === 'Item'),
    filteredCount: debugItems.value.length,
    chat: operator.chatLog.slice(-8),
  }
  const artifacts = await checkAndActivate(body, [
    ['act', join(WORKSPACE, 'acts', 'move-to.mjs')],
    ['act', join(WORKSPACE, 'acts', 'stop.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'pick-nearest.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'item-count.mjs')],
    ['behavior', join(WORKSPACE, 'behaviors', 'm5-pick-nearest.mjs')],
  ])
  const switched = await body.request('switch', {
    artifactId: artifacts.behavior.artifactId,
    params: { item: 'apple' },
  }, { commandId: `switch-${Date.now()}` })
  const timeline = []
  const final = await waitFor(async () => {
    const status = await inspect(body)
    timeline.push({ t: Date.now(), run: status.activeRun, last: status.lastRun, activeAct: status.activeAct, waiting: status.waiting })
    return status.lastRun !== null && status.lastRun !== undefined ? status.lastRun : undefined
  }, 'S1 run terminal')
  const inv = await inventory(body)
  const inventoryCount = countItem(inv, 'apple')
  const remainingEntities = await body.request('observe', { op: 'entities', args: { objectType: 'Item' } })
  return {
    scenario: 'S1',
    debug,
    switched,
    final,
    inventoryCount,
    remainingItems: remainingEntities.value.length,
    timeline: timeline.slice(-20),
    artifacts: Object.fromEntries(Object.entries(artifacts).map(([kind, value]) => [kind, { artifactId: value.artifactId, definitionId: value.definitionId }])),
  }
}

async function scenarioS2(context) {
  const { body, operator } = context
  await command(operator, `tp P2_Bot ${WAYPOINTS.A.x} ${WAYPOINTS.A.y} ${WAYPOINTS.A.z}`, 400)
  const artifacts = await checkAndActivate(body, [
    ['act', join(WORKSPACE, 'acts', 'move-to.mjs')],
    ['act', join(WORKSPACE, 'acts', 'stop.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'next-waypoint.mjs')],
    ['behavior', join(WORKSPACE, 'behaviors', 'm5-patrol.mjs')],
  ])
  const route = [WAYPOINTS.A, WAYPOINTS.B, WAYPOINTS.C]
  await body.request('switch', {
    artifactId: artifacts.behavior.artifactId,
    params: { route },
  }, { commandId: `switch-${Date.now()}` })
  const arrivals = []
  const positions = []
  const waypointList = ['A', 'B', 'C', 'A', 'B', 'C']
  let index = 0
  const deadline = Date.now() + 90_000
  while (index < waypointList.length && Date.now() < deadline) {
    const pos = await position(body)
    positions.push({ t: Date.now(), x: pos.x, z: pos.z })
    const target = WAYPOINTS[waypointList[index]]
    if (Math.hypot(pos.x - target.x, pos.z - target.z) <= 0.8) {
      arrivals.push({ name: waypointList[index], at: Date.now() })
      index += 1
    }
    await sleep(150)
  }
  const statusBeforeStop = await inspect(body)
  const runId = statusBeforeStop.activeRun?.runId
  const stopped = await body.request('behavior.stop', runId === undefined ? {} : { runId }, { commandId: `stop-${Date.now()}` })
  const final = await waitFor(async () => {
    const status = await inspect(body)
    return status.activeRun === null && status.lastRun !== null ? status.lastRun : undefined
  }, 'S2 cancel terminal', 30_000)
  return { scenario: 'S2', arrivals, positions: positions.slice(-30), statusBeforeStop, stopped, final }
}

async function scenarioS3(context) {
  const { body, operator } = context
  await command(operator, 'clear P2_Bot', 200)
  await command(operator, 'give P2_Bot minecraft:dirt 2', 200)
  const targets = []
  for (let index = 0; index < 6; index += 1) {
    const x = 104 + index
    const z = 116
    await command(operator, `setblock ${x} ${ARENA.feet} ${z} minecraft:dirt`, 120)
    targets.push({ pos: { x, y: ARENA.feet, z }, stand: { x, z: z - 1 } })
  }
  await command(operator, `tp P2_Bot 104 ${ARENA.feet} 113`, 400)
  const artifacts = await checkAndActivate(body, [
    ['act', join(WORKSPACE, 'acts', 'move-to.mjs')],
    ['act', join(WORKSPACE, 'acts', 'stop.mjs')],
    ['act', join(WORKSPACE, 'acts', 'mine-one.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'item-count.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'pick-target.mjs')],
    ['behavior', join(WORKSPACE, 'behaviors', 'm5-gather-quota.mjs')],
  ])
  await body.request('switch', {
    artifactId: artifacts.behavior.artifactId,
    params: { targets, item: 'dirt', want: 4 },
  }, { commandId: `switch-${Date.now()}` })
  const timeline = []
  const final = await waitFor(async () => {
    const status = await inspect(body)
    timeline.push({ t: Date.now(), run: status.activeRun, last: status.lastRun, activeAct: status.activeAct, waiting: status.waiting })
    return status.lastRun !== null && status.lastRun !== undefined ? status.lastRun : undefined
  }, 'S3 run terminal', 150_000)
  const inv = await inventory(body)
  return { scenario: 'S3', final, inventoryCount: countItem(inv, 'dirt'), timeline: timeline.slice(-30) }
}

async function scenarioS4(context) {
  const { body, operator } = context
  const start = Date.now()
  await command(operator, 'clear P2_Bot', 200)
  await command(operator, `tp P2_Bot ${WAYPOINTS.A.x} ${WAYPOINTS.A.y} ${WAYPOINTS.A.z}`, 300)
  const artifacts = await checkAndActivate(body, [
    ['act', join(WORKSPACE, 'acts', 'move-to.mjs')],
    ['act', join(WORKSPACE, 'acts', 'stop.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'pick-nearest.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'next-waypoint.mjs')],
    ['behavior', join(WORKSPACE, 'behaviors', 'm5-patrol-pickup.mjs')],
  ])
  await body.request('switch', {
    artifactId: artifacts.behavior.artifactId,
    params: { route: [WAYPOINTS.A, WAYPOINTS.B, WAYPOINTS.C], item: 'apple' },
  }, { commandId: `switch-${Date.now()}` })
  const positions = []
  const events = []
  let itemSpawned = false
  let pickupSeen = false
  let sawB = false
  let sawC = false
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const pos = await position(body)
    positions.push({ t: Date.now() - start, x: pos.x, z: pos.z })
    const status = await inspect(body)
    if (status.activeRun === null) {
      events.push({ kind: 'run-ended', status })
      break
    }
    const distanceToB = Math.hypot(pos.x - WAYPOINTS.B.x, pos.z - WAYPOINTS.B.z)
    if (!itemSpawned && distanceToB < 6 && distanceToB > 3) {
      await command(operator, `summon minecraft:item 110 ${ARENA.feet} 106 {Item:{id:"minecraft:apple",Count:1b},PickupDelay:5}`, 100)
      itemSpawned = true
      events.push({ kind: 'item-spawned', at: Date.now() - start, distanceToB })
    }
    const inv = await inventory(body)
    if (itemSpawned && !pickupSeen && countItem(inv, 'apple') >= 1) {
      pickupSeen = true
      events.push({ kind: 'pickup', at: Date.now() - start })
    }
    if (pickupSeen && !sawB && distanceToB <= 0.8) {
      sawB = true
      events.push({ kind: 'reached-B', at: Date.now() - start })
    }
    if (sawB && !sawC && Math.hypot(pos.x - WAYPOINTS.C.x, pos.z - WAYPOINTS.C.z) <= 0.8) {
      sawC = true
      events.push({ kind: 'reached-C', at: Date.now() - start })
      break
    }
    await sleep(200)
  }
  const statusBeforeStop = await inspect(body)
  const runId = statusBeforeStop.activeRun?.runId
  const stopped = await body.request('behavior.stop', runId === undefined ? {} : { runId }, { commandId: `stop-${Date.now()}` })
  const final = await waitFor(async () => {
    const status = await inspect(body)
    return status.activeRun === null && status.lastRun !== null ? status.lastRun : undefined
  }, 'S4 cancel terminal', 30_000)
  const inv = await inventory(body)
  return {
    scenario: 'S4', itemSpawned, pickupSeen, sawB, sawC, events,
    positions: positions.slice(-40), statusBeforeStop, stopped, final,
    inventoryCount: countItem(inv, 'apple'),
  }
}


async function scenarioS1Counter(context) {
  const { body, operator } = context
  await command(operator, 'clear P2_Bot', 200)
  await command(operator, `summon minecraft:item 106 ${ARENA.feet} 106 {Item:{id:"minecraft:apple",Count:1b},PickupDelay:5}`, 150)
  await command(operator, `summon minecraft:item 108 ${ARENA.feet} 106 {Item:{id:"minecraft:apple",Count:1b},PickupDelay:5}`, 150)
  await command(operator, `tp P2_Bot 104 ${ARENA.feet} 104`, 300)
  const artifacts = await checkAndActivate(body, [
    ['act', join(WORKSPACE, 'acts', 'move-to.mjs')],
    ['act', join(WORKSPACE, 'acts', 'stop.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'pick-nearest.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'item-count.mjs')],
    ['behavior', join(WORKSPACE, 'behaviors', 'm5-pick-nearest.mjs')],
  ])
  await body.request('switch', { artifactId: artifacts.behavior.artifactId, params: { item: 'apple' } }, { commandId: `switch-${Date.now()}` })
  await sleep(120)
  // Make the selected target disappear before it can be picked up.
  await command(operator, 'kill @e[type=minecraft:item,x=105,y=99,z=105,dx=5,dy=4,dz=4]', 300)
  const afterKill = await body.request('observe', { op: 'entities', args: { objectType: 'Item' } })
  const final = await waitFor(async () => {
    const status = await inspect(body)
    return status.lastRun ?? undefined
  }, 'S1x terminal', 60_000)
  const inv = await inventory(body)
  return { scenario: 'S1x', final, inventoryCount: countItem(inv, 'apple'), afterKill: afterKill.value.length, chat: operator.chatLog.slice(-6) }
}

async function scenarioS2Counter(context) {
  const { body, operator } = context
  await command(operator, `tp P2_Bot ${WAYPOINTS.A.x} ${WAYPOINTS.A.y} ${WAYPOINTS.A.z}`, 300)
  // A barrier on the direct path to B; the act must report a failure.
  await command(operator, `fill 110 ${ARENA.feet} 103 110 ${ARENA.feet + 2} 105 minecraft:barrier`, 400)
  const artifacts = await checkAndActivate(body, [
    ['act', join(WORKSPACE, 'acts', 'move-to.mjs')],
    ['act', join(WORKSPACE, 'acts', 'stop.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'next-waypoint.mjs')],
    ['behavior', join(WORKSPACE, 'behaviors', 'm5-patrol.mjs')],
  ])
  await body.request('switch', { artifactId: artifacts.behavior.artifactId, params: { route: [WAYPOINTS.A, WAYPOINTS.B, WAYPOINTS.C], item: 'apple' } }, { commandId: `switch-${Date.now()}` })
  const final = await waitFor(async () => {
    const status = await inspect(body)
    return status.lastRun ?? undefined
  }, 'S2x terminal', 60_000)
  await command(operator, `fill 110 ${ARENA.feet} 103 110 ${ARENA.feet + 2} 105 minecraft:air`, 200)
  return { scenario: 'S2x', final }
}

async function scenarioS3Counter(context) {
  const { body, operator } = context
  await command(operator, 'clear P2_Bot', 200)
  await command(operator, 'give P2_Bot minecraft:dirt 2', 200)
  const targets = []
  await command(operator, `setblock 104 ${ARENA.feet} 116 minecraft:dirt`, 150)
  targets.push({ pos: { x: 104, y: ARENA.feet, z: 116 }, stand: { x: 104, z: 115 } })
  await command(operator, `tp P2_Bot 104 ${ARENA.feet} 113`, 300)
  const artifacts = await checkAndActivate(body, [
    ['act', join(WORKSPACE, 'acts', 'move-to.mjs')],
    ['act', join(WORKSPACE, 'acts', 'stop.mjs')],
    ['act', join(WORKSPACE, 'acts', 'mine-one.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'item-count.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'pick-target.mjs')],
    ['behavior', join(WORKSPACE, 'behaviors', 'm5-gather-quota.mjs')],
  ])
  await body.request('switch', { artifactId: artifacts.behavior.artifactId, params: { targets, item: 'dirt', want: 4 } }, { commandId: `switch-${Date.now()}` })
  const final = await waitFor(async () => {
    const status = await inspect(body)
    return status.lastRun ?? undefined
  }, 'S3x terminal', 90_000)
  const inv = await inventory(body)
  return { scenario: 'S3x', final, inventoryCount: countItem(inv, 'dirt') }
}

async function scenarioS4Counter(context) {
  const { body, operator } = context
  const start = Date.now()
  await command(operator, 'clear P2_Bot', 200)
  await command(operator, `tp P2_Bot ${WAYPOINTS.A.x} ${WAYPOINTS.A.y} ${WAYPOINTS.A.z}`, 300)
  const artifacts = await checkAndActivate(body, [
    ['act', join(WORKSPACE, 'acts', 'move-to.mjs')],
    ['act', join(WORKSPACE, 'acts', 'stop.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'pick-nearest.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'next-waypoint.mjs')],
    ['behavior', join(WORKSPACE, 'behaviors', 'm5-patrol-pickup.mjs')],
  ])
  await body.request('switch', { artifactId: artifacts.behavior.artifactId, params: { route: [WAYPOINTS.A, WAYPOINTS.B, WAYPOINTS.C], item: 'apple' } }, { commandId: `switch-${Date.now()}` })
  const events = []
  let spawned = false
  let sawB = false
  let sawC = false
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const pos = await position(body)
    const status = await inspect(body)
    if (status.activeRun === null) { events.push({ kind: 'run-ended', status }); break }
    const distanceToB = Math.hypot(pos.x - WAYPOINTS.B.x, pos.z - WAYPOINTS.B.z)
    if (!spawned && distanceToB < 6 && distanceToB > 3) {
      await command(operator, `summon minecraft:item 110 ${ARENA.feet} 106 {Item:{id:"minecraft:apple",Count:1b},PickupDelay:5}`, 100)
      await sleep(1200)
      await command(operator, 'kill @e[type=minecraft:item,x=117,y=99,z=113,dx=3,dy=4,dz=3]', 150)
      const after = await body.request('observe', { op: 'entities', args: { objectType: 'Item' } })
      afterKill = after.value.length
      spawned = true
      events.push({ kind: 'spawn-and-remove', at: Date.now() - start })
    }
    if (spawned && !sawB && distanceToB <= 0.8) { sawB = true; events.push({ kind: 'reached-B', at: Date.now() - start }) }
    if (sawB && !sawC && Math.hypot(pos.x - WAYPOINTS.C.x, pos.z - WAYPOINTS.C.z) <= 0.8) {
      sawC = true
      events.push({ kind: 'reached-C', at: Date.now() - start })
      break
    }
    await sleep(200)
  }
  const statusBeforeStop = await inspect(body)
  const runId = statusBeforeStop.activeRun?.runId
  const stopped = await body.request('behavior.stop', runId === undefined ? {} : { runId }, { commandId: `stop-${Date.now()}` })
  const final = await waitFor(async () => {
    const status = await inspect(body)
    return status.activeRun === null && status.lastRun !== null ? status.lastRun : undefined
  }, 'S4x cancel terminal', 30_000)
  return { scenario: 'S4x', sawB, sawC, events, stopped, final }
}

async function scenarioS1Variant(context) {
  const { body, operator } = context
  await command(operator, 'clear P2_Bot', 200)
  for (const [x, z] of [[106, 106], [108, 106], [110, 106]]) {
    await command(operator, `summon minecraft:item ${x} ${ARENA.feet} ${z} {Item:{id:"minecraft:apple",Count:1b},PickupDelay:5}`, 150)
  }
  await command(operator, `tp P2_Bot 104 ${ARENA.feet} 104`, 300)
  const artifacts = await checkAndActivate(body, [
    ['act', join(WORKSPACE, 'acts', 'move-to.mjs')],
    ['act', join(WORKSPACE, 'acts', 'stop.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'pick-farthest.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'item-count.mjs')],
    ['behavior', join(WORKSPACE, 'behaviors', 'm5-pick-farthest.mjs')],
  ])
  await body.request('switch', { artifactId: artifacts.behavior.artifactId, params: { item: 'apple' } }, { commandId: `switch-${Date.now()}` })
  const final = await waitFor(async () => {
    const status = await inspect(body)
    return status.lastRun ?? undefined
  }, 'S1v terminal', 90_000)
  const pos = await position(body)
  const inv = await inventory(body)
  return { scenario: 'S1v', final, position: pos, inventoryCount: countItem(inv, 'apple'), farthestDistance: Math.hypot(pos.x - 110.5, pos.z - 106.5) }
}

async function scenarioS4Variant(context) {
  const { body, operator } = context
  const start = Date.now()
  await command(operator, 'clear P2_Bot', 200)
  await command(operator, `tp P2_Bot ${WAYPOINTS.A.x} ${WAYPOINTS.A.y} ${WAYPOINTS.A.z}`, 300)
  const artifacts = await checkAndActivate(body, [
    ['act', join(WORKSPACE, 'acts', 'move-to.mjs')],
    ['act', join(WORKSPACE, 'acts', 'stop.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'pick-nearest.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'next-waypoint.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'item-count.mjs')],
    ['behavior', join(WORKSPACE, 'behaviors', 'm5-patrol-pickup-fail.mjs')],
  ])
  await body.request('switch', { artifactId: artifacts.behavior.artifactId, params: { route: [WAYPOINTS.A, WAYPOINTS.B, WAYPOINTS.C], item: 'apple' } }, { commandId: `switch-${Date.now()}` })
  let spawned = false
  let final
  let afterKill
  const timeline = []
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const pos = await position(body)
    const status = await inspect(body)
    timeline.push({ t: Date.now() - start, act: status.activeAct, wait: status.waiting, run: status.activeRun === null ? null : status.activeRun.runId })
    if (status.lastRun !== null && status.lastRun !== undefined) { final = status.lastRun; break }
    const distanceToB = Math.hypot(pos.x - WAYPOINTS.B.x, pos.z - WAYPOINTS.B.z)
    if (!spawned && distanceToB < 6 && distanceToB > 3) {
      await command(operator, `summon minecraft:item 110 ${ARENA.feet} 106 {Item:{id:"minecraft:apple",Count:1b},PickupDelay:5}`, 100)
      await sleep(1200)
      await command(operator, 'kill @e[type=minecraft:item,x=117,y=99,z=113,dx=3,dy=4,dz=3]', 150)
      const after = await body.request('observe', { op: 'entities', args: { objectType: 'Item' } })
      afterKill = after.value.length
      spawned = true
    }
    await sleep(200)
  }
  if (final === undefined) {
    const status = await inspect(body)
    await body.request('behavior.stop', status.activeRun === null ? {} : { runId: status.activeRun.runId }, { commandId: `stop-${Date.now()}` })
    final = await waitFor(async () => {
      const status2 = await inspect(body)
      return status2.lastRun ?? undefined
    }, 'S4v terminal', 30_000)
  }
  return { scenario: 'S4v', spawned, afterKill, final, timeline: timeline.slice(-25), elapsedMs: Date.now() - start }
}

async function scenarioS2Variant(context) {
  const { body, operator } = context
  await command(operator, `tp P2_Bot ${WAYPOINTS.A.x} ${WAYPOINTS.A.y} ${WAYPOINTS.A.z}`, 300)
  const artifacts = await checkAndActivate(body, [
    ['act', join(WORKSPACE, 'acts', 'move-to.mjs')],
    ['act', join(WORKSPACE, 'acts', 'stop.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'next-waypoint-bounce.mjs')],
    ['behavior', join(WORKSPACE, 'behaviors', 'm5-patrol-bounce.mjs')],
  ])
  await body.request('switch', { artifactId: artifacts.behavior.artifactId, params: { route: [WAYPOINTS.A, WAYPOINTS.B, WAYPOINTS.C], item: 'apple' } }, { commandId: `switch-${Date.now()}` })
  const arrivals = []
  const expected = ['A', 'B', 'C', 'B', 'A']
  let index = 0
  const deadline = Date.now() + 90_000
  while (index < expected.length && Date.now() < deadline) {
    const pos = await position(body)
    const target = WAYPOINTS[expected[index]]
    if (Math.hypot(pos.x - target.x, pos.z - target.z) <= 0.8) {
      arrivals.push(expected[index])
      index += 1
    }
    await sleep(150)
  }
  const statusBeforeStop = await inspect(body)
  const stopped = await body.request('behavior.stop', statusBeforeStop.activeRun === null ? {} : { runId: statusBeforeStop.activeRun.runId }, { commandId: `stop-${Date.now()}` })
  const final = await waitFor(async () => {
    const status = await inspect(body)
    return status.activeRun === null && status.lastRun !== null ? status.lastRun : undefined
  }, 'S2v cancel terminal', 30_000)
  return { scenario: 'S2v', arrivals, stopped, final }
}

async function scenarioS3Variant(context) {
  const { body, operator } = context
  await command(operator, 'clear P2_Bot', 200)
  await command(operator, 'give P2_Bot minecraft:dirt 2', 200)
  const targets = []
  for (let index = 0; index < 2; index += 1) {
    const x = 104 + index
    await command(operator, `setblock ${x} ${ARENA.feet} 116 minecraft:dirt`, 120)
    targets.push({ pos: { x, y: ARENA.feet, z: 116 }, stand: { x, z: 115 } })
  }
  await command(operator, `tp P2_Bot 104 ${ARENA.feet} 113`, 300)
  const artifacts = await checkAndActivate(body, [
    ['act', join(WORKSPACE, 'acts', 'move-to.mjs')],
    ['act', join(WORKSPACE, 'acts', 'stop.mjs')],
    ['act', join(WORKSPACE, 'acts', 'mine-one.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'item-count.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'pick-target.mjs')],
    ['policy', join(WORKSPACE, 'policies', 'is-near.mjs')],
    ['behavior', join(WORKSPACE, 'behaviors', 'm5-gather-return.mjs')],
  ])
  await body.request('switch', {
    artifactId: artifacts.behavior.artifactId,
    params: { targets, item: 'dirt', want: 4, home: { x: 104, z: 113 } },
  }, { commandId: `switch-${Date.now()}` })
  const final = await waitFor(async () => {
    const status = await inspect(body)
    return status.lastRun ?? undefined
  }, 'S3v terminal', 150_000)
  const inv = await inventory(body)
  const pos = await position(body)
  return { scenario: 'S3v', final, inventoryCount: countItem(inv, 'dirt'), position: pos, distanceHome: Math.hypot(pos.x - 104, pos.z - 113) }
}
const operator = await connectBot('P2_Operator')
const body = new Body()
let result
try {
  await prepareArena(operator)
  await body.hello()
  const describe = await body.request('describe', {})
  console.log(`body=${describe.body.version} binding=${describe.bindingId}`)
  await waitFor(async () => (operator.players.P2_Bot === undefined ? undefined : true), 'P2_Bot online', 20_000, 200)
  await sleep(800)
  result = await ({ s1: scenarioS1, s2: scenarioS2, s3: scenarioS3, s4: scenarioS4, s1x: scenarioS1Counter, s2x: scenarioS2Counter, s3x: scenarioS3Counter, s4x: scenarioS4Counter, s1v: scenarioS1Variant, s2v: scenarioS2Variant, s3v: scenarioS3Variant, s4v: scenarioS4Variant })[scenario]({ body, operator })
  result.ok = result.final?.status === 'succeeded' || result.final?.status === 'cancelled'
  result.describe = describe
} catch (error) {
  result = { ok: false, error: error instanceof Error ? error.message : String(error), logs: body.logs.slice(-40) }
} finally {
  try { await command(operator, `kill @e[type=minecraft:item,x=${ARENA.x1 - 5},y=-64,z=${ARENA.z1 - 5},dx=40,dy=220,dz=40]`, 200) } catch {}
  try { await command(operator, 'clear P2_Bot', 200) } catch {}
  try { await command(operator, `tp P2_Bot 104 ${ARENA.feet} 104`, 200) } catch {}
  try { await command(operator, 'forceload remove 96 96 128 128', 200) } catch {}
  if (!keep) body.close()
  try { operator.quit('m5 g2 done') } catch {}
}
const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
const evidencePath = join(runsDir, `${scenario}-${stamp}.json`)
writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
process.exitCode = result.ok ? 0 : 1

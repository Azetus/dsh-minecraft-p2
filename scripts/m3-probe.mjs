#!/usr/bin/env node
/**
 * Minimal M3 G0 probe: connect a vanilla-protocol Mineflayer bot to the
 * already-open single-player LAN world and report its spawn facts.
 *
 * Usage: node scripts/m3-probe.mjs [host] [port] [username]
 */
import { randomUUID } from 'node:crypto'
import mineflayer from 'mineflayer'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? '25575')
const username = process.argv[4] ?? 'P2_Bot'
const connectionEpoch = randomUUID()

const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth: 'offline',
  version: '1.21.1',
  hideErrors: false,
})

let settled = false
const finish = (code, text) => {
  if (settled) return
  settled = true
  process.stdout.write(`${text}\n`)
  try { bot.quit('probe complete') } catch {}
  setTimeout(() => process.exit(code), 50)
}

const timer = setTimeout(() => finish(1, 'probe timeout: no spawn within 15s'), 15_000)

bot.once('spawn', () => {
  clearTimeout(timer)
  setTimeout(() => {
    const position = bot.entity?.position
    let inventory = null
    let below = null
    let feet = null
    let head = null
    try {
      inventory = bot.inventory.items().map(item => ({ name: item.name, count: item.count }))
    } catch (error) {
      inventory = { error: error instanceof Error ? error.message : String(error) }
    }
    try {
      below = bot.blockAt(position?.offset(0, -1, 0))?.name ?? null
      feet = bot.blockAt(position)?.name ?? null
      head = bot.blockAt(position?.offset(0, 1, 0))?.name ?? null
    } catch (error) {
      below = { error: error instanceof Error ? error.message : String(error) }
    }
    const entities = Object.values(bot.entities)
      .filter(entity => entity !== bot.entity)
      .slice(0, 20)
      .map(entity => ({
        id: entity.id,
        name: entity.name ?? null,
        type: entity.type ?? null,
        position: entity.position === undefined
          ? null
          : { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      }))
    finish(0, JSON.stringify({
      ok: true,
      observedAt: new Date().toISOString(),
      sampledAt: Date.now(),
      connectionEpoch,
      username: bot.username,
      version: bot.version,
      position: position === undefined ? null : { x: position.x, y: position.y, z: position.z },
      dimension: bot.game?.dimension ?? null,
      gameMode: bot.game?.gameMode ?? null,
      difficulty: bot.game?.difficulty ?? null,
      timeOfDay: typeof bot.time?.timeOfDay === 'bigint'
        ? Number(bot.time.timeOfDay)
        : bot.time?.timeOfDay ?? null,
      players: Object.keys(bot.players),
      health: bot.health,
      food: bot.food,
      inventory,
      below,
      feet,
      head,
      entities,
    }))
  }, 1000)
})

bot.on('kicked', reason => {
  clearTimeout(timer)
  finish(1, `kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`)
})

bot.on('error', error => {
  clearTimeout(timer)
  finish(1, `error: ${error instanceof Error ? error.message : String(error)}`)
})

bot.on('end', reason => {
  if (!settled) {
    clearTimeout(timer)
    finish(1, `ended before spawn: ${reason ?? 'unknown'}`)
  }
})

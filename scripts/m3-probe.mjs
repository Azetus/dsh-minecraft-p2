#!/usr/bin/env node
/**
 * Minimal M3 G0 probe: connect a vanilla-protocol Mineflayer bot to the
 * already-open single-player LAN world and report its spawn facts.
 *
 * Usage: node scripts/m3-probe.mjs [host] [port] [username]
 */
import mineflayer from 'mineflayer'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? '25575')
const username = process.argv[4] ?? 'P2_Bot'

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
    try {
      inventory = bot.inventory.items().map(item => ({ name: item.name, count: item.count }))
    } catch (error) {
      inventory = { error: error instanceof Error ? error.message : String(error) }
    }
    try {
      const block = bot.blockAt(position?.offset(0, -1, 0))
      below = block === null ? null : block.name
    } catch (error) {
      below = { error: error instanceof Error ? error.message : String(error) }
    }
    finish(0, JSON.stringify({
      ok: true,
      username: bot.username,
      version: bot.version,
      position: position === undefined ? null : { x: position.x, y: position.y, z: position.z },
      dimension: bot.game?.dimension ?? null,
      gameMode: bot.game?.gameMode ?? null,
      players: Object.keys(bot.players),
      health: bot.health,
      food: bot.food,
      inventory,
      below,
    }))
  }, 500)
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

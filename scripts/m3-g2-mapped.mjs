#!/usr/bin/env node
/**
 * M3 G2 mapping probe: drive look/move/jump/stop through the P2 executor and
 * the Mineflayer Query/Act adapter. No mining, placing, attacking, or item use.
 *
 * Build first: npm run build
 * Usage: node scripts/m3-g2-mapped.mjs [host] [port] [username]
 */
import { randomUUID } from 'node:crypto'
import mineflayer from 'mineflayer'
import { runMappedG2 } from '../lib/provider/minecraft.mjs'

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
const finish = (code, value) => {
  if (settled) return
  settled = true
  process.stdout.write(`${JSON.stringify(value)}\n`)
  try { bot.clearControlStates() } catch {}
  try { bot.quit('mapped g2 complete') } catch {}
  setTimeout(() => process.exit(code), 50)
}

const timer = setTimeout(() => finish(1, { ok: false, error: 'mapped G2 timeout', connectionEpoch }), 20_000)

bot.once('spawn', async () => {
  clearTimeout(timer)
  try {
    await new Promise(resolve => setTimeout(resolve, 800))
    const result = await runMappedG2(bot)
    finish(0, {
      ok: result.status === 'succeeded',
      connectionEpoch,
      observedAt: new Date().toISOString(),
      sampledAt: Date.now(),
      result,
      players: Object.keys(bot.players),
      difficulty: bot.game?.difficulty ?? null,
      timeOfDay: typeof bot.time?.timeOfDay === 'bigint'
        ? Number(bot.time.timeOfDay)
        : bot.time?.timeOfDay ?? null,
    })
  } catch (error) {
    finish(1, {
      ok: false,
      connectionEpoch,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

bot.on('kicked', reason => {
  clearTimeout(timer)
  finish(1, { ok: false, error: `kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}` })
})
bot.on('error', error => {
  clearTimeout(timer)
  finish(1, { ok: false, error: error instanceof Error ? error.message : String(error) })
})
bot.on('end', reason => {
  if (!settled) {
    clearTimeout(timer)
    finish(1, { ok: false, error: `ended before mapped G2: ${reason ?? 'unknown'}` })
  }
})

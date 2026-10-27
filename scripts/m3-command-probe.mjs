#!/usr/bin/env node
/**
 * M3 command-permission probe: check whether a test bot may run server commands.
 * This is a test harness only; arbitrary chat commands are not exposed as a P2 act.
 *
 * Usage: node scripts/m3-command-probe.mjs [host] [port] [username]
 */
import mineflayer from 'mineflayer'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? '25575')
const username = process.argv[4] ?? 'P2_CmdProbe'

const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth: 'offline',
  version: '1.21.1',
})

const messages = []
bot.on('message', message => {
  const text = message.toString()
  if (text.trim() !== '') messages.push({ at: Date.now(), text })
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

bot.once('spawn', async () => {
  await sleep(800)
  const commands = [
    '/list',
    '/time query daytime',
    '/tick query',
  ]
  const results = []
  for (const command of commands) {
    const before = messages.length
    bot.chat(command)
    await sleep(800)
    results.push({
      command,
      responses: messages.slice(before).map(entry => entry.text),
    })
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    username,
    players: Object.keys(bot.players),
    results,
  })}\n`)
  bot.quit('command probe complete')
  setTimeout(() => process.exit(0), 100)
})

bot.on('error', error => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
  process.exit(1)
})
setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'timeout' })}\n`)
  process.exit(1)
}, 15_000)

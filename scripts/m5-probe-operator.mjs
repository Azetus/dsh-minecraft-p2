#!/usr/bin/env node
/**
 * M5 probe: can the operator test bot run Minecraft commands?
 * Prints every chat/system message for 3 seconds after each command.
 */
import mineflayer from 'mineflayer'

const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 25575,
  username: process.argv[2] ?? 'P2_Operator',
  auth: 'offline',
  version: '1.21.1',
})

const messages = []
bot.on('messagestr', (message, position) => {
  messages.push({ position, message })
  console.log(`[${position}] ${message}`)
})
bot.on('kicked', reason => console.log(`KICKED: ${String(reason)}`))
bot.on('error', error => console.log(`ERROR: ${error.message}`))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('spawn timeout')), 15_000)
  bot.once('spawn', () => { clearTimeout(timer); resolve() })
  bot.once('error', reject)
})

console.log(`spawned as ${bot.username} at ${JSON.stringify(bot.entity?.position)}`)
for (const command of ['/list', '/time query gametime', '/gamerule doDaylightCycle']) {
  messages.length = 0
  bot.chat(command)
  await sleep(1200)
  console.log(`CMD ${command} -> ${messages.map(item => item.message).join(' | ') || '(no reply)'}`)
}
bot.quit('probe done')

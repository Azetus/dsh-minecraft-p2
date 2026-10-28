#!/usr/bin/env node
/** Probe: build a small platform, summon item entities, print Mineflayer entity data. */
import mineflayer from 'mineflayer'

const connect = username => new Promise((resolve, reject) => {
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25575, username, auth: 'offline', version: '1.21.1' })
  bot.on('messagestr', message => console.log(`[${username}] ${message}`))
  const timer = setTimeout(() => reject(new Error(`${username} timeout`)), 20_000)
  bot.once('spawn', () => { clearTimeout(timer); resolve(bot) })
  bot.once('error', reject)
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const operator = await connect('P2_Operator')
const probe = await connect('P2_Probe')

operator.chat('/fill 100 99 100 120 99 120 minecraft:stone')
await sleep(400)
operator.chat('/fill 100 100 100 120 105 120 minecraft:air')
await sleep(400)
operator.chat('/tp P2_Probe 106 100 106')
await sleep(600)
probe.chat('/kill @e[type=minecraft:item,distance=..64]')
await sleep(300)
operator.chat('/summon minecraft:item 106 100 106 {Item:{id:"minecraft:apple",Count:1b},PickupDelay:5}')
await sleep(600)
operator.chat('/summon minecraft:item 108 100 106 {Item:{id:"minecraft:apple",count:1}}')
await sleep(600)
const entities = Object.values(probe.entities)
  .filter(entity => entity !== probe.entity)
  .map(entity => ({
    id: entity.id,
    name: entity.name,
    type: entity.type,
    objectType: entity.objectType,
    displayName: entity.displayName,
    position: entity.position,
    metadata: entity.metadata,
  }))
  .filter(entity => entity.position !== undefined && Math.hypot(entity.position.x - 106, entity.position.z - 106) < 20)
console.log('ENTITIES', JSON.stringify(entities, null, 2))
await sleep(1500)
operator.chat('/data get entity @e[type=minecraft:item,limit=1,sort=nearest] Item')
await sleep(500)
probe.chat('/kill @e[type=minecraft:item,distance=..64]')
await sleep(300)
probe.quit('probe')
operator.quit('probe')

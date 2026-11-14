import { describe, expect, it } from 'vitest'

import { connectMineflayer, MineflayerProvider } from '../src/provider/mineflayer.ts'
import { MineflayerBody } from '../src/provider/body.ts'
import { createShootDriver } from '../src/mind/drivers/shoot.ts'
import type { DriverCtx, Job } from '../src/mind/types.ts'

const LIVE = process.env.P2_AI_SHOOT_LIVE === '1'
const HOST = process.env.P2_MC_HOST ?? '127.0.0.1'
const PORT = Number(process.env.P2_MC_PORT ?? 25575)
const USERNAME = process.env.P2_MC_USERNAME ?? 'P2_Bot'
const TRIALS = Number(process.env.P2_AI_SHOOT_TRIALS ?? 10)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

type Trial = {
  index: number
  state: string
  code?: string
  hit: boolean
  shots: number
  targetDistance: number
  observed?: unknown
}

type GapReport = {
  gap: number
  trials: Trial[]
  hits: number
  misses: number
  inconclusive: number
  fatal: number
  hitRate: number
}

/**
 * Category: access consistency, live scenario (opt-in).
 *
 *   P2_AI_SHOOT_LIVE=1 npx vitest run test/shoot-ai-live.test.ts --pool=threads
 *
 * Builds two isolated aerial platforms with commands, puts P2 on a 7x7
 * platform and a normal AI zombie plus invulnerable villagers on a 25x25
 * platform, sets midnight, and runs one-shot bow trials at 5- and 7-block edge
 * gaps. The zombie still prefers P2, but the larger platform gives it room to
 * move and the open edge avoids fence hits. It reports hit rate; it does not
 * assert a minimum hit rate because movement is not deterministic.
 */
describe.skipIf(!LIVE)('live AI-zombie shooting', () => {
  it('reports hit rate on moving AI zombies across 5- and 7-block gaps', async () => {
    const bot = await connectMineflayer({ host: HOST, port: PORT, username: USERNAME, timeoutMs: 20_000 })
    const provider = new MineflayerProvider(bot, { serverIdleMs: 1_500, providerVersion: 'live-ai-shoot' })
    const body = new MineflayerBody(bot, provider, { worldId: 'live-ai-shoot' })
    const send = async (command: string): Promise<void> => {
      bot.chat(command)
      await sleep(80)
    }
    const reports: GapReport[] = []
    const origin = { x: 0, y: 0, z: 0 }
    const arena = { x: 0, y: 0, z: 0 }
    const messages: string[] = []
    bot.on('message', message => { messages.push(message.toString()) })
    try {
      await sleep(600)
      body.beginWrite({ runId: 'live-ai-shoot', jobId: 'live-ai-shoot', seq: 1 })
      Object.assign(origin, body.self().pos)
      const x = Math.floor(origin.x) + 10
      const y = Math.floor(origin.y) + 25
      const z = Math.floor(origin.z) + 10
      Object.assign(arena, { x, y, z })
      await send('/gamerule doDaylightCycle false')
      await send('/time set midnight')
      await send('/weather clear')
      await send(`/give ${USERNAME} bow 1`)
      await send(`/give ${USERNAME} arrow 64`)
      // Build the floors before teleporting; an aerial teleport followed by a
      // failed/queued fill can drop P2 into the void.
      await send(`/fill ${x - 5} ${y} ${z - 15} ${x + 50} ${y + 8} ${z + 15} minecraft:air`)
      await send(`/fill ${x - 3} ${y} ${z - 3} ${x + 3} ${y} ${z + 3} minecraft:stone`)
      await send(`/tp @s ${x + 0.5} ${y + 1} ${z + 0.5}`)
      await sleep(500)
      expect(messages.some(message => message.includes('Successfully filled'))).toBe(true)
      expect(messages.some(message => message.includes('Teleported'))).toBe(true)
      expect((await body.equip('bow')).state).toBe('ok')

      for (const gap of [5, 7]) {
        // P2 platform is 7x7 (x-3..x+3); the zombie platform is 25x25.
        // No fence on the far platform: a 1-block fence at the near edge was
        // absorbing arrows when the zombie pressed against it.
        const centerX = x + 16 + gap
        const bx1 = centerX - 12
        const bx2 = centerX + 12
        const bz1 = z - 12
        const bz2 = z + 12
        await send(`/fill ${x + 4} ${y} ${z - 15} ${x + 50} ${y + 4} ${z + 15} minecraft:air`)
        await send(`/fill ${bx1} ${y} ${bz1} ${bx2} ${y} ${bz2} minecraft:stone`)
        await send('/kill @e[type=minecraft:zombie,tag=p2shoot]')
        await send('/kill @e[type=minecraft:villager,tag=p2shoot]')
        // Villagers are invulnerable so they keep moving for the whole batch.
        // The zombie still prefers P2, but the 25x25 platform gives it room.
        for (const [dx, dz] of [[0, 0], [3, 0], [0, 3], [-3, 0], [6, 0], [0, -3]] as const) {
          await send(`/summon minecraft:villager ${centerX + dx + 0.5} ${y + 1} ${z + dz + 0.5} {Tags:["p2shoot"],Invulnerable:1b,PersistenceRequired:1b,Silent:1b}`)
        }
        await send(`/summon minecraft:zombie ${centerX + 0.5} ${y + 1} ${z + 0.5} {Tags:["p2shoot"],PersistenceRequired:1b,Silent:1b}`)
        await sleep(900)
        expect(messages.some(message => message.includes('Summoned new Zombie'))).toBe(true)

        const trials: Trial[] = []
        for (let index = 0; index < TRIALS; index += 1) {
          let zombie = body.entities({
            min: { x: bx1 - 1, y: y, z: bz1 - 1 },
            max: { x: bx2 + 1, y: y + 3, z: bz2 + 1 },
          }).find(entity => entity.name === 'zombie')
          if (zombie === undefined) {
            await send('/kill @e[type=minecraft:zombie,tag=p2shoot]')
            await send(`/summon minecraft:zombie ${centerX + 0.5} ${y + 1} ${z + 0.5} {Tags:["p2shoot"],PersistenceRequired:1b,Silent:1b}`)
            await sleep(700)
            zombie = body.entities({
              min: { x: bx1 - 1, y: y, z: bz1 - 1 },
              max: { x: bx2 + 1, y: y + 3, z: bz2 + 1 },
            }).find(entity => entity.name === 'zombie')
          }
          if (zombie === undefined) {
            trials.push({ index, state: 'failed', code: 'NO_TARGET', hit: false, shots: 0, targetDistance: gap })
            continue
          }
          const self = body.self().pos
          const distance = Math.hypot(zombie.position.x - self.x, zombie.position.z - self.z)
          const handle = createShootDriver().start({
            driverId: 'shoot',
            params: {
              entityId: zombie.id,
              targetName: 'zombie',
              weapon: 'bow',
              maxShots: 1,
              maxRange: 30,
            },
            runId: `live-ai-${gap}-${index}`,
            issuedAt: Date.now(),
            budget: { maxTicks: 400, maxWallMs: 20_000 },
          } as unknown as Job, { body } as unknown as DriverCtx)
          for (let tick = 0; tick < 400 && handle.result().state === 'running'; tick += 1) {
            handle.tick()
            await sleep(25)
          }
          const result = handle.result()
          const observed = result.observed as { shots?: unknown[] } | undefined
          trials.push({
            index,
            state: result.state,
            ...(result.code === undefined ? {} : { code: result.code }),
            hit: result.state === 'succeeded',
            shots: observed?.shots?.length ?? 0,
            targetDistance: Math.round(distance * 10) / 10,
            observed: result.observed,
          })
          await sleep(250)
        }
        const hits = trials.filter(trial => trial.hit).length
        const misses = trials.filter(trial => trial.code === 'SHOOT_MISSED').length
        const inconclusive = trials.filter(trial => trial.code === 'SHOOT_INCONCLUSIVE').length
        const fatal = trials.length - hits - misses - inconclusive
        reports.push({
          gap,
          trials,
          hits,
          misses,
          inconclusive,
          fatal,
          hitRate: trials.length === 0 ? 0 : Math.round((hits / trials.length) * 1000) / 1000,
        })
      }
      console.log('AI_SHOOT_REPORT', JSON.stringify(reports, null, 2))
      expect(reports).toHaveLength(2)
      expect(reports.every(report => report.trials.length === TRIALS)).toBe(true)
    } finally {
      try { await send('/kill @e[type=minecraft:zombie,tag=p2shoot]') } catch {}
      try { await send('/kill @e[type=minecraft:villager,tag=p2shoot]') } catch {}
      try {
        await send(`/fill ${arena.x - 5} ${arena.y} ${arena.z - 15} `
          + `${arena.x + 50} ${arena.y + 8} ${arena.z + 15} minecraft:air`)
      } catch {}
      try { await send(`/tp ${USERNAME} ${origin.x} ${origin.y} ${origin.z}`) } catch {}
      try { await send('/time set day') } catch {}
      try { await send('/gamerule doDaylightCycle true') } catch {}
      try { body.endWrite({ runId: 'live-ai-shoot', jobId: 'live-ai-shoot', seq: 1 }) } catch {}
      try { bot.quit('live ai shoot done') } catch {}
    }
  }, 180_000)
})

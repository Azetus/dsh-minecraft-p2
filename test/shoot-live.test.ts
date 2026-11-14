import { describe, expect, it } from 'vitest'

import { connectMineflayer, MineflayerProvider } from '../src/provider/mineflayer.ts'
import { MineflayerBody } from '../src/provider/body.ts'
import { createShootDriver } from '../src/mind/drivers/shoot.ts'
import type { DriverCtx, Job } from '../src/mind/types.ts'

const LIVE = process.env.P2_SHOOT_LIVE === '1'
const HOST = process.env.P2_MC_HOST ?? '127.0.0.1'
const PORT = Number(process.env.P2_MC_PORT ?? 25575)
const USERNAME = process.env.P2_MC_USERNAME ?? 'P2_Bot'
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Category: live access consistency (opt-in).
 *   P2_SHOOT_LIVE=1 npx vitest run test/shoot-live.test.ts --pool=threads
 * Requires an operator bot, a clear +x lane, and permission to summon/kill.
 */
describe.skipIf(!LIVE)('live shoot', () => {
  it('hits a summoned NoAI zombie with a bow', async () => {
    const bot = await connectMineflayer({ host: HOST, port: PORT, username: USERNAME, timeoutMs: 20_000 })
    const provider = new MineflayerProvider(bot, { serverIdleMs: 1_500, providerVersion: 'live-shoot' })
    const body = new MineflayerBody(bot, provider, { worldId: 'live-shoot' })
    try {
      await sleep(500)
      body.beginWrite({ runId: 'live-shoot', jobId: 'live-shoot', seq: 1 })
      bot.chat(`/give ${USERNAME} bow 1`)
      bot.chat(`/give ${USERNAME} arrow 16`)
      await sleep(700)
      const bow = body.inventory().find(item => item.name === 'bow')
      expect(bow).toBeDefined()
      expect((await body.equip('bow')).state).toBe('ok')
      bot.chat(`/summon minecraft:zombie ~8 ~ ~ {NoAI:1b,Silent:1b,Persistent:1b}`)
      await sleep(500)
      const self = body.self().pos
      const zombie = body.entities({
        min: { x: self.x, y: self.y - 2, z: self.z - 6 },
        max: { x: self.x + 16, y: self.y + 4, z: self.z + 6 },
      }).find(entity => entity.name === 'zombie')
      expect(zombie).toBeDefined()
      if (zombie === undefined) return
      const handle = createShootDriver().start({
        driverId: 'shoot',
        params: {
          entityId: zombie.id,
          targetName: 'zombie',
          weapon: 'bow',
          maxShots: 1,
          maxRange: 16,
        },
        runId: 'live-shoot',
        issuedAt: Date.now(),
        budget: { maxTicks: 400, maxWallMs: 20_000 },
      } as unknown as Job, { body } as unknown as DriverCtx)
      for (let index = 0; index < 400 && handle.result().state === 'running'; index += 1) {
        handle.tick()
        await sleep(25)
      }
      console.log('live-shoot-result', JSON.stringify(handle.result()))
      expect(handle.result().state).toBe('succeeded')
      expect(handle.result().observed).toMatchObject({ kind: 'shoot', hit: true })
    } finally {
      try { body.endWrite({ runId: 'live-shoot', jobId: 'live-shoot', seq: 1 }) } catch {}
      try { bot.chat('/kill @e[type=minecraft:zombie,limit=1,sort=nearest]') } catch {}
      try { bot.quit('live shoot done') } catch {}
    }
  })
})

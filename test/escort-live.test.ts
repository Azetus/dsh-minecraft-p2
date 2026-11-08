import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createMind } from '../src/body/mind.ts'
import { MineflayerProvider, connectMineflayer } from '../src/provider/mineflayer.ts'
import { MineflayerClientPort } from '../src/port/mineflayer/index.ts'

/**
 * Opt-in live escort probe. It connects a throwaway bot to a real server and
 * checks the focus/escort wiring end to end:
 *
 *   P2_ESCORT_LIVE=1 npx vitest run test/escort-live.test.ts
 *
 * Defaults: 127.0.0.1:25575, P2_Probe, protocol version 26.1. Override with
 * P2_MC_HOST/P2_MC_PORT/P2_MC_VERSION/P2_MC_USERNAME/P2_ESCORT_TARGET.
 */

const LIVE = process.env.P2_ESCORT_LIVE === '1'
const HOST = process.env.P2_MC_HOST ?? '127.0.0.1'
const PORT = Number(process.env.P2_MC_PORT ?? 25575)
const VERSION = process.env.P2_MC_VERSION ?? '26.1'
const USERNAME = process.env.P2_MC_USERNAME ?? 'P2_Probe'
const EXPLICIT_TARGET = process.env.P2_ESCORT_TARGET

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe.skipIf(!LIVE)('live escort focus', () => {
  it('follows a known target resolved by name without a waiting flap', async () => {
    const bot = await connectMineflayer({
      host: HOST,
      port: PORT,
      username: USERNAME,
      version: VERSION,
      timeoutMs: 20_000,
    })
    const provider = new MineflayerProvider(bot, { serverIdleMs: 1500, providerVersion: 'escort-live' })
    const port = new MineflayerClientPort(bot, provider, { pollIntervalMs: 50 })
    const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-escort-live-'))
    try {
      await sleep(1_500)
      const players = Object.keys(bot.players).filter(name => name !== bot.username)
      const entityName = (Object.values(bot.entities) as Array<{ name?: string; username?: string }>)
        .map(entity => entity.username ?? entity.name)
        .find(name => name !== undefined && name !== bot.username)
      const target = EXPLICIT_TARGET ?? players[0] ?? entityName
      expect(target, 'no player or named entity to escort').toBeTruthy()

      const feet = port.self().pos
      const mind = createMind({
        port,
        home: { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) },
        baseActivity: { kind: 'escort', target: target!, distance: 3 },
        plansDir: join(process.cwd(), 'content', 'plans'),
        journalPath: join(dir, 'journal.jsonl'),
      })

      const start = port.self().pos
      let tracked = 0
      let recovered = 0
      let reacquired = 0
      let lastDistance: number | undefined
      let lostAt = -1
      let finalState: string | undefined
      const seenStates = new Set<string>()
      for (let index = 0; index < 900; index += 1) {
        mind.tick()
        const status = mind.status()
        const focus = status.focus
        if (focus !== undefined && focus !== null) {
          seenStates.add(focus.state)
          finalState = focus.state
          if (focus.state === 'tracked') {
            tracked += 1
            if (lostAt >= 0) reacquired += 1
            lostAt = -1
            lastDistance = focus.distance
          } else if (lostAt < 0) {
            lostAt = index
          }
        }
        await sleep(50)
      }
      const waitingEvents: Array<{ kind: string; at?: number }> = []
      for (const event of mind.sinceEvents(0, 1_000).events) {
        if (event.kind === 'base.waiting') waitingEvents.push(event)
        if (event.kind === 'base.recovered') recovered += 1
      }
      const waiting = waitingEvents.length
      let minGapMs = Number.POSITIVE_INFINITY
      for (let index = 1; index < waitingEvents.length; index += 1) {
        const previous = waitingEvents[index - 1]?.at
        const current = waitingEvents[index]?.at
        if (typeof previous === 'number' && typeof current === 'number') {
          minGapMs = Math.min(minGapMs, current - previous)
        }
      }

      const end = port.self().pos
      const moved = Math.hypot(end.x - start.x, end.z - start.z)
      const targetEntity = port.entityByName?.(target!)
      const finalDistance = targetEntity === undefined
        ? undefined
        : Math.hypot(targetEntity.position.x - end.x, targetEntity.position.z - end.z)
      console.log('escort-live', JSON.stringify({
        target,
        tracked,
        waiting,
        recovered,
        reacquired,
        states: [...seenStates],
        finalState,
        lastDistance,
        finalDistance,
        minGapMs: Number.isFinite(minGapMs) ? minGapMs : null,
        moved,
        start: { x: start.x, y: start.y, z: start.z },
        end: { x: end.x, y: end.y, z: end.z },
      }))

      expect(tracked).toBeGreaterThan(0)
      // A moving target may really leave and re-enter tracking a few times;
      // what must not happen is the old ~1 Hz waiting/recovered flap.
      expect(waiting).toBeLessThanOrEqual(3)
      if (Number.isFinite(minGapMs)) expect(minGapMs).toBeGreaterThan(3_000)
      if (finalState !== undefined && finalState !== 'tracked' && lostAt >= 0
        && (900 - lostAt) * 50 >= 4_000) {
        expect(waiting).toBeGreaterThanOrEqual(1)
      }
      if (lastDistance !== undefined && lastDistance > 8) {
        expect(moved).toBeGreaterThan(0.5)
      }
    } finally {
      try {
        bot.quit('escort live probe done')
      } catch {
        // The connection may already be gone.
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)
})

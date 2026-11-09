import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'

import { createMind } from '../src/body/mind.ts'
import { MineflayerProvider, connectMineflayer } from '../src/provider/mineflayer.ts'
import { MineflayerBody } from '../src/provider/index.ts'
import type { MindEvent } from '../src/mind/events.ts'

/**
 * Opt-in live loss/recovery probe with two bots. The escort bot follows a
 * target bot by username; the target disconnects (focus -> offline), then
 * reconnects (focus -> tracked). This covers the 2 s grace, exactly one
 * TARGET_LOST and exactly one recovery without needing a human in the world.
 *
 *   P2_ESCORT_LIVE=1 npx vitest run test/escort-live-loss.test.ts
 *
 * Defaults: 127.0.0.1:25575, protocol 26.1, escort `P2_Probe`, target `P2_Target`.
 */

const LIVE = process.env.P2_ESCORT_LIVE === '1'
const HOST = process.env.P2_MC_HOST ?? '127.0.0.1'
const PORT = Number(process.env.P2_MC_PORT ?? 25575)
const VERSION = process.env.P2_MC_VERSION ?? '26.1'
const ESCORT_USER = process.env.P2_MC_USERNAME ?? 'P2_Probe'
const TARGET_USER = process.env.P2_ESCORT_TARGET ?? 'P2_Target'

const GRACE_MS = 2_000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

type LiveBot = { bot: Bot; provider: MineflayerProvider; port: MineflayerBody }

async function connect(username: string): Promise<LiveBot> {
  const bot = await connectMineflayer({
    host: HOST,
    port: PORT,
    username,
    version: VERSION,
    timeoutMs: 20_000,
  })
  const provider = new MineflayerProvider(bot, { serverIdleMs: 1500, providerVersion: 'escort-live-loss' })
  const port = new MineflayerBody(bot, provider, { pollIntervalMs: 50 })
  await sleep(1_500)
  return { bot, provider, port }
}

async function quit(bot: Bot): Promise<void> {
  try {
    bot.quit('escort live loss probe')
  } catch {
    return
  }
  await new Promise<void>(resolve => {
    bot.once('end', () => resolve())
    setTimeout(resolve, 5_000)
  })
}

describe.skipIf(!LIVE)('live escort loss and recovery', () => {
  it('reports exactly one TARGET_LOST and one recovery across a target reconnect', async () => {
    let target: LiveBot | undefined
    let escort: LiveBot | undefined
    const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-escort-loss-'))
    try {
      target = await connect(TARGET_USER)
      escort = await connect(ESCORT_USER)
      const players = Object.keys(escort.bot.players)
      expect(players).toContain(TARGET_USER)

      const feet = escort.port.self().pos
      const mind = createMind({
        body: escort.port,
        home: { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) },
        baseActivity: { kind: 'escort', target: TARGET_USER, distance: 3 },
        plansDir: join(process.cwd(), 'content', 'plans'),
        journalPath: join(dir, 'journal.jsonl'),
      })

      let cursor = 0
      const seen: MindEvent[] = []
      const drain = (): MindEvent[] => {
        const result = mind.sinceEvents(cursor, 1_000)
        cursor = result.seq
        seen.push(...result.events)
        return result.events
      }
      const tickFor = async (ms: number): Promise<void> => {
        const until = Date.now() + ms
        while (Date.now() < until) {
          mind.tick()
          await sleep(50)
        }
      }
      const waitForFocus = async (predicate: (state: string | undefined) => boolean, timeoutMs: number): Promise<string | undefined> => {
        const until = Date.now() + timeoutMs
        while (Date.now() < until) {
          mind.tick()
          const state = mind.status().focus?.state
          if (predicate(state)) return state
          await sleep(50)
        }
        return mind.status().focus?.state
      }

      // Phase A: the target is tracked and the escort keeps a live focus.
      await tickFor(2_500)
      const initial = mind.status().focus
      expect(initial?.state).toBe('tracked')
      expect(initial?.distance).toBeTypeOf('number')

      // Phase B: the target disconnects; focus becomes offline and exactly one
      // TARGET_LOST is emitted after the 2 s grace.
      await quit(target.bot)
      const disconnectAt = Date.now()
      const offline = await waitForFocus(state => state === 'offline', 25_000)
      expect(offline).toBe('offline')
      const lostDeadline = Date.now() + 10_000
      while (!seen.some(event => event.kind === 'base.waiting') && Date.now() < lostDeadline) {
        await tickFor(200)
        drain()
      }
      const lostEvents = seen.filter(event => event.kind === 'base.waiting')
      expect(lostEvents).toHaveLength(1)
      const lostAt = lostEvents[0]?.at ?? 0
      // The grace window starts at the last successful resolution, which is up
      // to one tick (plus the quit round-trip) before `disconnectAt`.
      expect(lostAt - disconnectAt).toBeGreaterThanOrEqual(GRACE_MS - 800)
      expect(lostAt - disconnectAt).toBeLessThanOrEqual(10_000)
      expect(mind.status().baseActivity?.waitingReason).toBe('TARGET_LOST')

      // Phase C: the target reconnects; focus is tracked again and exactly one
      // recovery is emitted, with no extra waiting.
      target = await connect(TARGET_USER)
      const tracked = await waitForFocus(state => state === 'tracked', 25_000)
      expect(tracked).toBe('tracked')
      await tickFor(2_000)
      drain()
      expect(seen.filter(event => event.kind === 'base.recovered')).toHaveLength(1)
      expect(seen.filter(event => event.kind === 'base.waiting')).toHaveLength(1)
      expect(mind.status().baseActivity?.waitingReason).toBeNull()
      expect(mind.status().focus?.state).toBe('tracked')

      console.log('escort-live-loss', JSON.stringify({
        target: TARGET_USER,
        initial,
        offline,
        lostAt,
        lostAfterMs: lostAt - disconnectAt,
        tracked,
        waiting: mind.status().focus?.state === 'tracked'
          ? 'recovered'
          : mind.status().focus?.state,
      }))
    } finally {
      if (target !== undefined) await quit(target.bot)
      if (escort !== undefined) await quit(escort.bot)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

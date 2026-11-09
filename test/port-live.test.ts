import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'

import { MineflayerProvider, connectMineflayer } from '../src/provider/mineflayer.ts'
import { MineflayerBody } from '../src/provider/index.ts'
import type { ActResult, Vec3 } from '../src/body/api.ts'
import { writeToken } from './helpers/mineflayer-fakes.ts'

/**
 * Category: access consistency, live run (TODO M0-04).
 * Runs the ten BodyApi scenarios against the dev server. It is opt-in so
 * `npm run check` never depends on a game:
 *
 *   P2_PORT_LIVE=1 npx vitest run test/port-live.test.ts --pool=threads
 *
 * Defaults: 127.0.0.1:25566, P2_Bot, 1.21.1 (override with P2_MC_HOST/P2_MC_PORT).
 */

const LIVE = process.env.P2_PORT_LIVE === '1'
const HOST = process.env.P2_MC_HOST ?? '127.0.0.1'
const PORT = Number(process.env.P2_MC_PORT ?? 25566)
const USERNAME = process.env.P2_MC_USERNAME ?? 'P2_Bot'

type Connection = { bot: Bot; provider: MineflayerProvider; port: MineflayerBody }

type StepResult = { name: string; ok: boolean; detail: unknown }

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const isAir = (name: string): boolean => name === 'air' || name === 'cave_air' || name === 'void_air'
const isFluid = (name: string): boolean => name === 'water' || name === 'lava'

const PLACEABLE = [
  'acacia_log', 'oak_log', 'birch_log', 'spruce_log', 'dark_oak_log',
  'dirt', 'grass_block', 'sand', 'gravel', 'stone', 'cobblestone',
]

const DIGGABLE = [...PLACEABLE]

async function connect(): Promise<Connection> {
  const bot = await connectMineflayer({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: '1.21.1',
    timeoutMs: 20_000,
  })
  const provider = new MineflayerProvider(bot, { serverIdleMs: 1500, providerVersion: 'live-probe' })
  const port = new MineflayerBody(bot, provider, { pollIntervalMs: 50 })
  return { bot, provider, port }
}

function feet(port: MineflayerBody): Vec3 {
  const pos = port.self().pos
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
}

function clearStand(port: MineflayerBody, p: Vec3): boolean {
  const feetBlock = port.blockAt(p)
  const headBlock = port.blockAt({ x: p.x, y: p.y + 1, z: p.z })
  const below = port.blockAt({ x: p.x, y: p.y - 1, z: p.z })
  return feetBlock?.loaded === true
    && isAir(feetBlock.name)
    && headBlock?.loaded === true
    && isAir(headBlock.name)
    && below !== null
    && below.loaded
    && !isAir(below.name)
    && !isFluid(below.name)
}

function walkTargets(port: MineflayerBody): Vec3[] {
  const start = feet(port)
  const directions: Array<[number, number]> = [
    [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
  ]
  const targets: Vec3[] = []
  for (const distance of [5, 4]) {
    for (const [dx, dz] of directions) {
      for (const dy of [0, -1, 1]) {
        const candidate = { x: start.x + dx * distance, y: start.y + dy, z: start.z + dz * distance }
        if (!clearStand(port, candidate)) continue
        if (targets.some(existing => existing.x === candidate.x && existing.y === candidate.y && existing.z === candidate.z)) continue
        targets.push(candidate)
      }
    }
  }
  return targets.slice(0, 4)
}

function horizontalDistance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.z - right.z)
}

async function waitIdle(provider: MineflayerProvider, timeoutMs = 3_000): Promise<number> {
  const startedAt = Date.now()
  while (provider.controlState() !== 'idle') {
    if (Date.now() - startedAt > timeoutMs) return Date.now() - startedAt
    await sleep(50)
  }
  return Date.now() - startedAt
}

/** Position of the nearest dropped item stack (metadata slot 8), if any. */
function itemDrop(bot: Bot, near: Vec3): Vec3 | undefined {
  let best: { distance: number; position: Vec3 } | undefined
  for (const entity of Object.values(bot.entities) as Array<{
    position?: { x: number; y: number; z: number }
    metadata?: Record<number, unknown>
  }>) {
    const stack = entity.metadata?.[8] as { itemId?: unknown } | undefined
    if (stack === undefined || typeof stack.itemId !== 'number') continue
    if (entity.position === undefined) continue
    const position = { x: entity.position.x, y: entity.position.y, z: entity.position.z }
    const distance = Math.hypot(position.x - near.x, position.y - near.y, position.z - near.z)
    if (best === undefined || distance < best.distance) best = { distance, position }
  }
  return best?.position
}

function placeableItem(port: MineflayerBody): string | undefined {
  return port.inventory().find(entry => PLACEABLE.includes(entry.name))?.name
}

describe.skipIf(!LIVE)('live mineflayer port', () => {
  it('runs the ten consistency scenarios against the dev server', async () => {
    const results: StepResult[] = []
    const record = (name: string, ok: boolean, detail: unknown): void => {
      results.push({ name, ok, detail })
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`)
    }

    let connection: Connection | undefined
    try {
      connection = await connect()
      const { bot, provider } = connection
      let { port } = connection
      await sleep(1500)
      port.beginWrite(writeToken(1))

      // 1. Read self and inventory.
      const self = port.self()
      record('1 self/inventory', self.health > 0 && Array.isArray(port.inventory()), {
        self,
        inventory: port.inventory(),
      })

      // 2. Walk five blocks (try clear columns first, then straight fallbacks).
      const start = port.self().pos
      const walkCandidates = walkTargets(port)
      if (walkCandidates.length === 0) {
        const s = feet(port)
        walkCandidates.push(
          { x: s.x + 5, y: s.y, z: s.z },
          { x: s.x - 5, y: s.y, z: s.z },
          { x: s.x, y: s.y, z: s.z + 5 },
          { x: s.x, y: s.y, z: s.z - 5 },
        )
      }
      let walked: { target: Vec3; result: ActResult; moved: number } | undefined
      for (const target of walkCandidates.slice(0, 6)) {
        const result = await port.moveTo(target, { range: 1, timeoutMs: 8_000 })
        await waitIdle(provider, 2_000)
        const moved = horizontalDistance(start, port.self().pos)
        if (result.state === 'ok' && moved > 2.5) {
          walked = { target, result, moved }
          break
        }
        walked = { target, result, moved }
      }
      record('2 walk five blocks', walked?.result.state === 'ok' && walked.moved > 2.5, walked)

      // 3. Dig one reachable block whose drop can land on solid ground.
      const base = feet(port)
      const candidates = port.blocksIn(
        { min: { x: base.x - 3, y: base.y - 3, z: base.z - 3 }, max: { x: base.x + 3, y: base.y + 1, z: base.z + 3 } },
        DIGGABLE,
      ).filter(block => {
        if (block.loaded !== true || block.pos === undefined) return false
        const below = port.blockAt({ x: block.pos.x, y: block.pos.y - 1, z: block.pos.z })
        return below !== null && below.loaded && !isAir(below.name) && !isFluid(below.name)
      }).sort((left, right) => {
        const a = left.pos as Vec3
        const b = right.pos as Vec3
        return Math.hypot(a.x - base.x, a.y - base.y, a.z - base.z) - Math.hypot(b.x - base.x, b.y - base.y, b.z - base.z)
      }).slice(0, 4)

      let dug: { at: Vec3; result: ActResult; after: string | null } | undefined
      for (const candidate of candidates) {
        const at = candidate.pos as Vec3
        const result = await port.dig(at)
        await waitIdle(provider, 2_000)
        if (result.state !== 'ok') {
          dug = { at, result, after: null }
          continue
        }
        let after = port.blockAt(at)?.name ?? null
        for (let attempt = 0; attempt < 20 && (after === null || after === candidate.name); attempt += 1) {
          await sleep(100)
          after = port.blockAt(at)?.name ?? null
        }
        dug = { at, result, after }
        if (after !== candidate.name) break
      }
      record('3 dig one block', dug?.result.state === 'ok' && dug.after !== null, dug)

      // Walk to the drop so the item is collected; placing needs it in the bag.
      let item = placeableItem(port)
      for (let attempt = 0; attempt < 20 && item === undefined; attempt += 1) {
        await sleep(100)
        item = placeableItem(port)
      }
      if (item === undefined && dug !== undefined) {
        const drop = itemDrop(bot, dug.at)
        if (drop !== undefined) {
          await port.moveTo({ x: drop.x, y: drop.y, z: drop.z }, { range: 1, timeoutMs: 8_000 })
        } else {
          await port.moveTo({ x: dug.at.x + 0.5, y: dug.at.y, z: dug.at.z + 0.5 }, { range: 1, timeoutMs: 8_000 })
        }
        await waitIdle(provider, 2_000)
        for (let attempt = 0; attempt < 30 && item === undefined; attempt += 1) {
          await sleep(100)
          item = placeableItem(port)
        }
      }

      // 4. Place one block on a solid neighbour column.
      let placed: { at: Vec3; item: string; result: ActResult; after: string | null } | undefined
      let placeCandidates = 0
      if (item !== undefined) {
        const body = feet(port)
        const targets: Vec3[] = []
        for (let dx = -2; dx <= 2; dx += 1) {
          for (let dz = -2; dz <= 2; dz += 1) {
            for (const dy of [0, -1, 1]) {
              if (dx === 0 && dz === 0 && (dy === 0 || dy === 1)) continue
              targets.push({ x: body.x + dx, y: body.y + dy, z: body.z + dz })
            }
          }
        }
        const usable = targets.filter(at => {
          const target = port.blockAt(at)
          const below = port.blockAt({ x: at.x, y: at.y - 1, z: at.z })
          return target?.loaded === true
            && isAir(target.name)
            && below !== null
            && below.loaded
            && !isAir(below.name)
            && !isFluid(below.name)
            && Math.hypot(at.x - body.x, at.y - body.y, at.z - body.z) <= 4
        })
        placeCandidates = usable.length
        for (const at of usable.slice(0, 8)) {
          const result = await port.place(at, 'up', item)
          let after = port.blockAt(at)?.name ?? null
          for (let attempt = 0; attempt < 20 && after !== item; attempt += 1) {
            await sleep(100)
            after = port.blockAt(at)?.name ?? null
          }
          placed = { at, item, result, after }
          if (result.state === 'ok' && after === item) break
        }
      }
      record(
        '4 place one block',
        placed?.result.state === 'ok' && placed.after === placed.item,
        placed ?? { item, placeCandidates },
      )

      // 5. Timeout is unknown, not failed.
      const far = port.self().pos
      const timeout = await port.moveTo({ x: far.x + 30, y: far.y, z: far.z }, { timeoutMs: 1 })
      const idleAfterTimeoutMs = await waitIdle(provider, 10_000)
      record(
        '5 timeout unknown',
        timeout.state === 'unknown' && timeout.code === 'CLIENT_TIMEOUT',
        { result: timeout, idleAfterTimeoutMs, controlState: provider.controlState() },
      )

      // 6. Cancelled run sends no writes for the following second.
      await waitIdle(provider, 5_000)
      port.beginWrite(writeToken(2))
      const cancelledRun = port.moveTo({ x: far.x + 40, y: far.y, z: far.z }, { timeoutMs: 20_000 })
      await sleep(300)
      port.endWrite(writeToken(2))
      const cancelled = await cancelledRun
      const atCancel = port.self().pos
      const releaseMs = await waitIdle(provider, 2_000)
      await sleep(1_000)
      const afterCancel = port.self().pos
      record(
        '6 cancel writes stop',
        cancelled.code === 'STALE_WRITE' && releaseMs < 2_000 && horizontalDistance(atCancel, afterCancel) < 0.5,
        { cancelled, releaseMs, drift: horizontalDistance(atCancel, afterCancel) },
      )

      // 7. Expired token rejected.
      port.beginWrite(writeToken(4))
      let staleCode: string | undefined
      try {
        port.beginWrite(writeToken(3))
      } catch (error) {
        staleCode = (error as { code?: string }).code
      }
      record('7 expired token rejected', staleCode === 'STALE_WRITE', { staleCode })

      // 8. Unknown / air target is a failure, not a silent success.
      const above = feet(port)
      const air = port.blockAt({ x: above.x, y: above.y + 2, z: above.z })
      const unknownDig = await port.dig({ x: above.x, y: above.y + 2, z: above.z })
      record('8 unknown block', air !== null && isAir(air.name) && unknownDig.state === 'failed', {
        air: air?.name ?? null,
        result: unknownDig,
      })

      // 9. Unloaded chunk is unknown, never air.
      const unloaded = port.blockAt({ x: above.x + 100_000, y: above.y, z: above.z })
      record('9 unloaded chunk', unloaded === null, { unloaded })

      // 10. Reconnect with a fresh connection and act again.
      bot.quit('live probe reconnect')
      await new Promise<void>(resolve => {
        bot.once('end', () => resolve())
        setTimeout(resolve, 5_000)
      })
      connection = await connect()
      port = connection.port
      await sleep(1500)
      port.beginWrite(writeToken(1))
      const reconnectedSelf = port.self()
      const look = await port.lookAt(reconnectedSelf.pos)
      record('10 reconnect', reconnectedSelf.health > 0 && look.state === 'ok', {
        health: reconnectedSelf.health,
        look,
      })
    } finally {
      try {
        connection?.bot.quit('live probe done')
      } catch {
        // The connection may already be gone.
      }
    }

    const failures = results.filter(result => !result.ok)
    expect(failures, JSON.stringify(results, null, 2)).toEqual([])
    expect(results).toHaveLength(10)
  }, 180_000)
})

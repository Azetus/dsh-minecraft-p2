import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'

import type { MineflayerPortOptions } from '../src/port/mineflayer/index.ts'
import { MineflayerClientPort } from '../src/port/mineflayer/index.ts'
import { FakeActSource, FakeBot, writeToken } from './helpers/mineflayer-fakes.ts'

/**
 * Category: access consistency (TODO M0-04, AGENT §5.1).
 * Protects: the ten contract behaviours every ClientPort adapter must show.
 * The fake provider supplies only the inputs the contract defines; these are
 * adapter conformance checks, not game acceptance.
 */

function createPort(
  source = new FakeActSource(),
  bot = new FakeBot(),
  options: MineflayerPortOptions = {},
): { port: MineflayerClientPort; bot: FakeBot; source: FakeActSource } {
  const port = new MineflayerClientPort(bot as unknown as Bot, source, {
    pollIntervalMs: 2,
    now: () => Date.now(),
    ...options,
  })
  port.beginWrite(writeToken(1))
  return { port, bot, source }
}

describe('ClientPort adapter consistency A', () => {
  it('1. reads self and inventory as pure data', () => {
    const { port } = createPort()
    expect(port.self()).toMatchObject({ health: 20, food: 18, pos: { x: 0, y: 64, z: 0 } })
    expect(port.inventory()).toEqual([{ slot: 36, name: 'dirt', count: 3 }])
  })

  it('2. walks five blocks through a navigate request', async () => {
    const { port, source } = createPort()
    const result = await port.moveTo({ x: 5, y: 64, z: 0 }, { range: 1, timeoutMs: 2_000 })
    expect(result.state).toBe('ok')
    expect(source.calls.at(-1)).toEqual({
      name: 'goto',
      args: { x: 5, y: 64, z: 0, range: 1, timeoutMs: 2_000 },
    })
  })

  it('3. digs one block', async () => {
    const { port, source } = createPort()
    const result = await port.dig({ x: 1, y: 64, z: 0 })
    expect(result.state).toBe('ok')
    expect(source.calls.at(-1)).toEqual({ name: 'dig', args: { x: 1, y: 64, z: 0 } })
  })

  it('4. places one block with the requested item', async () => {
    const { port, source, bot } = createPort()
    bot.heldItem = { name: 'dirt', count: 3 }
    const result = await port.place({ x: 1, y: 64, z: 0 }, 'up', 'dirt')
    expect(result.state).toBe('ok')
    expect(source.calls.at(-1)).toEqual({
      name: 'place',
      args: { x: 1, y: 64, z: 0, face: 'up', item: 'dirt' },
    })
  })

  it('5. reports a timeout as unknown, not failed', async () => {
    const source = new FakeActSource()
    const { port } = createPort(source, new FakeBot(), { timeouts: { dig: 20 } })
    source.mode = 'running'
    const result = await port.dig({ x: 1, y: 64, z: 0 })
    expect(result).toMatchObject({ state: 'unknown', code: 'CLIENT_TIMEOUT' })
  })

  it('6. sends no writes from the cancelled run in the following second', async () => {
    const { port, source } = createPort()
    source.mode = 'running'
    const pending = port.dig({ x: 1, y: 64, z: 0 })
    await new Promise(resolve => setTimeout(resolve, 20))

    port.endWrite(writeToken(1))
    expect(await pending).toMatchObject({ state: 'failed', code: 'STALE_WRITE' })
    const writesAtCancel = source.calls.length

    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(source.calls.length).toBe(writesAtCancel)
    expect(source.handles.at(-1)?.stopped).toBe(true)
  })

  it('7. rejects an expired token and keeps the newer authority', async () => {
    const { port, source } = createPort()
    port.beginWrite(writeToken(2))
    let staleCode: string | undefined
    try {
      port.beginWrite(writeToken(1))
    } catch (error) {
      staleCode = (error as { code?: string }).code
    }
    expect(staleCode).toBe('STALE_WRITE')

    expect((await port.dig({ x: 1, y: 64, z: 0 })).state).toBe('ok')
    expect(source.calls).toHaveLength(1)
  })

  it('8. reports an undiggable block as a failure, and missing blocks as null', async () => {
    const { port, source } = createPort()
    expect(port.blockAt({ x: 4, y: 64, z: 4 })).toBeNull()

    source.mode = 'fail'
    source.failCode = 'DIG_NO_BLOCK'
    const result = await port.dig({ x: 4, y: 64, z: 4 })
    expect(result).toMatchObject({ state: 'failed', code: 'DIG_NO_BLOCK' })
  })

  it('9. keeps unloaded cells unknown instead of folding them into air', () => {
    const { port } = createPort()
    expect(port.blockAt({ x: 10_000, y: 64, z: 10_000 })).toBeNull()
    expect(port.blocksIn({ min: { x: 10_000, y: 64, z: 10_000 }, max: { x: 10_000, y: 64, z: 10_000 } }))
      .toEqual([{ name: '', loaded: false, pos: { x: 10_000, y: 64, z: 10_000 } }])
  })

  it('10. fails actions after a disconnect and works again on a new connection', async () => {
    const disconnected = new FakeActSource()
    disconnected.mode = 'disconnected'
    const first = createPort(disconnected)
    expect(await first.port.dig({ x: 1, y: 64, z: 0 })).toMatchObject({
      state: 'failed',
      code: 'CONNECTION_LOST',
    })

    const reconnected = createPort()
    expect(reconnected.port.self().health).toBe(20)
    expect((await reconnected.port.dig({ x: 1, y: 64, z: 0 })).state).toBe('ok')
  })
})

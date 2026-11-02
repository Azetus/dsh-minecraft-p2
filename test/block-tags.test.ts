/**
 * Non-acceptance / 非验收: the tags packet index. The packet shape is the one
 * `minecraft-protocol` emits; a real 1.21.1 server probe verifies the live tags.
 */
import { EventEmitter } from 'node:events'
import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'

import { attachBlockTags, blockTagsFor } from '../src/port/mineflayer/block-tags.ts'
import { MineflayerClientPort } from '../src/port/mineflayer/client-port.ts'
import { MineflayerMotionWorld } from '../src/motion/mineflayer/world.ts'
import { FakeActSource } from './helpers/mineflayer-fakes.ts'

class FakeBot extends EventEmitter {
  readonly _client = new EventEmitter()
  registry: unknown
  blockAt = (_p: unknown): unknown => null
}

function tagsPacket(tags: Array<{ type?: string; tagName: string; entries: number[] }>): unknown {
  return {
    tags: [{
      tagType: 'minecraft:block',
      tags: tags.map(tag => ({ tagName: tag.tagName, entries: tag.entries, ...(tag.type === undefined ? {} : { type: tag.type }) })),
    }],
  }
}

describe('BlockTagIndex', () => {
  it('stores raw tags before the registry and maps lazily afterwards', () => {
    const bot = new FakeBot()
    const index = attachBlockTags(bot as unknown as Bot)
    expect(index.ready).toBe(false)

    bot._client.emit('tags', tagsPacket([
      { tagName: 'minecraft:wooden_doors', entries: [195, 196] },
      { tagName: 'minecraft:fence_gates', entries: [200] },
    ]))
    expect(index.tagCount).toBe(2)
    expect(index.ready).toBe(false)
    expect(index.tagsFor(195)).toBeUndefined()

    bot.registry = { blocks: { 195: { name: 'oak_door' }, 196: { name: 'spruce_door' }, 200: { name: 'oak_fence_gate' } } }
    expect(index.ready).toBe(true)
    expect(index.blockTagCount).toBe(3)
    expect([...(index.tagsFor(195) ?? [])]).toEqual(['minecraft:wooden_doors'])
    expect([...(index.tagsFor(200) ?? [])]).toEqual(['minecraft:fence_gates'])
    expect(index.tagsFor(999)?.size).toBe(0)
  })

  it('ignores non-block tag groups and malformed packets', () => {
    const bot = new FakeBot()
    const index = attachBlockTags(bot as unknown as Bot)
    bot._client.emit('tags', {
      tags: [
        { tagType: 'minecraft:item', tags: [{ tagName: 'minecraft:doors', entries: [195] }] },
        { tagType: 'minecraft:block', tags: [{ tagName: 'minecraft:climbable', entries: [300] }] },
      ],
    })
    expect(index.tagCount).toBe(1)
    bot.registry = { blocks: { 300: { name: 'ladder' } } }
    expect(index.ready).toBe(true)
    expect([...(index.tagsFor(300) ?? [])]).toEqual(['minecraft:climbable'])

    bot._client.emit('tags', { nope: true })
    expect(index.lastError).toContain('tags')
  })

  it('shares one index per bot and resets on demand', () => {
    const bot = new FakeBot()
    const first = attachBlockTags(bot as unknown as Bot)
    expect(blockTagsFor(bot as unknown as Bot)).toBe(first)
    bot.registry = { blocks: { 195: { name: 'oak_door' } } }
    bot._client.emit('tags', tagsPacket([{ tagName: 'minecraft:wooden_doors', entries: [195] }]))
    expect(first.ready).toBe(true)
    first.reset()
    expect(first.ready).toBe(false)
    expect(first.tagCount).toBe(0)
  })

  it('exposes server tags on the motion world block view', () => {
    const bot = new FakeBot()
    bot.registry = { blocks: { 195: { name: 'oak_door' } } }
    bot.blockAt = () => ({
      type: 195,
      name: 'oak_door',
      shapes: [],
      getProperties: () => ({ open: 'false', half: 'lower' }),
    })
    attachBlockTags(bot as unknown as Bot)
    bot._client.emit('tags', tagsPacket([{ tagName: 'minecraft:wooden_doors', entries: [195] }]))
    const world = new MineflayerMotionWorld(bot as unknown as Bot)
    const block = world.blockAt({ x: 0, y: 64, z: 0 })
    expect(block?.serverTags?.has('minecraft:wooden_doors')).toBe(true)
  })

  it('carries server tags through the ClientPort boundary', () => {
    const bot = new FakeBot()
    bot.registry = { blocks: { 195: { name: 'oak_door' } } }
    bot.blockAt = () => ({
      type: 195,
      name: 'oak_door',
      shapes: [],
      getProperties: () => ({ open: 'false', half: 'lower' }),
    })
    attachBlockTags(bot as unknown as Bot)
    bot._client.emit('tags', tagsPacket([{ tagName: 'minecraft:wooden_doors', entries: [195] }]))
    const port = new MineflayerClientPort(bot as unknown as Bot, new FakeActSource())
    const block = port.blockAt({ x: 0, y: 64, z: 0 })
    expect(block?.serverTags?.has('minecraft:wooden_doors')).toBe(true)
  })
})

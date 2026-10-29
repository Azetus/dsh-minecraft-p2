import { describe, expect, it } from 'vitest'

import { summarizeEntities, summarizeInventory } from '../src/bridge/summaries.ts'

// 类别：数据完整性
// 保护对象：ARCHITECTURE §2.2（摘要纯函数：相同输入相同输出、不读取游戏、不保存历史）
//           O1 验收（inventory 计数与实体摘要由 bridge 纯函数生成）。
// 失败模式：摘要引入 provider 语义、对畸形行抛错或把未知折成 0 之外的假值。

describe('observation summaries', () => {
  it('summarizes inventory counts purely', () => {
    const summary = summarizeInventory([
      { name: 'oak_log', count: 3 },
      { name: 'oak_log', count: 2 },
      { name: 'bread', count: 4 },
    ])
    expect(summary).toEqual({
      items: [
        { name: 'oak_log', count: 3 },
        { name: 'oak_log', count: 2 },
        { name: 'bread', count: 4 },
      ],
      total: 9,
      distinct: 2,
      byName: { oak_log: 5, bread: 4 },
    })
    expect(summarizeInventory(null)).toEqual({ items: [], total: 0, distinct: 0, byName: {} })
  })

  it('summarizes entity hostility and nearest distance', () => {
    const summary = summarizeEntities([
      { id: 1, name: 'zombie', kind: 'Hostile mobs', distance: 7 },
      { id: 2, name: 'cow', kind: 'Passive mobs', distance: 2 },
      { id: 3, name: 'skeleton', kind: 'Hostile mobs', distance: 4 },
    ])
    expect(summary).toEqual({ count: 3, hostile: 2, nearestDistance: 2 })
  })

  it('ignores malformed rows instead of throwing', () => {
    const inventory = summarizeInventory([{ name: 'coal', count: -3 }, { name: 4, count: 1 }, null, 'x'])
    expect(inventory).toEqual({ items: [{ name: 'coal', count: 0 }], total: 0, distinct: 1, byName: { coal: 0 } })
    expect(summarizeEntities([{ distance: 'far' }, null])).toEqual({ count: 1, hostile: 0, nearestDistance: null })
  })
})

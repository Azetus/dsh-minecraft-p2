---
name: p2-survival
description: Use when mining, lighting tunnels or shelters, or collecting combat drops: avoid through-wall digs, light spawnable spaces, and confirm drops before leaving.
---

# P2 survival 约束

## 挖掘

- 不隔墙挖；只挖自己所在层、能确认落点/可站拾取区的方块。
- 不挖脚下方 2 格，不要制造封闭坑。`unreachableDrops` 出现时不要计算落点，换位置或放弃。
- 挖前先想好回程；没有出口不挖封闭石室。

## 照明

- 封闭空间和矿道会刷怪；入口、尽头、每 5 格、床边放火把。
- 用 `p2_observe` 的 `light`/`skyLight` 判断；未知不等于安全。

## 战斗拾取

- 以取材料为目的的战斗结束后 5 分钟内确认并拾取掉落：用 `p2_entities` 找掉落，走到已加载可站格拾取，读背包增量。
- 床要 3 块同色羊毛；先确认颜色和数量，不要拿混色。
- 不把“掉落物存在”当成“已拾取”。

# M5 安全环境长跑（材料 / 建造 / 合成 / 熔炼）

> 状态（Phase E）：CP1–CP5 为**低优先**，当前不作为验收门槛；26.1 实机本轮不跑，历史 1.21.1/26.1 证据只作记录。`p2 doctor` / source-bundle digest 已砍掉，由 `verify-dist` + manifest 覆盖。

目标：在**无敌对**环境验证 Agent 自主组合有限原语，而不是执行一套固定脚本。

## 环境

- 保留白天，或至少保证 `doMobSpawning=false` 后无新增 hostile。
- 不修改验收世界的 `level.dat`；只在运行前执行实验性 gamerule。
- 现场准备：
  - 可站立的建造空地；
  - 工作台、熔炉、箱子；
  - 箱子内 `coal`、`raw_iron`；
  - 可采集的树/石头/泥土；
  - 可选：床物品。

## 有限原语

`go / place / dig / equip / use / attack / check / container / craft / build / traverse / hold`

Agent 组合：

| 目标 | 组合 |
|---|---|
| 找矿 | `p2_observe` 方块列表 + `go` |
| 挖矿 | `equip` 镐 + `dig` + `go` 捡掉落 |
| 放床 | `place` + `use`（bed） |
| 合成工具 | `craft` + `equip` |
| 建 shelter | `build`（blueprint） |
| 熔炼 | `container` load-input/load-fuel + `use`/`check` + `container` take-output |

## CP 验收

| CP | 目标 | 证据 |
|---|---|---|
| CP1 | 采集材料并建成一个封闭 shelter | `build` order terminal + sealed-room verifier |
| CP2 | 放床并睡到醒来 | `place`/`use` terminal + 床方块 + sleep observed |
| CP3 | 合成并装备工具 | `craft`/`equip` terminal + 背包/手持 |
| CP4 | 找到铜矿、挖取并收集 | 观测坐标 + `go/equip/dig` terminal + 背包数量 |
| CP5 | 从箱子取矿/煤，熔炼，取回产物 | `container/use/check` terminal + 容器内容 |

## 运行约束

- Agent 每次只发一条 order，等 completion wake 再决策；不 `Start-Sleep`、不轮询。
- 失败即停，保留最后一条 order/observed/world 观测。
- 一个世界、一次运行、不重放固定动作。
- 证据建议：
  - `runId`、CP、起止 `timeOfDay`；
  - 每条 order 的 `verb/params/state/observed`；
  - 关键世界观测（shelter 方块、床、背包、炉/箱）；
  - 失败时附 `p2_report` 和最后观测。

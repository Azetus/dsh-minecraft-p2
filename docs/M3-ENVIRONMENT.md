# M3 测试环境记录

> 2026-10-27。此记录只固定环境和连接探针，不代表 M3 已开始或已具备游戏控制能力。

## 环境

- Minecraft：Java **1.21.1 Vanilla**（LAN status 返回 `1.21.1`，protocol 767）
- 世界：超平坦，世界名 `Human_Player - dsh-minecraft-p2 超平坦`
- 模式：生存，允许指令
- 端口：`25575`
- 地址：`127.0.0.1:25575`
- 人类角色：`Human_Player`
- P2 测试角色：`P2_Bot`（离线认证）
- 服务器：单人客户端“对局域网开放”，非 NeoForge

## 连接探针

安装：

```text
mineflayer@4.39.0
minecraft-data@3.117.0
minecraft-protocol@1.68.0
Node: v26.2.0（本次探针）
```

运行：

```text
node scripts/m3-probe.mjs 127.0.0.1 25575 P2_Bot
```

结果：

```json
{
  "ok": true,
  "username": "P2_Bot",
  "version": "1.21.1",
  "position": { "x": -2.5, "y": -60, "z": 7.5 },
  "dimension": "overworld",
  "gameMode": "survival",
  "players": ["Human_Player", "P2_Bot"],
  "health": 20,
  "food": 20,
  "inventory": [],
  "below": "grass_block"
}
```

这证明 G0 的最小部分成立：原版 1.21.1 LAN、离线用户名、两个独立玩家、P2 可读取自身位置/维度/模式/生命/饥饿/脚下方块。

## 已知告警

连接时重复出现非致命解析告警：

```text
PartialReadError: ... Missing characters in string ...
  at ArmorTrimMaterial ... SlotComponent ...
```

P2 仍能 spawn 并读取上述基础事实；该告警很可能与 1.21.1 的 slot/armor-trim/recipe 数据解析有关，需在 M3 控制测试前定位或固定依赖版本。当前不能据此宣称物品栏/容器读取完全可靠。

## 环境约束

- 世界先备份；测试区在出生点附近，不使用真实基地。
- 建议先保持 `peaceful`、无 mob、固定白天；本次探针未改变世界设置。
- 不加载 NeoForge/模组；NeoForge 的握手与 vanilla Mineflayer 不兼容风险见前一轮讨论。
- 下一步只做 G1 观测（方块/背包/实体）和失败注入，确认解析告警影响面后再进入 G2 控制。

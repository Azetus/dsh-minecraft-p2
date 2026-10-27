# M3 测试环境与 G1 观测记录

> 2026-10-27。此记录覆盖 Vanilla 1.21.1 LAN 环境、G0 连接和 G1 只读观测；尚未执行控制动作。

## 环境

- Minecraft：Java **1.21.1 Vanilla**（LAN status 返回 `1.21.1`，protocol 767）
- 世界：超平坦，世界名 `Human_Player - dsh-minecraft-p2 超平坦`
- 模式：生存，允许指令
- 难度：当前 **normal**；世界中存在村民、牛、羊、铁傀儡、史莱姆
- 端口：`25575`
- 地址：`127.0.0.1:25575`
- 人类角色：`Human_Player`
- P2 测试角色：`P2_Bot`（离线认证）
- 服务器：单人客户端“对局域网开放”，非 NeoForge

## 依赖固定

Mineflayer 4.39.0 的默认解析依赖曾出现 `PartialReadError: ArmorTrimMaterial/SlotComponent`。固定为：

```text
mineflayer@4.39.0
minecraft-data@3.114.0
minecraft-protocol@1.67.0
```

固定后重复连接不再出现该解析告警，背包读取为空也正常。`minecraft-data@3.117.0` + `minecraft-protocol@1.68.0` 的组合在本次 1.21.1 环境中复现了告警。

## G1 观测

运行：

```text
node scripts/m3-probe.mjs 127.0.0.1 25575 P2_Bot
```

实测：

```json
{
  "ok": true,
  "observedAt": "2026-10-27T13:01:59.415Z",
  "sampledAt": 1793106119415,
  "connectionEpoch": "71c3a3a8-ecb1-47db-9829-efc0067c1ea8",
  "username": "P2_Bot",
  "version": "1.21.1",
  "position": { "x": -2.5, "y": -60, "z": 7.5 },
  "dimension": "overworld",
  "gameMode": "survival",
  "difficulty": "normal",
  "timeOfDay": 1000,
  "players": ["Human_Player", "P2_Bot"],
  "health": 20,
  "food": 20,
  "inventory": [],
  "below": "grass_block",
  "feet": "air",
  "head": "air",
  "entities": [
    { "name": "villager", "type": "passive" },
    { "name": "cow", "type": "animal" },
    { "name": "iron_golem", "type": "mob" },
    { "name": "player", "type": "player" }
  ]
}
```

（实体数组已截断为少量样本；完整输出见运行结果。）

这证明 G1 的最小只读闭环成立：

- P2 能读取自己的位置、维度、模式、难度、时间；
- 能读取脚下方块和头部/脚部空气；
- 能读取空背包、生命、饥饿；
- 能看到人类 player 实体和其他实体；
- 输出带 `observedAt`、`sampledAt`、`connectionEpoch`，可作为来源/新鲜度/连接 epoch 证据。

## 仍然注意

- 世界当前是 **normal 难度且有 mob**，不适合直接做 G2 控制测试；进入 G2 前应备份世界并切到安全测试区/peaceful。
- G1 是 Mineflayer 原始观测探针，不是 P2 provider/QueryOp 契约实现；它只证明数据可读，不证明 metadata/失败语义已经接入。
- 没有执行移动、挖掘、放置、攻击或任何控制。
- 依赖审计仍有 6 个 moderate 告警，未做 `npm audit fix --force`；需在发包前单独评估。

## 下一步

先不要进入 G2。下一步应先：

1. 将 Mineflayer 观测映射成 P2 的只读 QueryOp 原型；
2. 验证方块/背包/实体查询的失败与陈旧语义；
3. 把世界切到安全 G2 区域后再做 look/move/jump/stop。

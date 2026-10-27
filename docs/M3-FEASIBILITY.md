# M3 Minecraft 接入可行性报告

> 2026-10-27，`dev` 分支，包版本 `0.1.0`。范围：**Java Vanilla 1.21.1 LAN + Mineflayer + P2 body**，G0—G3 最小接入实验，以及隔离 dev 中的真实 DSH 工具 stop。  
> 本报告不声称 P2 已可进行通用游戏，也不声称 NeoForge/整合包兼容。

## 1. 结论

### 1.1 可行性判断

**有条件成立。**

在固定环境、单个 owner、单个 body、Vanilla 1.21.1、peaceful 超平坦世界中，以下链路已被真实运行验证：

```text
DSH 命令/工具
  → P2 bridge
  → 独立 body 子进程（JSONL stdio）
  → BehaviorExecutor / BehaviorRun
  → MineflayerProvider（ActPort/QueryPort）
  → Mineflayer bot
  → 真实 Minecraft 世界
```

可以做到：

- 只读观测自己的位置、维度、模式、难度、时间、背包、生命、饥饿、脚下方块和实体；
- 执行 look / move / jump / stop；
- 从 body 协议和真实 DSH 工具两条路径停止 behavior，并保留 body；
- 区分正常 stop、连接丢失、被踢、body 强杀、世界卸载和新 epoch；
- 在隔离 dev 中用真实 agent 调用 owner 工具完成 start/check/activate/switch/status/stop。

不能据此声称：

- 能挖矿、建造、战斗、合成、交易或长期生存；
- 能处理多人延迟、争抢、死亡/重生、维度切换和复杂地形；
- 兼容 NeoForge 或目标整合包；
- 已在真实 Desktop profile 安装；
- P2 的人格/记忆已经和游戏长期行为闭环。

### 1.2 M3 退出条件核对

| 退出条件 | 结果 | 证据/边界 |
| --- | --- | --- |
| 可观察到两个独立角色 | **通过** | G1 同时看到 `Human_Player` 与 `P2_Bot` |
| 动作控制不争抢人类角色 | **测试范围内通过** | P2 只控制自己的 bot；未做同时操作压力测试 |
| 取消有明确结果 | **通过** | body stop、DSH `p2_stop` 均返回 accepted/cancelled，activeRun=null |
| body 丢失有明确结果 | **通过** | `/kick`、强杀 body、世界卸载均验证；query `CONNECTION_LOST`，新 epoch |
| 游戏暂停有明确结果 | **有条件通过** | 服务端 tick 冻结可观测；但 Mineflayer 客户端仍预测移动，语义需后续处理 |
| 世界卸载有明确结果 | **通过** | 旧 epoch 断连、新 epoch 无旧 run 重放 |
| core/观测层/behavior/act 不直接依赖 Mineflayer | **通过（边界明确）** | Mineflayer import 仅存在于 `src/provider/mineflayer.ts`；`src/core`、`src/contracts` 无匹配 |

结论：**M3 作为“接入可行性实验”通过，但不是“游戏能力完成”**。

## 2. 固定环境

| 项 | 值 |
| --- | --- |
| 游戏 | Java **Vanilla 1.21.1**，protocol 767 |
| 世界 | 超平坦，`P2 测试超平坦世界` |
| 入口 | 单人客户端“对局域网开放”，`127.0.0.1:25575` |
| 模式 | 生存，允许指令 |
| 难度 | G1 初次为 normal；G2/G3 固定 **peaceful** |
| 时间 | 固定白天 |
| 人类角色 | `Human_Player` |
| P2 角色 | `P2_Bot`，离线认证 |
| 加载器 | **无 NeoForge，无 mods** |
| Mineflayer | `4.39.0` |
| minecraft-data | `3.114.0` |
| minecraft-protocol | `1.67.0` |

依赖固定原因：Mineflayer 默认依赖组合在本环境出现 `PartialReadError: ArmorTrimMaterial/SlotComponent`；固定 `minecraft-data@3.114.0` + `minecraft-protocol@1.67.0` 后消失。`minecraft-data@3.117.0` + `minecraft-protocol@1.68.0` 复现告警，不能直接升级。

NeoForge 环境的握手与 Vanilla Mineflayer 不兼容；本阶段明确不静默替换用户版本或修改整合包。

## 3. 实现路径

### 3.1 分层

```text
DSH bridge / owner tools
        │  body 子进程 stdio JSONL
        ▼
P2 body（无 Mineflayer 类型）
        │  BehaviorHost QueryPort / ActPort
        ▼
MineflayerProvider（唯一 Mineflayer import）
        │
        ▼
Mineflayer bot → Vanilla server
```

- `src/core`：BehaviorExecutor、BehaviorRun、broker、host、command/status，不依赖 Mineflayer。
- `src/contracts`：JSONL 协议、IR、错误、Observe/Stop 类型，不依赖 Mineflayer。
- `src/provider/mineflayer.ts`：把 QueryOp/ActOp 映射到 Mineflayer；query/act 附 source/sampledAt/validUntil。
- `src/body`：通过 `P2_MC_*` 环境变量动态加载 provider；未配置时保持 provider-unavailable。
- `src/bridge`：owner 作用域工具；`/p2 start` 人工启动 body；工具只操作本 owner 的 binding。

检查结果：

```text
src/provider/mineflayer.ts: import type { Bot } from 'mineflayer'
src/provider/mineflayer.ts: import mineflayer from 'mineflayer'
src/core:     无 mineflayer 匹配
src/contracts: 无 mineflayer 匹配
```

### 3.2 body 协议与生命周期

关键协议方法：

```text
hello, heartbeat, describe, status,
observe, check, activate, switch, confirm,
behavior.stop, stop, shutdown, command.get
```

- body 有 `bodyEpoch`；重连/世界卸载后必须换 epoch。
- bridge 通过 heartbeat 持有 owner lease；没有 heartbeat 的裸探针会在等待期间 `owner lease expired`。
- `behavior.stop` 只结束 run；`stop` 关闭 body。
- 连接丢失时 provider 清除控制并 abort 当前 act；query 返回 `CONNECTION_LOST`，不返回旧世界数据。
- 工具参数必须是标准 JSON Schema；这是本阶段发现的真实 DSH 集成问题。

## 4. G0/G1：连接与只读观测

### 4.0 G0 连接

Vanilla 1.21.1 LAN handshake 成功（protocol 767），离线认证 `P2_Bot` 可 spawn；同一时刻 `players` 包含 `Human_Player` 与 `P2_Bot`，满足两个独立角色。未使用 NeoForge 或真实客户端驱动。

### 4.1 覆盖的 QueryOp

```text
position / inventory / entities / time / block
```

### 4.2 实测

`node scripts/m3-probe.mjs 127.0.0.1 25575 P2_Bot` 在 Vanilla LAN 返回：

- position `(-2.5, -60, 7.5)`；
- dimension `overworld`；
- gameMode `survival`；
- difficulty `normal`（首次）；G2/G3 固定为 `peaceful`；
- timeOfDay `1000`；
- players `["Human_Player", "P2_Bot"]`；
- health/food `20/20`；
- inventory `[]`；
- below `grass_block`，feet/head `air`；
- 可见 cow、sheep、villager、iron_golem、player。

输出带 `observedAt`、`sampledAt`、`connectionEpoch`，用于来源/新鲜度/连接隔离。

### 4.3 限制

- 这是 Mineflayer 客户端观测，不是服务端权威查询。
- 位置在客户端预测下会领先于服务端 tick，尤其在 `/tick freeze` 时（见 G3）。
- G1 不证明 provider QueryPort 的失败/陈旧语义完整；provider 是在 G2 才接入。

## 5. G2：最小控制

### 5.1 原始探针

`node scripts/m3-g2.mjs 127.0.0.1 25575 P2_Bot`：

- look：yaw `0 → π/2`；
- move：约 `3.23` 格；
- jump：峰值 y `-58.8133`，airborne；
- stop：controls 全 false，停止后第一秒残余约 `0.0337` 格，随后为 0。

### 5.2 P2 映射

`node scripts/m3-g2-mapped.mjs` 通过 `BehaviorExecutor → MineflayerProvider`，结果：

```json
{
  "status": "succeeded",
  "ticks": 24,
  "controls": {
    "forward": false, "back": false, "left": false, "right": false,
    "jump": false, "sprint": false, "sneak": false
  },
  "settledPosition": { "x": -9.2863, "y": -60, "z": -13.7406 },
  "settledDelta": { "dx": -0.023, "dy": 0, "dz": 0 }
}
```

结论：

- look/move/jump/stop 能通过 P2 的 ActPort 执行，不再只是裸 `bot.setControlState`；
- jump 等离地后再次 onGround 才完成；
- stop 后仍有一个物理 tick 的位移结算，约 `0.02` 格。

### 5.3 边界

- 这是 provider/executor 路径，不是完整 ControlOp commandId/operationId/effects 账本。
- 没有挖掘、放置、攻击、使用物品或修改世界。
- 世界 peaceful，固定白天，未测试复杂地形和水/岩浆。

## 6. G3：停止与失败语义

### 6.1 body 外部 stop

长 move 期间通过 body `behavior.stop`：

- `accepted=true`，响应约 `1ms`；
- 停止后 `activeRun=null`；
- controls 全 false；
- 0–200ms 残余约 `0.2365` 格（约一个步行 tick），200–1200ms 再 `0.0193` 格后稳定；
- **发现并修复真实 bug**：`BehaviorRun.stop()` 原先只设置自己的 `stopRequested`，没有传给 executor；长 act 会继续跑。

这是本阶段最重要的控制修复之一。stop 响应时间不等于物理停止完成时间；判据必须是控制释放 + 位移收敛。

### 6.2 `/kick` 连接丢失

长 move 期间操作员执行 `/kick P2_Bot`：

```json
{
  "ok": true,
  "disconnect": {
    "status": "run-terminal",
    "elapsedMs": 15287,
    "activeRun": null,
    "pendingConfirmation": null,
    "health": "ready"
  },
  "observeError": "CONNECTION_LOST: Mineflayer connection ended: socketClosed",
  "heartbeatCount": 16,
  "stderr": ""
}
```

结论：

- run 终止，activeRun=null；
- body 仍存活，health=ready；
- query 返回 CONNECTION_LOST，不伪造世界数据；
- 停止原因是连接丢失，不是 succeeded。

### 6.3 强制结束 body

`node scripts/m3-g3-kill.mjs` 强杀 body 后，用独立 observer 检查：

```json
{
  "ok": true,
  "bodyExit": { "signal": "SIGTERM" },
  "playersAfterKill": ["Human_Player", "M3_Observer"],
  "p2Absent": true
}
```

结论：强杀后 P2 从服务器消失；没有游戏级“已停止”确认，不能用退出码断言世界已清理。重连必须使用新 epoch。

### 6.4 `/tick freeze` 暂停

`/tick freeze` 有效：world age 停在 `60090`，约 10 秒后解冻恢复 `60105`；stop 后 activeRun=null。

但关键发现是：

- **Mineflayer 客户端物理没有停**；冻结期间客户端位置仍从约 `x=-1643` 前进到 `x=-1685`；
- `observe position` 在此期间是客户端预测值，不是服务端权威值；
- 没有观察到解冻后服务端把 P2 拉回冻结位置；
- 因此“服务端 tick 停”不等于“P2 已停止”，也不等于“客户端没有新动作”。

这是 M3 中最重要的语义缺口，直接影响 Query 新鲜度和 M4 的暂停处理。

### 6.5 世界卸载/重开

操作员保存退出世界，LAN 端口消失后重新进入同一世界并开放：

| 项 | 值 |
| --- | --- |
| oldEpoch | `39385f3e-...` |
| old activeRun | null |
| old query | `CONNECTION_LOST` |
| worldDown / worldUp | true / true |
| newEpoch | `025cba2d-...` |
| new activeRun | null |
| new observed | `x=-1880.74, y=-60, z=-13.74` |

结论：

- 旧 body 断连，旧 run 不再 active；
- 新 body 使用不同 epoch；
- 没有旧 run/旧命令重放；
- 旧 body 在等待期间因探针没有 heartbeat 出现 `owner lease expired`；这是测试探针时长问题，不代表正式 bridge 行为。

### 6.6 runner 卡住

`test/body-behavior.test.ts` 使用永不完结的 ActHandle：

- `poll()` 永远 running；
- body `behavior.stop` 后 activeRun=null；
- runner 的 `stop()` 恰好调用一次。

证明 stop 不依赖 act 自己完成。

### 6.7 真实 DSH 工具 stop

在隔离 dev profile（不安装 Desktop）中使用真实 agent：

```text
p2_check    → artifactId=p2:behavior:bee7c449...
p2_activate → enabled
p2_switch   → accepted=true, runId=run-1, running
p2_status   → activeRun=run-1
p2_stop     → accepted=true, status=cancelled
p2_status   → body active, activeRun=null, bodyEpoch 未变
```

body epoch：`fe75cf99-...`。

首次调用失败于工具参数 schema：

```text
Invalid schema for function 'p2_activate':
schema must be a JSON Schema of 'type: "object"', got 'type: null'
```

修复为 `type: object` + `properties` + `required` 后通过。

这证明：

- 模型实际调用的 owner-scoped `p2_stop` 生效；
- stop 只结束 behavior，body 保留；
- 不是仅有 body 协议 stop 或 fake ctx 测试。

## 7. 关键发现

### 7.1 服务端 tick 与客户端预测必须分离

这是本阶段最重要的设计输入：

- `observe position` 在正常游玩中可用，但在 tick freeze/暂停/高延迟下可能领先服务端；
- 暂停期间不能把客户端移动当成新事实；
- 需要 `serverAge`/`sampledAt`/连接状态/预测标记；
- 暂停是“冻结行为”“标记陈旧”还是“自动 stop”，必须在 M4 前明确；
- 不能因为客户端还在移动就宣称服务端发生了动作。

### 7.2 stop 是“控制释放 + 收敛”，不是 0ms

实测残余：

```text
停止后第一 tick：约 0.237 格
之后：约 0.019 格
最终：controls false，水平速度 0
```

G3/M4 的停止测试必须记录控制位、速度、位移收敛和 activeRun，而不能只看 `accepted=true`。

### 7.3 body lease 必须由 bridge 持有

裸探针如果不发 heartbeat，会在约 10 秒后 owner lease expired；这不是游戏断连。正式路径由 bridge heartbeat 持有，测试必须模拟或使用 bridge。

### 7.4 工具参数必须是标准 JSON Schema

内部字段描述不能直接作为 DSH 工具的 `parameters`。所有工具已改为：

```ts
{ type: 'object', properties: {...}, required: [...], additionalProperties: false }
```

### 7.5 命令权限只用于测试操作员

当前 LAN 测试角色可执行 `/list`、`/time query`、`/tick query`、`/tick freeze`。这用于测试探针，不意味着 provider 应暴露任意 `/command` act。任意命令会绕过 ControlOp/broker 契约，正式接口不应提供。

### 7.6 版本固定是可行性的一部分

`mineflayer 4.39.0` + `minecraft-data 3.114.0` + `minecraft-protocol 1.67.0` 是当前 Vanilla 1.21.1 可复现组合。升级必须重新做解析/连接回归。

## 8. 软件回归与未验证 / 风险

```text
npm run check
  → 16 test files / 121 tests: pass
```

| 项 | 状态 |
| --- | --- |
| 挖矿、放置、攻击、使用物品、合成、交易 | 未实现/未测试 |
| 寻路、复杂地形、水/岩浆、摔落 | 未测试 |
| 死亡/重生、维度切换、末地/下界 | 未测试 |
| 多人延迟、同时人类操作、争抢 | 未测试 |
| 长期运行、内存/CPU、背压、事件丢失 | 未测试 |
| 真实 Desktop profile 安装/重载 | 未做（只做隔离 dev） |
| provider 配置正式化 | **已完成**：`.p2/config.json` + env 覆盖，见 [M4-PREP.md](M4-PREP.md) |
| `/p2 start` 在无 provider 环境自动连接 | body 配置读取与隔离 dev `/p2 start`/`stop` 已验证；Desktop 未验证 |
| 世界记忆/人格持久化与游戏行为闭环 | 只有 dev session/workspace 复用验证，未接游戏行为 |
| NeoForge/整合包 | 明确未验证 |
| 任意命令/模型代码安全 | 不提供任意命令 act；M5 才处理自定义 act 隔离 |

## 9. 进入 M4 的前置

在开始“首个完整行为与反馈”前，建议先完成三件事：

1. **Provider 配置正式化**
   - 已实现 `.p2/config.json` + `P2_MC_*` 覆盖；详见 [M4-PREP.md](M4-PREP.md)。
   - 还需在 M4 验证 DSH `/p2 start` 从 owner workspace 读取配置的完整链路。

2. **Query 新鲜度与暂停语义**
   - `ValueMeta` 已带 `serverAge`/`paused`，provider watchdog 会在 server age 停滞时 abort act 并拒绝世界 query；
   - `providerState` 已进入 `p2_status`；
   - 仍需在 M4 首个 behavior 中决定“暂停后重新开始”的产品流程。

3. **M4 行为范围**
   - 建议从非破坏性、可验证的有限行为开始，例如“看向目标点 + 接近到指定距离 + stop”；
   - 持续行为可做“待机/观察/保持距离”；
   - 暂不接挖矿、攻击、放置和复杂合成；
   - 保持 peaceful、备份世界、固定白天。

## 10. 结论与建议

M3 证明了 **Mineflayer 可以作为 P2 的首个真实游戏接入层**，并且 P2 的 body/工具/停止/epoch 边界能在真实 Vanilla 环境中工作。这个结论是**窄范围、实验性**的：

- 成功的是“单 bot、单 owner、最小控制、可停止、可断连、可换世界”的接入；
- 尚未成功的是“通用游戏 agent”。

建议：

- **进入 M4**，但先做 provider 配置和 serverAge/暂停策略；
- 首个 behavior 选择非破坏性、短时、可测的移动/观察目标；
- 将本报告第 7 节的发现作为 M4 的输入，而不是当成已解决；
- 不因 M3 通过而声称 NeoForge/整合包或完整生存能力。

## 11. 证据索引

- [M3-ENVIRONMENT.md](M3-ENVIRONMENT.md)：环境、依赖固定、G1。
- [M3-G2.md](M3-G2.md)：原始 look/move/jump/stop。
- [M3-G2-MAPPED.md](M3-G2-MAPPED.md)：P2 executor/provider 映射。
- [M3-G3.md](M3-G3.md)：stop、kick、强杀、freeze、卸载、runner。
- `scripts/m3-g3-unload.mjs`、`scripts/m3-g3-kick.mjs`、`scripts/m3-g3-kill.mjs`、`scripts/m3-g3-pause-auto.mjs`。
- `scripts/m3-dsh-tool-stop.mjs`：隔离 dev 中真实 DSH 工具 stop。
- `test/body-behavior.test.ts`、`test/mineflayer-provider.test.ts`：runner/provider 回归。

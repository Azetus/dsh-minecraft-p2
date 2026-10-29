# M4 阶段验收记录

> 2026-10-27。M4 首个完整行为、持续行为、DSH 工具链和异常流程的阶段记录。  
> 本记录不声称通用游戏能力、pathfinder、NeoForge 或 Desktop 安装已完成。

## 1. 范围与结论

M4 在 Vanilla 1.21.1、peaceful、超平坦、单 body、单 owner 环境中通过：

- `moveTo` act；
- finite `approach-target`；
- continuous `hold-position`；
- lastRun / p2_events；
- DSH 工具链 check/activate/switch/status/events/stop；
- 真实受阻、恢复、取消；
- 真实暂停与 world query 失败。

结论：**M4 首个行为闭环成立**，但仍是受控测试世界中的最小行为，不是完整生存 agent。

## 2. 环境与最终固定状态

| 项 | 值 |
| --- | --- |
| 游戏 | Vanilla 1.21.1，protocol 767 |
| 世界 | 超平坦，peaceful |
| 时间 | `timeOfDay=1000`，`doDaylightCycle=false` |
| 人类 | `Human_Player` |
| P2 | `P2_Bot`，离线认证 |
| 端口 | 25575 |
| Mineflayer | 4.39.0 |
| minecraft-data | 3.114.0 |
| minecraft-protocol | 1.67.0 |

世界在 M4 收尾时固定为 peaceful + 固定白天，并做了本地备份：

```text
.backups/m4-world-20261027.zip
SHA-256: 6AE7105134D1B17E9FAC78676B90F0E260DB4E88D55699DFFAAD1E79A0868716
```

`.backups/` 已忽略，不进入 Git。

## 3. Act 与行为

### moveTo

- 水平接近固定 x/z；
- 容差内成功并清控制；
- `MOVE_TO_TIMEOUT`；
- `MOVE_TO_BLOCKED`；
- 暂停/断连 abort；
- 无 pathfinder、无跳跃越障。

### finite：approach-target

```text
moveTo → stop → phase=done
```

真实成功：

```json
{
  "before": { "x": -1912.4688, "z": -13.7406 },
  "target": { "x": -1909.4688, "z": -13.7406, "tolerance": 0.8 },
  "after": { "x": -1909.8426, "z": -13.7406 },
  "distance": 0.3739,
  "lastRun": { "runId": "run-1", "status": "succeeded" }
}
```

### continuous：hold-position

```text
repeat: moveTo → stop → wait 500ms
```

目标切换通过显式 `p2_switch` 创建新 run；旧 run 被取消。

## 4. DSH 工具链

新增 `p2_observe` 后，模型可以读取位置再计算相对目标。

```text
p2_observe(position)
p2_check(approach-target)
p2_activate
p2_switch(target)
p2_status / p2_events
```

有限行为：

```text
run=none:none  last=run-1:succeeded
```

持续行为目标切换：

```text
run=run-2:running  last=run-1:succeeded
run=run-3:running  last=run-2:cancelled
run=none:none      last=run-3:cancelled
```

## 5. 受阻/恢复/取消

操作员在 P2 前方建短 barrier 墙，测试后清理。

```text
blocked:   last=run-1:failed:MOVE_TO_BLOCKED
recovered: last=run-2:succeeded
running:   run=run-3:running
cancelled: run=none:none  last=run-3:cancelled
```

这说明：

- 真实碰撞/无进展能触发 `MOVE_TO_BLOCKED`；
- 失败后可以重新 switch 恢复；
- 持续行为可以被显式 p2_stop 取消；
- lastRun 保留 succeeded/failed/cancelled。

## 6. 暂停与查询失败

`/tick freeze` 后：

```text
paused=true
last=run-1:failed:GAME_PAUSED
```

模型调用 `p2_observe(position)`：

```text
Error: server ticks are not advancing; world queries are unavailable while paused
```

解冻后：

```text
paused=false
activeRun=null
lastRun=run-1:failed:GAME_PAUSED
```

没有自动恢复旧 run。`p2_events` 能看到暂停/解冻和 run 终态。

修复点：act start 抛出 `P2Error` 时，executor 现在保留原始 code，而不是统一改写成 `ACT_START_FAILED`。

## 7. 验证

```text
npm run check
  → 19 test files / 132 tests pass
```

定向验证：

- `test/m4-behavior.test.ts`：finite/continuous；
- `test/mineflayer-provider.test.ts`：moveTo、暂停、GAME_PAUSED；
- `test/executor.test.ts`：act start P2Error 保留；
- `scripts/m4-dsh-chain.mjs`：DSH 有限/持续/目标切换；
- `scripts/m4-dsh-failure.mjs`：受阻/恢复/取消；
- `scripts/m4-dsh-pause.mjs`：暂停/query 失败。

## 8. 边界

- 没有 pathfinder、跳跃越障、复杂地形；
- 目标为固定坐标，不是实体追踪；
- 没有挖、放、攻击、合成、交易；
- 没有死亡/重生/维度切换；
- 没有多人延迟或争抢压力测试；
- DSH 仅隔离 dev，没有 Desktop 安装；
- NeoForge/整合包未验证；
- 暂停阈值 `serverIdleMs=1500` 是启发式，需要按环境调整；
- `dev --refresh` 已改为 remove+add+force，仍需后续回归。

## 9. 结论与下一步

M4 的首个有限行为、持续行为、目标切换和异常流程已闭环。  
下一个阶段（M5）才处理 agent 自定义 act 的隔离、资源限制和安全晋升；不应把 M4 的受控行为当成任意代码/任意游戏能力。

## 10. 证据索引

- [M4-PREP.md](M4-PREP.md)
- [M4-BEHAVIORS.md](M4-BEHAVIORS.md)
- [M3-FEASIBILITY.md](M3-FEASIBILITY.md)
- `scripts/m4-dsh-chain.mjs`
- `scripts/m4-dsh-failure.mjs`
- `scripts/m4-dsh-pause.mjs`
- `scripts/m4-approach-probe.mjs`
- `scripts/m4-hold-probe.mjs`
- `behaviors/approach-target.mjs`
- `behaviors/hold-position.mjs`

# 操作员手册（接入游戏时，Controller-only）

## 1. 启动

1. 人类：`/p2 setup` → `/p2 start`。
2. `p2_status`：`connection=connected`、`version=0.3.0`、`bodyEpoch` 非空、owner 是本 session。
3. `p2_card` + `p2_observe position`：确认进服、维度、位置。

## 2. 启动控制

```text
p2_check  {sourcePath: 'acts/goto.mjs', artifactKind: 'act'}
p2_activate {artifactId}
p2_check  {sourcePath: 'strategies/probe-walk.strategy.js', artifactKind: 'strategy'}
p2_activate {artifactId}
p2_controller action=enable
p2_controller action=install {artifactId}
p2_controller action=commit {id, goal, strategyKey, post, baselineKeys, checkpoint?, deadlineMs?}
```

`post` 例：`{kind:'count-at-least', factKey:'inventory', item:'dirt', count:1}`、`{kind:'standing'}`。

## 3. 巡检（每 5–10 分钟或唤醒时）

- `p2_controller action=status`：`mode`、`lease`、`commitment.state`、`decision.reason`、`degraded`。
- `p2_controller action=events {sinceSeq}`：动作、承诺、故障。
- `p2_card`：health/food/position/hostiles。
- watch 事件经 `p2_events`；watch 到期要续期。

## 4. 停止与异常

| 情况 | 动作 |
| --- | --- |
| 任务完成/放弃 | `p2_controller action=cancel` |
| 需要人工接管 | `p2_controller action=disable`（等 `mode=off`） |
| 承诺 `blocked` | 看 `blocked.missing/diagnostics`；不要重复 commit 同一策略 |
| `control-fault` | `disable` → 检查 provider 状态 → 重新 enable |
| 危险（水/苦力怕） | 先装 S0 策略；已触发时看 `suspended`，不要 disable 掉逃生动作 |
| 卡住/掉入坑 | `p2_rescue`（tp/effect）；必要时 `force:true` 覆盖活动动作；确认 `sent:true` 后必须读回位置 |
| body 重启 | `p2_body action=restart`（开发工具）；epoch 变化，controller/watch 清空，重新 enable/install/commit |

## 5. 验收纪律

1. 回执不是生效：必须读回 position/inventory/blocks。
2. 承诺成功必须有 `evidence`（`evidenceId/sampledAt` 晚于动作结束）。
3. 不用 sleep/轮询；等待靠唤醒。
4. 同一根因第二次出现，先修策略/act/op，不要硬试。
5. 没有 behavior/guard/switch；不要尝试旧接口。

## 6. 安全

- 不在未装 S0 逃生策略时进入水域/水下矿层。
- 不在据点/重生点 4 格内竖直下挖。
- 远离基地的测试先确认路径与敌对；随时准备 `p2_rescue`。
- `p2_controller disable` 不会把 bot 带回基地；需要时手动 rescue。

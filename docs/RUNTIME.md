# 运行时（Controller-only）

## 1. Body 生命周期

`/p2 start` 启动 body 子进程：连接 provider → 创建 `ArtifactHost` → 创建 `BodyController` → 进入 hello/心跳循环。没有 provider 时 body 仍可 check/activate，但 controller 不可用。

`/p2 stop` 走 `shutdown`：停止 controller（撤销租约）→ 关闭 provider/runner → 退出。bridge 负责故障检测与可选重启；body epoch 变化后 controller/watch 状态清空。

## 2. Tick

body 每 50ms：

1. `ArtifactHost.tick(now)`：推进 watch 采样（观察-only，任何 mode 都运行）。
2. 若 controller engaged：`BodyController.tick(now)`：租约/动作完成 → 观测 → 策略评估 → 承诺更新 → 仲裁 → dispatch。

`disable` 期间 controller 冻结评估/dispatch，只推进释放；释放确认后 `mode=off`。

## 3. 单 action slot

- 只有租约持有者可以 `act.start`。
- 交接顺序：revoke → stop → confirm release → grant → start；超时 `control-fault`。
- generation/attempt 隔离旧动作；旧 attempt 的结果不驱动新策略。
- 完成门：动作结束后必须重新采样证据；baseline 与 `freshSince` 都满足才 `succeeded`。

## 4. 槽位

`S0` 危险抢占（`hazardClass` 必填）> `S1` 维护 > `S2` 任务 > `S3` 探索。承诺绑定 S2；S0 抢占使承诺 `suspended`，危险清除后 `verifying` → 继续。

S0 重试预算：同一 `holder|intent` 60s 内 3 次启动未清除 → `blocked(S0_RETRY_EXHAUSTED)`；承诺 `EMERGENCY_BLOCKED`。

## 5. 观测

- provider query 返回 `ok/failed/pending`；host 记录 `sampledAt/validUntil/scope`。
- Controller 事实源：position/health/inventory/nearbyBlocks/entities；TTL 600–2000ms，coherence 1200ms。
- 策略只读 manifest 声明的事实；未知事实 → `unknown`，承诺 `blocked`（fail closed）。

## 6. 停止语义

| 操作 | 效果 |
| --- | --- |
| `controller.cancel` | 取消当前承诺，撤销其动作 |
| `controller.disable` | 冻结 dispatch，取消承诺，撤销租约，等释放后 off |
| `/p2 stop` | 停止整个 body |
| `p2_rescue` | 实验救援通道；不在 controller 控制路径内 |

## 7. 失败与恢复

- `control-fault`：停止/释放无法确认；controller `fault`，需 disable/重新 enable。
- 动作失败：记录 `action-completed: failed` + memory failure，由策略决定重试/换路；核心不做隐式重试。
- 策略异常：诊断 `STRATEGY_ERROR`，该 tick `blocked`；不落回低槽位。
- body 重启：controller 状态丢失；需重新 enable/install/commit。

# P2Controller body 接线与 strategy artifact（M4）

> 状态：**已实现**（2026-10-30）。M0–M3 的控制器核心未改动语义；本文件描述 body 单控制模式、命令面、策略产物与实机冒烟步骤。
> 关联：[P2CONTROLLER.md](P2CONTROLLER.md) §13–§14、[CONTRACTS.md](../CONTRACTS.md) §5.3/§9、[artifact-strategy.md](../../prompts/artifact-strategy.md)。

## 1. 改动概览

| 位置 | 内容 |
| --- | --- |
| `src/body/controller-host.ts` | `BodyController`：ActPort/QueryPort → ActuatorPort/SensePort；模式状态机；策略安装；承诺/事件；死亡与换维度失效 |
| `src/body/runtime.ts` | `controller.*` 协议方法；status 增加 `controller`；Controller 模式下 tick 走控制器、`switch` 返回 `CONTROL_MODE_CONFLICT` |
| `src/body/index.ts` | 有 provider 时创建 `BodyController` 并注入；shutdown 释放租约 |
| `src/core/strategy-checker.ts` | `strategy` artifact 的检查（manifest、禁用语法、act 依赖解析） |
| `src/core/strategy-runtime.ts` | body 内 vm 装载与同步求值（20ms 预算、JSON 进出） |
| `src/controller/artifact-strategy.ts` | 判定映射：approved act → artifactId、checkpoint、evidence、身份盖章 |
| `src/contracts/strategy.ts` | strategy manifest 契约与校验 |
| `src/core/host.ts` / `registry.ts` | artifact kind `strategy` 的检查/启用/查询 |
| `src/bridge/*` | `p2_check` 支持 `strategy`；新工具 `p2_controller`；status 透传 |

## 2. 控制模式

```text
off --enable(无 run、无 guard)--> active
active --disable--> disabling --(release confirmed)--> off
active/disabling --control fault--> fault --(release confirmed)--> active / off
```

- `enable` 拒绝：有 active run、有 guard、遗留 control fault、正在 settle。
- `disable`：取消当前承诺 → 撤销租约 → 停止动作 → 等释放确认；期间 `mode=disabling`，不再 dispatch。
- `fault`：停止新 dispatch；只有观察到释放才解除；解除后按 disableRequested 回到 off 或 active。
- 旧执行器模式（behavior/guard）与 Controller 模式互斥；同一 body 不同时存在两条调度路径。

## 3. 命令面

工具 `p2_controller`（bridge），实际协议方法 `controller.*`：

| 命令 | 说明 |
| --- | --- |
| `enable` | 进入 Controller 模式（要求无 run、无 guard） |
| `disable` | 退出模式：取消承诺并撤销租约，释放确认后 off |
| `status` | 控制器视图（见 §4） |
| `install {artifactId, mode?}` | 安装已启用的 strategy artifact；`mode=boundary`（默认）或 `interrupt` |
| `commit {goal, strategyKey, post, baselineKeys?, deadlineMs?, id?}` | 创建承诺并采样 baseline |
| `cancel {commitmentId?, reason?}` | 取消当前承诺（不退出模式） |
| `events {sinceSeq?, limit?}` | 按 seq 读取有界事件（≤100/页） |

`p2_status.controller` 与 `status` 返回同一视图（最近 50 条事件 + `eventSeq` 游标）。

## 4. 状态视图

```ts
{
  mode: 'off' | 'active' | 'disabling' | 'fault',
  enabledAt, phase,
  lease: { phase, state, generation, holder?, fault? },
  action: { intent, act, slot } | null,
  decision: { at, reason, selected, candidates, suppressedSlots, detail? } | null,
  commitment, commitments, strategies, verification, stall, memory, degraded,
  events: [{ seq, at, kind, slot?, strategyKey?, commitmentId?, detail?, data? }],
  eventSeq
}
```

关键观察点：`lease.fault`（必须为空）、`commitment.blocked.reason/missing`、`strategies[].installedVersion` 与 `activeVersion`（安装≠接管）、`decision.reason`。

## 5. 事实与刷新

默认事实源（`src/body/controller-host.ts`）：

| 键 | 查询 | 刷新 | TTL |
| --- | --- | --- | --- |
| `position` | `position` | 100ms | 600ms |
| `health` | `health`（含 oxygen） | 200ms | 600ms |
| `inventory` | `inventory` | 300ms | 1500ms |
| `nearbyBlocks` | `blocks`（常见生存资源，半径 16/24 个，exposed） | 700ms | 2000ms |
| `entities` | `entities`（24 格内按距离） | 400ms | 1200ms |

- 控制器一致性窗口 1200ms；跨事实判断要求同窗口，否则 `unknown(incoherent)`。
- 策略只能读 manifest 声明且 body 已注册的事实；否则 `install` 返回 `STRATEGY_FACT_UNKNOWN`。
- 死亡（`providerState.lastDeathAt` 变化）或维度变化 → `invalidateScope('body')`，承诺转 suspended→verifying。

## 6. strategy artifact 生命周期

```text
写 .js → p2_check artifactKind=strategy → p2_activate → p2_controller install
       → p2_controller commit → status/events → cancel/disable
```

- 检查期要求声明 act 已启用，并锁定其 artifactId；策略不能提议未声明的 act。
- 安装期载入 vm 并校验事实；替换走 boundary/interrupt，新 attemptId，跨版本默认重新核验。
- 求值预算 20ms；超时/异常/非 JSON 判定 → 该策略 `blocked`，不产生动作。
- 隔离基线：body 内 `node:vm`，与 JS behavior 同级，**不是安全边界**；agent 现场编写的策略在迁移隔离 runner 前按受信内容对待。

## 7. 实机冒烟步骤（人工）

1. `p2_body start` → `p2_status`：`connection=connected`，`controller=null` 或 `mode=off`。
2. 准备 act（例如 `dig`/`goto` 的自有 act）：`p2_check artifactKind=act` → `p2_activate`。
3. 写一个最小 strategy（见 `prompts/artifact-strategy.md` 示例），`p2_check artifactKind=strategy` → `p2_activate`。
4. `p2_guard clear all`（若登记过 guard）→ `p2_controller action=enable`。
5. `p2_controller action=install {artifactId}` → `p2_controller action=commit {goal, strategyKey, post:{kind:'count-at-least',factKey:'inventory',item:'stone',count:3,fromBaseline:true}, baselineKeys:['inventory']}`。
6. 观察：`p2_controller action=status` 每 1–2s；`p2_controller action=events sinceSeq=0`。
7. 人为制造危险（例如走进浅水/靠近苦力怕，若已装 S0 策略）：确认承诺 `suspended`→`verifying`→`active`，且验证期间无新动作。
8. 结束：`p2_controller action=cancel`，再 `action=disable`；`p2_status.controller.mode` 最终为 `off`。

### 判定失败（硬条件）

- `lease.fault` 非空仍出现新动作；停用后仍 dispatch。
- 承诺 `succeeded` 但 `evidence` 为空、`sampledAt` 早于收尾、或 baseline 缺失。
- 旧策略版本在接管后仍产生动作；安装后 `activeVersion` 长期不变化却已在执行新意图。
- `blocked` 无 `missing`/`diagnostics`，或长期 `unknown` 不转 `blocked`。

## 8. 已知限制

- 策略沙箱是进程内 vm，不是隔离 runner；恶意代码可逃逸（与 JS behavior 相同的已知基线）。
- `nearbyBlocks` 默认只含常见资源名；新方块需求要改事实源。
- `blocked` 只写状态/事件，不唤醒 owner（事件通道接线留待后续）。
- `p2_stop` 不停止 Controller；必须用 `controller.cancel` / `controller.disable`。
- 无自动重启/跨 body epoch 恢复：body 重建后需重新 enable/install/commit。

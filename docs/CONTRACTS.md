# P2 契约（Controller-only）

## 1. 边界

- **bridge ↔ body**：JSON-lines `RequestEnvelope/ResponseEnvelope`（`src/contracts/protocol.ts`）。
- **body ↔ provider**：`QueryPort`/`ActPort`（`src/core/node-runtime.ts`）。
- **content ↔ host**：act/policy/op/strategy 单文件 artifact；检查通过后才可激活/安装。

## 2. Artifact

`ArtifactKind = 'act' | 'policy' | 'op' | 'strategy'`。

| 类型 | 入口 | 说明 |
| --- | --- | --- |
| act | `defineAct({manifest, create})` | 单文件、同步 hook；`queryOps/controlOps` 必须已注册 |
| policy | `definePolicy({manifest, run})` | 纯函数；watch 谓词 |
| op | `defineOp(...)` | body 进程；扩展 query/control 原语 |
| strategy | `defineStrategy({manifest, evaluate})` | 纯 JSON；见 `strategy.ts` |

所有 artifact 的 manifest/artifact id/digest/binding 必须一致；依赖在 check 时锁定精确 artifactId。

## 3. 检查与激活

- `p2_check {sourcePath, artifactKind?, timeoutMs?}` → `{artifactId, definitionId, sourceDigest, bindingId, kind, enabled:false}`。
- `p2_activate {artifactId}` → 启用默认映射；policy 只作为依赖，不单独启用。
- 重新 check 同一 source 会得到同一 artifactId；同 definition 新版本需要重新 check/activate。

## 4. Controller 协议

| 方法 | 语义 |
| --- | --- |
| `controller.enable` | 进入唯一控制模式；要求无已启用 action |
| `controller.disable` | 冻结 dispatch → 取消承诺 → 撤销租约 → 等待释放 → off |
| `controller.install {artifactId, mode?, shadow?}` | 安装已激活 strategy；同 definition 版本变更走 pending takeover；`shadow:true` 只评估、不取得租约 |
| `controller.commit {goal, strategyKey, post, baselineKeys?, checkpoint?}` | 创建承诺；baseline 在 commit 时采样 |
| `controller.queue`（同一组参数） | 入队；当前承诺终止后自动提交下一个，队列上限 32；body 重启清空 |
| `controller.cancel {commitmentId?, reason?}` | 取消承诺并撤销其动作 |
| `controller.status` | 完整 `ControllerView` |
| `controller.events {sinceSeq?, limit?}` | 事件游标 |

`post`：`{kind:'count-at-least', factKey, item?, count}` | `{kind:'fact-equals', factKey, value}` | `{kind:'standing'}`。

完成门：`candidate-complete` → cleanup → 收尾后 fresh 证据 → `succeeded`；证据缺失/过期/baseline 未知 → `blocked`，不伪造成功。

### 4.1 可解释性与度量

`ControllerStatus` 现在还提供：

- `decisions[]`：最近 64 个 tick 的 `{tick, reason, selected, candidates, suppressedSlots, evidence}`；`evidence` 是事实 key 引用。
- `metrics`：`ticks / commitmentActiveMs / noProgressMs / idleMs / actionsStarted / actionsFailed / commitmentsSucceeded / commitmentsFailed / commitmentsBlocked / deaths / deathsByClass / s0Latency[]`。
- `s0Latency[]` 分段：`detectedAt → decidedAt → preemptAt → effectiveAt`，`totalMs` 是危险可观测到 S0 动作生效的总时长（最近 16 次）。

**空转口径**：没有承诺时安静待命是合法的，不要求巡游；`noProgressMs / commitmentActiveMs` 才是有可执行承诺时的无进展比例。

### 4.2 危险记忆

- `death` 是独立 hazard 类别：死亡点半径 4，TTL 60 分钟；同时写入 `deaths/deathsByClass`。
- 所有 hazard 默认 TTL 60 分钟（artifact 可显式给更短/更长）。
- Controller 在非 S0 动作启动前检查 action 的 `args.pos/x,y,z`；目标落在未过期 hazard 内 → `blocked`，诊断 `HAZARD_TARGET`，不依赖 strategy 自觉。

### 4.3 救援与重启

- `p2_rescue` 支持 `force:true`：仅在紧急情况下允许在 controller 动作仍活动时做位置救援；效果类救援不受 `force` 影响。
- `p2_body action=restart`：stop → start 一条命令完成 provider 断线/重启恢复（开发工具）。
- 开发模式下 provider 连续 2 次状态轮询为 disconnected 时，BodyManager 以 `provider-disconnected` fault 自动重启 body（受 autoRestart 预算/退避约束）。

## 5. 状态与事件

`p2_status` 含 `controller`（mode/queueLength/lease/action/decision/decisions/metrics/commitment/strategies/verification/stall/memory/degraded/events）、`watches`、`providerState`。没有 run/guard/confirm 字段。

事件类型（`controller.events`）：策略安装/接管、action start/complete/preempt、承诺创建/挂起/恢复/成功/失败/blocked、control-fault、strategy-blocked。

## 6. Watch

`watch.add {queries, predicate, edge?, cooldownMs?, ttlMs?}`；`predicate` 是已 check 的 policy artifactId。watch 只通过 `p2_events` 通知并唤醒 owner，不能控制。

## 7. 错误

- 协议：`UNKNOWN_METHOD`、`NOT_INITIALIZED`、`STALE_EPOCH`、`INVALID_MESSAGE`、`COMMAND_NOT_FOUND`。
- 控制：`CONTROL_FAULT`、`LEASE_*`、`COMMITMENT_*`、`STRATEGY_*`、`ACT_*`、`OP_*`。
- `blocked.reason`：`EVIDENCE_TIMEOUT`、`REVERIFY_TIMEOUT`、`MISSING_OBSERVATION`、`STRATEGY_BLOCKED`、`RELEASE_UNCONFIRMED`、`EMERGENCY_BLOCKED`、`COMMITMENT_DEADLINE`。
- hazard 否决诊断：`HAZARD_TARGET`（非 S0 动作目标落在未过期 hazard 内）。

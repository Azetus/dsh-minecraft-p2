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
| `controller.install {artifactId, mode?}` | 安装已激活 strategy；同 definition 版本变更走 pending takeover |
| `controller.commit {goal, strategyKey, post, baselineKeys?, checkpoint?}` | 创建承诺；baseline 在 commit 时采样 |
| `controller.cancel {commitmentId?, reason?}` | 取消承诺并撤销其动作 |
| `controller.status` | 完整 `ControllerView` |
| `controller.events {sinceSeq?, limit?}` | 事件游标 |

`post`：`{kind:'count-at-least', factKey, item?, count}` | `{kind:'fact-equals', factKey, value}` | `{kind:'standing'}`。

完成门：`candidate-complete` → cleanup → 收尾后 fresh 证据 → `succeeded`；证据缺失/过期/baseline 未知 → `blocked`，不伪造成功。

## 5. 状态与事件

`p2_status` 含 `controller`（mode/lease/action/decision/commitment/strategies/verification/stall/memory/degraded/events）、`watches`、`providerState`。没有 run/guard/confirm 字段。

事件类型（`controller.events`）：策略安装/接管、action start/complete/preempt、承诺创建/挂起/恢复/成功/失败/blocked、control-fault、strategy-blocked。

## 6. Watch

`watch.add {queries, predicate, edge?, cooldownMs?, ttlMs?}`；`predicate` 是已 check 的 policy artifactId。watch 只通过 `p2_events` 通知并唤醒 owner，不能控制。

## 7. 错误

- 协议：`UNKNOWN_METHOD`、`NOT_INITIALIZED`、`STALE_EPOCH`、`INVALID_MESSAGE`、`COMMAND_NOT_FOUND`。
- 控制：`CONTROL_FAULT`、`LEASE_*`、`COMMITMENT_*`、`STRATEGY_*`、`ACT_*`、`OP_*`。
- `blocked.reason`：`EVIDENCE_TIMEOUT`、`REVERIFY_TIMEOUT`、`MISSING_OBSERVATION`、`STRATEGY_BLOCKED`、`RELEASE_UNCONFIRMED`、`EMERGENCY_BLOCKED`、`COMMITMENT_DEADLINE`。

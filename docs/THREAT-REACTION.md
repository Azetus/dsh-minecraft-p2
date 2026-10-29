# 威胁反应与条件切换（guard v2）

> 状态：**v2 设计定稿，待实现**（2026-10-29）。相对首版的差异：多 guard 并存、条件由“声明查询 + 纯 policy”表达、触发按优先级串行、事件增加 `deferred`。首版 health 单 guard 语义保留为语法糖。

## 1. 问题与目标

body 按周期推进 behavior。威胁出现时，默认要等 owner agent 下一轮观察才能决定；模型回路的反应延迟不足以覆盖必须秒级完成的“停止当前动作、切换到防御/撤离行为”。

目标不是让模型更快，而是把**已经由 agent 授权**的秒级切换从模型回路里拿出来：

```text
agent：授权“低血时切到撤退”“附近有苦力怕时垫高”   （策权归 agent）
Host：按契约采样、求值，并按优先级串行执行已授权的切换（执行器只做已授权的事）
owner：被事件唤醒，决定后续                                （仍由 agent 决策）
```

guard 只解决“预授权自动切换”。**未匹配条件的观测通知是另一项能力**（见 [NOTIFICATIONS.md](NOTIFICATIONS.md)），与 guard 分离，不能复用 guard 条件作为观测过滤器。

## 2. 职责与授权模型

- **agent 工具登记/撤销 guard**；behavior 不能登记、修改或撤销 guard，也不能读取 guard 内部句柄。
- **Host 持有并在自己的调度中采样与求值**，执行已授权的切换；角色控制仍走 behavior → act → operation。
- **guard 不持有 I/O 能力**：它只能使用 Host 代采样的查询结果与纯 policy 做判断，不能提交 op、不能写世界。
- **bridge 负责把 guard 事件唤醒给 owner**，不参与条件求值或切换决策。

### 2.1 授权生命周期

每个 guard 是一次**绑定 owner、body epoch 与目标快照的单次授权**，不是长期策略：

| 事件 | 结果 |
| --- | --- |
| 登记 | 绑定当前 `owner session + body epoch`，分配 `guardId` 与优先级；可同时存在多个 guard（上限见 §10） |
| 替换 | 以同一 `guardId` 提交时原子替换条件/目标并作废旧 attempt |
| behavior 自然完成 | guard 继续有效（body 仍 active、owner 未撤销） |
| body 空闲（无 active run） | guard 继续有效，可从空闲触发目标 |
| 触发尝试 | **该 guard 的授权立即被消费**，不因成功/失败自动重新武装 |
| 撤销 / TTL 到期 / owner stop / body epoch 变化 / 插件卸载 | 该 guard 结束，不再触发 |
| 已启动的 target behavior | 不因原 guard 的 TTL/撤销自动取消；撤销只影响尚未启动的目标 |

“单次触发”仍是 guard 级语义：持续满足条件不等于发生了新事件。owner 若仍需要保护，必须重新登记。

## 3. 提交与撤销接口

```text
p2_guard action=set    guardId?, priority?, condition, target { artifactId, params? }, ttlMs
p2_guard action=clear  guardId? | all          # 只撤销授权，保留当前 behavior
p2_guard action=status                        # 读取 guards 数组与 lastSwitch
```

- `set` 时校验 target 已检查、已启用、未退休；参数快照随 guard 固定，运行中不再重读默认映射。
- `set` 同时校验条件、TTL 与优先级；无效提交不影响已有 guard。
- `clear` 必须在 body active 时可用，**包括没有 active run 的空闲状态**。
- `p2_switch` 保持“立即切换”语义，不隐式携带或清除 guard；人工 stop 结束 body 生命周期时一并清除全部 guard。
- `p2_status` 展示 `guards` 摘要；完整事件由 `p2_events` 按游标读取。

## 4. 条件：声明查询 + 纯 policy

guard 条件不再使用封闭词表，而是声明采样哪些查询、用哪个纯函数判断：

```ts
type GuardCondition =
  | { kind: 'policy'; queries: Array<{ op: string; args?: JsonValue }>; predicate: string /* policy artifactId */ }
  | { kind: 'health'; hpBelow: number }   // 语法糖：查询 health + 内置判断
```

- **查询变量范围等于全部 QueryOp 目录**（health、position、entities、blocks、inventory、statusEffects、time 等）。provider 新增 QueryOp 后 guard 立即可用，不重演词表问题。
- 每个 guard 最多声明 **4 个查询**（见 §10）；超过时 `set` 拒绝。
- 每次评估把样本整理为 `{ samples: { [index]: { status: 'ok' | 'failed' | 'pending', value, meta } }, now }` 传给 policy。
- policy 只能返回布尔（或 `{ fire: boolean, evidence?: JsonValue }`）；它是纯函数，由 runner 执行，不能提交 op。
- 样本新鲜度由 policy 自行检查 `meta.validUntil`；Host 另外在样本已过期时**不触发**并记录原因。
- 查询失败、`unknown`、过期都视为“本次不成立”，保留原因；连续 3 次已完成失败使该 guard 进入 `error`。
- 毒、异常状态、装备耐久、容器内容等都由“查询 + policy”表达，不新增条件类型。

## 5. 求值

- Host 以 **250ms 的 guard 评估节拍**求值；这是 guard 自己的节拍，不改变 Host 既有 tick、停止和收尾周期。
- 每个 guard 单查询在途；全局同时最多 **2 个 guard 的采样流程**在途，按登记序轮转，避免一次评估打满查询通道。
- 每个查询有明确截止时间（初值 1000ms）；超过截止时间按一次**已完成失败**处理并放弃该查询。
- 结果消费时校验采样新鲜度与 guard 是否仍有效；失效 guard 的迟到结果直接丢弃。
- 连续 3 次**已完成且失败**的评估 → 该 guard `error` 并上报；pending 与正常等待不计入。
- 求值只读，不写世界；暂存样本不属于世界副本。

## 6. 触发与切换阶段

条件成立后，guard 进入 `firing`，**授权立即消费**。切换按阶段执行：

1. **停止前预检**：target 仍 enabled、未退休、参数快照有效。
   - 无效：不停止当前 run，记录 `precheck-failed`；不再自动重试。
2. **停止当前 run**：复用现有停止状态机（`accepted → stopping → released | stop-unconfirmed`）。
3. **停止未确认**：不启动 target，记录控制故障；不得声称旧 behavior 正常执行；该 guard 进入 `error`。
4. **释放后交接前复核**：target 在等待期间可能退休/撤销，必须再次校验。
5. **启动 target**：成功记录 `started`、原 runId、新 runId；失败记录实际控制状态，不伪造旧 behavior。

### 6.1 多 guard 的优先级与串行

- 同一时刻只允许一个切换流程（全局 firing 锁）；其余 guard **继续求值但不触发**。
- 多个 guard 同时满足条件时，按 `priority` 高→低、同优先级按登记序选择；其余 guard 记录 `deferred` 事件，**授权不消费**，切换完成后重新评估。
- 已有 pending switch 时，其他 guard 只记录 `deferred`，不叠加停止/启动。
- 撤销/替换 guard 后，该 guard 的旧 attempt 目标不得启动；迟到释放确认只用于清理。
- 用户 `p2_switch` 优先于尚未启动的 guard 目标；被取代的 guard 记录 `suppressed`。
- TTL 到期：尚未启动的目标不再启动；已开始停止/清理的流程继续完成。
- 已启动的 target 不因 guard 撤销/TTL 被取消。

## 7. 事件与通知

- **body 保存有界 guard 事件记录与单调递增 `seq`**（按 body epoch 重置）；保留最近 N 条，超出保留范围的读取报告 gap。
- bridge 按**游标**读取事件、去重并投递，不依赖状态字段猜测中间变化。
- 事件至少包含：`guardId`、`attemptId`、条件实测样本/采样时间、原 runId、目标 artifactId/runId、阶段。
- 阶段：`armed | fired | deferred | precheck-failed | stopping | started | failed | suppressed | cleared | expired | error`。

### 7.1 唤醒 owner

- bridge 读取到 guard 事件后，通过 `ctx.agents.get(ownerSessionId)?.followup(...)` 排入 owner 的下一轮。
- `followup` 只保证入队并唤醒 driver，不保证立即开始处理。
- 同一事件只投递一次；owner 忙时不重复投递；投递失败不影响切换，事件仍保留。
- 状态轮询不得重叠：上一轮未完成前不发起下一轮。

### 7.2 与观测通知的边界

guard 唤醒只发“已被授权的切换发生了什么”。未匹配条件的威胁/状态变化由独立的 watch 机制处理（[NOTIFICATIONS.md](NOTIFICATIONS.md)），两者共享纯 policy 求值引擎，但状态、预算与工具分离。

## 8. 状态字段

```ts
guards: Array<{
  id: string
  priority: number
  state: 'active' | 'firing' | 'fired' | 'deferred' | 'expired' | 'cleared' | 'error'
  condition: GuardCondition
  armedAt: number
  expiresAt: number
  attemptId?: string
  lastError?: P2Error
}>

lastSwitch: {
  guardId: string
  attemptId: string
  reason: string
  targetArtifactId: string
  fromRunId: string | null
  toRunId: string | null
  at: number
  phase: 'precheck-failed' | 'stopping' | 'started' | 'failed' | 'suppressed'
} | null
```

`guards` 是授权摘要；事件流以 body `seq` 为准，不以摘要字段推断历史。

## 9. 失败姿态汇总

| 情况 | 行为 |
| --- | --- |
| 查询 pending | 继续同一查询；不计失败、不触发 |
| 查询 unknown / 过期 / 失败 | 本次不成立；记录原因 |
| 连续 3 次已完成失败 | 该 guard `error`，上报，不触发 |
| 多 guard 同时命中 | 按优先级选一个；其余 `deferred`，授权保留 |
| TTL 到期 | 不启动未启动目标；已启动 target 保留 |
| 撤销 / 替换 | 作废旧 attempt；不启动其目标；保留当前 behavior |
| 停止未确认 | 不启动 target；控制故障；不伪造旧 behavior |
| 停止后 target 启动失败 | 报告实际状态；不声称恢复旧 behavior |
| target 在预检/交接时失效 | 不切换或只完成既有清理；记录失败阶段 |
| 重复触发/并发 | 单切换流程；其余 `deferred` |

## 10. 预算与限制

| 项 | 初值 | 说明 |
| --- | --- | --- |
| 同时存在的 guard | 8 | 超过拒绝；每个 guard 单次授权 |
| 每 guard 查询数 | 4 | 超过拒绝 |
| guard 评估节拍 | 250ms | 单查询在途、1000ms 截止 |
| 并发的 guard 采样流程 | 2 | 按登记序轮转 |
| 条件切换到 target | 评估周期 + 停止收尾 + target 反应 | 不承诺躲苦力怕引信 |
| 唤醒 owner | 轮询间隔 + 入队 | 不承诺立即处理 |

## 11. 非目标

- 多 guard 不是“多套策略”：它们只做预授权切换，不做长期决策。
- guard 不做 AND/OR 组合语法；需要组合时在 policy 内用纯计算表达。
- guard 不替代 rescue、模型判断或观测通知。

## 12. 验收

1. 多 guard 并存：同时满足条件时按优先级只执行一个，其余 `deferred` 且授权保留。
2. `deferred` 的 guard 在切换完成后重新求值，仍满足且未被消费时可再次触发。
3. policy 条件：毒/状态效果等任意 QueryOp 组合可表达；查询失败/过期不触发。
4. 单 guard 连续低血只触发一次；撤销后不再触发。
5. `clear` 在 body 空闲时可用；撤销后旧 pending target 不启动。
6. stop-unconfirmed 不启动 target、不接管、不伪造恢复。
7. 预检失败与停止后启动失败分别记录。
8. 事件游标无丢失/重复；保留区外报告 gap；owner 忙时只入队一次。

# 威胁反应与条件切换

> 状态：**方案，待实现**（2026-10-29）。本文定义 guard 的授权生命周期、单次触发、分阶段切换、查询语义与事件通知。实现顺序见文末验收；当前不包含通用观测通知、多 guard、组合条件或多次触发。

## 1. 问题与目标

body 按周期推进 behavior。威胁出现时，默认要等 owner agent 下一轮观察才能决定；模型回路的反应延迟（约 2.7–4.5s）不足以覆盖必须秒级完成的“停止当前动作、切换到防御/撤离行为”。

目标不是让模型更快，而是把**已经由 agent 授权**的秒级切换从模型回路里拿出来：

```text
agent：授权“低血时切到撤退”        （策权归 agent）
Host：按契约求值并在条件满足时执行切换（执行器只做已授权的事）
owner：被事件唤醒，决定后续         （仍由 agent 决策）
```

guard 只解决“预授权自动切换”。**未匹配条件的观测通知是另一项能力**：例如只登记了低血 guard，附近出现敌人但尚未掉血，owner 如何获知仍属于观测通知阶段，不能与 guard 条件绑定为同一机制。

## 2. 职责与授权模型

- **agent 工具登记/撤销 guard**；behavior 不能直接登记、修改或撤销 guard，也不能读取 guard 的内部句柄。
- **Host 持有并在自己的调度中求值 guard**，执行已授权的切换；角色控制仍走 behavior → act → operation。
- **bridge 负责把 guard 事件唤醒给 owner**，不参与条件求值或切换决策。

### 2.1 授权生命周期

guard 是一次**绑定 owner 与 body epoch 的单次授权**，不是长期策略：

| 事件 | 结果 |
| --- | --- |
| 登记 | 绑定当前 `owner session + body epoch`，记录 `guardId`；同一时刻只允许一个 guard，新登记原子替换旧 guard |
| behavior 自然完成 | guard 继续有效（body 仍 active、owner 未撤销） |
| body 空闲（无 active run） | guard 继续有效，可从空闲触发目标 |
| 触发尝试 | **授权立即被消费**，不因成功/失败自动重新武装 |
| 撤销 / TTL 到期 / owner stop / body epoch 变化 / 插件卸载 | guard 结束，不再触发 |
| 已启动的 target behavior | 不因原 guard 的 TTL/撤销自动取消；撤销只影响尚未启动的目标 |

“单次触发”是首版语义：持续满足条件不等于发生了新事件。owner 若仍需要保护，必须重新登记。

## 3. 提交与撤销接口

guard 使用独立工具，不与立即切换混用：

```text
p2_guard action=set    condition, target { artifactId, params? }, ttlMs
p2_guard action=clear  guardId?          # 保留当前 behavior，只撤销授权
p2_guard action=status                   # 读取当前 guard 摘要
```

- `set` 时校验 target 已检查、已启用、未退休；参数快照随 guard 固定，运行中不再重读默认映射。
- `set` 同时校验条件与 TTL；无效提交不清除已有 guard。
- `clear` 必须在 body active 时可用，**包括没有 active run 的空闲状态**；不能依赖 `behavior.stop` 的空闲错误路径。
- `p2_switch` 保持“立即切换”语义，不隐式携带或清除 guard。人工 stop 结束 body 生命周期时一并清除 guard。
- `p2_status` 同时展示 guard 摘要；详细事件由 `p2_events` 按游标读取。

## 4. 条件词表（首版只实现 health）

| 条件 | 语义 | 首版 |
| --- | --- | --- |
| `health` | 当前绝对生命值低于阈值：`{ hpBelow: number }` | ✅ |
| `hostile` | 半径内静态实体类别匹配：`{ radius, minCount }` | 后续 |
| `inventory` | 指定物品数量低于/达到阈值 | 后续 |
| `time` | 世界时间区间 / 距天黑时间 | 后续 |

- `health` 使用 provider `health` 查询的绝对血量；`health` 为 null、查询失败或无法证明时效时**不触发**，记录原因。
- 首版不实现血量比例、最近 N 秒掉血、条件组合或多条件 AND/OR。
- `hostile` 后续实现时只做**静态实体类别匹配**，不宣称等同真实敌意；优先使用 provider 已有分类，不另行维护一套怪物名称表。
- `inventory`/`time` 涉及数量截断、暂停与时间跳变，延后并单独定义契约。

## 5. 求值

- Host 以 **250ms 的 guard 评估间隔**求值；这是 guard 自己的节拍，不改变 Host 既有 tick、停止和收尾周期。
- 每次评估最多 2 个查询；首版单条件实际使用 1 个。
- 同一时刻最多一个在途查询流程：
  - `pending` 继续 poll 同一查询，不重新发请求，也**不计为一次失败**；
  - 查询有明确截止时间（初值 1000ms）；超过截止时间按一次**已完成失败**处理并放弃该查询；
  - `unknown`、过期、失败都是“本次不成立”，但保留各自原因；
  - 结果消费时校验采样新鲜度与 guard 是否仍有效；失效 guard 的迟到结果直接丢弃。
- 连续 3 次**已完成且失败**的评估 → guard 失效（`error`）并上报；pending 与正常等待不计入。
- 求值只读，不写世界；暂存一次在途查询与采样时间不属于世界副本。

## 6. 触发与切换阶段

条件成立后，guard 进入 `firing`，**授权立即消费**。切换按阶段执行，不能笼统承诺“失败保持原 behavior”：

1. **停止前预检**：target 仍 enabled、未退休、参数快照有效。
   - 无效：不停止当前 run，记录 `switch-failed(precheck)`；guard 记录该次尝试结果，不再自动重试。
2. **停止当前 run**：复用现有停止状态机（`accepted → stopping → released | stop-unconfirmed`）。
3. **停止未确认**：不启动 target，记录控制故障；不得声称旧 behavior 正常执行；guard 进入 `error`，不重试。
4. **释放后交接前复核**：target 在等待期间可能退休/撤销，必须再次校验。
   - 无效：target 不启动；记录“旧行为已停止、目标未启动”，**不得声称恢复了旧 behavior**。
5. **启动 target**：
   - 成功：记录 `started`、原 runId、新 runId；
   - 失败：记录实际控制状态与失败原因，不伪造旧 behavior 仍在运行；
   - body 空闲时无停止阶段，直接执行预检与启动。

### 6.1 撤销与竞争

- 每个登记有独立 `guardId`；每次触发尝试有独立 `attemptId`。事件、查询结果、待切换目标都关联这两个标识。
- 撤销/替换 guard 后，旧 `attemptId` 的 pending 目标不得启动；迟到释放确认只用于清理，不重新启动旧目标。
- 新 `set` 原子替换旧 guard，并作废旧 attempt；`clear` 作废当前 attempt。
- 用户 `p2_switch` 是新的显式指令：可取代尚未启动的 guard 目标；显式指令优先，guard 记录 `suppressed`。
- 已有 pending switch 时，guard 不触发第二次；只记录 suppressed。
- TTL 到期：尚未启动的目标不再启动；已经开始停止/清理的流程继续完成，但不得启动目标。
- 已启动的 target behavior 不因 guard 撤销/TTL 被取消。

## 7. 事件与通知

只比较 `lastSwitch` 等摘要字段会漏掉查询失效、TTL、启动失败和两次轮询间的变化。因此：

- **body 保存有界 guard 事件记录与单调递增 `seq`**（按 body epoch 重置）；保留最近 N 条，超出保留范围的读取报告 gap。
- bridge 按**游标**读取事件、去重并投递，不依赖状态字段猜测中间变化。
- 事件至少包含：
  - `guardId`、`attemptId`；
  - 条件实测值、采样时间；
  - 原 runId（如有）、目标 artifactId/runId；
  - 阶段：`armed | fired | precheck-failed | stopping | started | failed | suppressed | cleared | expired | error`。
- `p2_status` 提供 `guard` 摘要与 `lastSwitch`；`p2_events` 提供带 seq 的完整事件供游标消费。

### 7.1 唤醒 owner

- bridge 读取到 guard 事件后，通过 `ctx.agents.get(ownerSessionId)?.followup({ content, source: { kind: 'p2-guard' } })` 排入 owner 的下一轮。
- `followup` 只保证入队并唤醒 driver，**不保证立即开始处理**；2s/500ms 只是名义轮询间隔，不是响应上限。
- 同一事件只投递一次；owner 忙时不重复投递；投递失败（agent 不存在/已结束）不影响切换，事件仍保留。
- 状态轮询本身不得重叠：上一轮未完成前不发起下一轮，避免乱序覆盖。

### 7.2 与观测通知的边界

guard 唤醒只发“已被授权的切换发生了什么”。**未匹配条件的威胁/状态变化通知不在本阶段**；它需要独立的观测快照与通知契约，不能复用 guard 条件作为观测过滤器。

## 8. 状态字段

```ts
guard: {
  id: string
  state: 'active' | 'firing' | 'fired' | 'expired' | 'cleared' | 'error'
  condition: GuardCondition
  armedAt: number
  expiresAt: number
  attemptId?: string
  lastError?: P2Error
} | null

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

`guard` 是授权摘要；事件流以 body `seq` 为准，不以摘要字段推断历史。

## 9. 失败姿态汇总

| 情况 | 行为 |
| --- | --- |
| 查询 pending | 继续同一查询；不计失败、不触发 |
| 查询 unknown / 过期 / 失败 | 本次不成立；记录原因 |
| 连续 3 次已完成失败 | guard `error`，上报，不触发 |
| TTL 到期 | 不启动未启动目标；已完成启动的 target 保留 |
| 撤销 / 替换 | 作废旧 attempt；不启动其目标；保留当前 behavior |
| 停止未确认 | 不启动 target；控制故障；不伪造旧 behavior |
| 停止后 target 启动失败 | 报告实际状态；不声称恢复旧 behavior |
| target 在预检/交接时失效 | 不切换或只完成既有清理；记录失败阶段 |
| 重复触发/并发 | 单 guard、单 attempt；其余 suppressed |

## 10. 预算与限制

| 路径 | 名义延迟 | 说明 |
| --- | --- | --- |
| guard 评估 | 250ms 间隔 | 单查询在途、1000ms 截止 |
| 条件切换到 target | 评估周期 + 停止收尾（约 0.3–0.8s）+ target 自身反应 | 不承诺躲苦力怕（1.5s 引信） |
| 唤醒 owner | 轮询间隔 + 入队 | 不承诺 owner 立即开始处理 |

guard 是执行器内的预授权机制，不是第二套策略层，也不替代 rescue、模型判断或观测通知。

## 11. 非目标与后续

- 首版仅 health、单 guard、单次触发。
- 后续再评估：hostile 静态类别条件、inventory/time 条件、多 guard、AND/OR 组合、观测通知、苦力怕等紧急规避。
- 多次触发若重新引入，必须定义“响应结束、条件明确观察到 false、再次变 true”的新事件语义；不能只靠 cooldown。

## 12. 首版验收

1. 持续低血只触发一次；不反复停止/重启响应 behavior。
2. `clear` 在 body 空闲且无 active run 时可用；撤销后旧 pending target 不启动。
3. stop-unconfirmed 不启动 target、不接管、不伪造恢复。
4. 预检失败与停止后启动失败分别记录；不声称旧 behavior 仍运行。
5. `pending` 不计失败；超时按一次已完成失败计数；unknown/过期不触发。
6. owner 忙时事件只入队一次、不重复唤醒；游标读取无丢失/重复，保留区外报告 gap。
7. TTL 到期阻止未启动目标；已启动 target 不被取消。
8. 实机 health guard：低血触发撤退并唤醒 owner；撤销后不再触发。

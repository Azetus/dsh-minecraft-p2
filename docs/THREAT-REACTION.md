# 威胁反应与条件切换

> 状态：**方案，待实现**。本文定义"威胁出现时由谁、在多长时间内、做什么"的机制。目标不是让模型更快，而是把必须秒级完成的动作从模型回路里拿出来。

## 1. 问题

body 按周期推进当前 behavior；遇到威胁（掉血、敌对生物接近、背包告急、入夜）时，默认要等 agent 下一轮观察到状态才能决定。实测单轮延迟约 1.7–1.8s（小上下文），加上判断与工具调用，一次像样的反应在 2.7–4.5s 之间；僵尸从出现到打死的窗口约 9–10s，苦力怕引信只有 1.5s。因此：

- **需要模型判断的**：是否进入战斗、逃向哪里、先吃什么；
- **必须在亚秒级完成的**：停止当前动作、切到防御/撤离行为。

结论：反应路径拆成两层——执行器的**条件切换**负责"立刻动"，agent 的**事件通知**负责"随后想清楚"。

## 2. 三层机制

### 2.1 低频轮询（保留）

agent 不必实时盯世界，按固定周期（建议 5–10s）读 `p2_status`；没有事件时这就是唯一的信息来源。轮询只用于常规巡检与决策，不承担秒级反应。

### 2.2 条件切换（执行器内，正式方案）

behavior 启动或运行中可向执行器提交一个 **guard + target**：

```text
switch { guard: GuardSpec, target: BehaviorRef, cooldownMs, maxFires, ttlMs }
```

- 执行器按固定节奏（初值 250ms）评估 guard，每次评估最多 2 个查询，超预算或查询 unknown 一律视为**不成立**（未知永不触发）；
- 成立即执行切换：停止当前 act（按既有收尾规则）→ 启动 target behavior → 记录 `lastSwitch { reason, at, guardId }`；
- `cooldownMs`、`maxFires`、`ttlMs` 三者必填，防止抖动与死循环；达到上限后 guard 自动失效并记录；
- guard 与 switch 是**同一次工具调用**提交的，不单独版本化；修改切换条件即重新提交；
- 切换失败（target 未启用、检查失败、启动超时）→ 保持原 behavior 并按故障上报，不静默重试。

条件词表只开放四类，避免 guard 变成第二套查询语言：

| 条件 | 语义 | 初值 |
| --- | --- | --- |
| `health` | 当前生命值/上限低于阈值，或最近 N 秒掉血超过阈值 | `{ hpBelow: number }` |
| `hostile` | 半径 R 内敌对实体存在/数量达到阈值 | `{ radius: number, minCount: number }` |
| `inventory` | 指定物品数量低于/达到阈值 | `{ item: string, below?: number, atLeast?: number }` |
| `time` | 世界时间进入区间（如入夜）、或距天黑不足 X | `{ nightWithinMs?: number, timeRange?: [number,number] }` |

guard 只读，不写世界、不产生状态变更；评估结果不缓存到世界副本。

### 2.3 通知（唤醒 owner）

切换发生时，执行器**直接唤醒 owner agent**（不需要三分类仲裁）：

- 唤醒消息带最小上下文：`{ event: "guard-fired", guardId, reason, target, at, status 摘要 }`；
- 不走独立分类器；owner 就是唯一决策者，唤醒即决策；
- 唤醒失败（agent 忙、会话不可用）不影响切换本身；事件进入 `p2_status.events` 供下次轮询读取；
- agent 收到后可继续提交新的 switch（例如确认威胁解除后切回采集），新提交覆盖旧 guard。

## 3. 预算

| 路径 | 延迟 | 适用 |
| --- | --- | --- |
| 条件切换 | 一个评估周期 + act 停止收尾（≈0.3–0.8s） | 苦力怕、被围攻、入夜 |
| 直接唤醒 owner | ≈2.7s（小上下文）/ ≈3.5s（大上下文） | 需要判断的威胁 |
| 低频轮询 | 5–10s | 常规巡检 |

苦力怕 1.5s 引信超出条件切换的可靠范围（0.3–0.8s 只是切换本身，target behavior 的反应还要时间）。首版不承诺躲苦力怕；后续可考虑 body 侧的紧急规避（不进模型回路），作为独立评估项。

## 4. 失败姿态

- guard 评估出错、查询失败、超出 2 查询预算 → 本次不成立，记录 `guardError`，不触发切换；
- 连续评估失败达到阈值（如 3 次）→ guard 失效并上报，避免持续无效轮询；
- switch 提交时 target 不存在或未启用 → 拒绝提交（工具调用时报错），不进入运行期才发现；
- 切换中取消、重复触发、ttl 到期并发 → 以执行器单步为准，先到先得，其余记录为 `suppressed`。

## 5. 可观测性

`p2_status` 增加：

- `guard: { id, state: active|fired|expired|error, fires, nextEvalAt }`；
- `lastSwitch: { reason, target, at }`；
- `events`: 有界队列（最近 N 条），含 `guard-fired`、`guard-error`、`switch-failed`。

agent 不需要轮询 guard 状态来做实时反应；这些字段用于事后核对与调试。

## 6. 待定

- guard 与 behavior 生命周期：behavior 结束时 guard 是否随之失效（建议：随 owner behavior 失效，切到新 behavior 需重新提交）；
- 多 guard 并存（如同时监控 health 与 hostile）——首版只允许一个，优先级由提交顺序决定；
- guard 条件是否允许组合（AND/OR）——首版只允许单条件，组合留给后续；
- 与 rescue 通道的关系：rescue 是人工/会话级兜底，guard 是 behavior 级预授权，二者不互相替代。

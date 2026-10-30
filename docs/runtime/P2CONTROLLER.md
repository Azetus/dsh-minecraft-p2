# P2Controller v2（评审修订版）

> 状态：**设计定稿，待实施**（2026-10-30）。已采纳独立评审的七项修正；本文替代 v1。
> 关联：[operation/provider 契约](OP-PROVIDER-CONTRACT.md)、[威胁反应 guard v2](../THREAT-REACTION.md)、[通知 watch](../NOTIFICATIONS.md)、[操作员手册](../OPERATOR-PLAYBOOK.md)、[behavior 契约](../BEHAVIOR.md)、[运行时](../RUNTIME.md)、[Minecraft 接入决策](../MINECRAFT-INTEGRATION-OPTIONS.md)。
> 命名：**P2Controller** = 常驻控制器（唯一动作控制槽 + 承诺/观测/交接）；`runtime` 保留给 body 执行层（`src/body/runtime.ts`），避免撞名。v1 的 "唯一 run" 表述已废弃（见 §3.1）。

## 0. 与 v1 的差异（评审修正）

| # | v1 的说法 | v2 的修正 |
| --- | --- | --- |
| 1 | "同 tick 换分支，不产生 STOP_UNCONFIRMED 窗口" | 删除。换分支 ≠ 旧动作已停止；必须 `撤销权限 → 停止 → 确认释放 → 启动`，且这是 M0 优先项 |
| 2 | Controller 是"唯一 run" | Controller 常驻，**不是 run**；Controller / Commitment / 策略尝试 / Act 四种寿命分开，用 generation 隔离迟到结果 |
| 3 | 前置检查只针对角色当前状态（`not-in-water` 等） | 改为针对**动作后果**（移除支撑、暴露液体、进入无退路空间）；且不可绕过的只有"控制权/授权"约束，具体战术是**可配置策略** |
| 4 | Blackboard 只有一个总 `at`，布尔字段无"未知" | 每个事实带 `known/unknown + sampledAt + validUntil + scope + evidenceId`，并加**有界行动记忆**（危险区域、失败目标、逃生阶段、重试预算） |
| 5 | 固定优先级 + "同层注册顺序，以后再讨论" | 必须区分**选中 / 持续执行 / 退出**；明确 `RUNNING`、`halt`、未知、冲突规则；`STOP_UNCONFIRMED` 属控制故障，不是普通等待 |
| 6 | post 为假 = 任务失败 | 改为 `候选完成 → 收尾确认 → 有效证据 → 成功`；`unknown` 等待有期限；释放未知不得提交成功；区分"拥有"与"新造"（baseline） |
| 7 | 把 `goto`/`craft` 上移，重写导航与合成 | 暂缓。v1 只定**语义接口**（进度、失败证据、期限、停止结论），首个 adapter 可继续使用现有库；算法上移是另一项工作 |

## 1. 问题与归因（修正版）

长跑（132 分钟、98 个 run、5 次死亡；证据见本机 `.m5-runs/longrun-20261030b/`）暴露的问题**不止一类**，不能全部归为"决策权位置"，但**主因是缺少跨任务共享、独立于任务推进位置的本地仲裁与恢复机制**。

| 类别 | 事实 | 归属 |
| --- | --- | --- |
| 反应链 | watch 报出苦力怕（5.5 格）→ 12.5 秒后才登记应急规则 | 紧急响应不能依赖模型临场组织 |
| 任务代码 | `stone-tools` 把已有石剑计入 `made`，只检查 `made.length !== 0` | 完成判定写错（不是 provider 缺校验） |
| 动作契约 | 工作台不可达仍阻塞 20s、`count` 语义不清、停止证据不足 | 动作/契约层 |
| 策略适用性 | 低血时挖坑，不适用于水下/已困 | 策略内容 |
| 仲裁缺失 | 任务执行期间没有共享的"多意图竞争 + 抢占 + 恢复"机制 | **P2Controller 要解决的** |

已修正的事实性表述：

- 当前执行器**支持** act 执行期间继续观测：`ctx.act(..., { async: true })` + `actStop`（`src/core/js-runtime.ts`），body 调度周期 50ms（`src/body/server.ts`）。因此"每一步都必须经过模型"不成立；缺的是**共享仲裁**。
- provider 已有合成产物增量校验（`src/provider/mineflayer.ts`）；"全部缺读回"不成立。
- guard 的 fire→target started ≈336ms 只说明启动事件发生，**不代表撤离生效**；时延必须四段测量（§2）。

## 2. 目标与度量

| 目标 | 度量（采集，不作为承诺） |
| --- | --- |
| 危险响应不经过模型 | `t_detect`（事实可观测→被判定）、`t_decide`、`t_release`（旧动作释放确认）、`t_effective`（新动作生效）四段分布 |
| 不重复进入同一危险 | 同一 hazardId 在 60 分钟内的重复进入次数（目标 0，按实测记录） |
| 承诺可恢复 | 抢占后恢复成功率、恢复前重新核验覆盖率 |
| 没有"假成功" | 完成判定中"证据缺失/过期仍提交成功"的次数（目标 0） |
| 不反复抢占 | 误抢占率（抢占后 10s 内回到原分支且未产生有效保护） |
| 停滞可解释 | `blocked` 时长与原因分类（缺观测/缺能力/控制故障/策略反复失败/等待模型） |
| 解耦 | 更换 provider 时 P2Controller 源码改动行数（目标 0） |

**不统计"空转 <5%"**：无承诺时安静待命是合理的；应统计**有可执行承诺时的无进展时间**，并区分原因。

## 3. 架构

### 3.1 五件套

```text
1) 槽位（固定形状，内容可替换）
   S0 Emergency | S1 Maintenance | S2 Commitment | S3 Standby
2) 动作租约（唯一动作控制槽）
   lease { id, generation, holder, state: granted|revoking|released|unknown }
3) 承诺仓库（Controller 拥有）
   commitment { id, kind, goal, pre, post, deadline, cleanup, resume, baseline, checkpoint }
4) 观测总线（事实 + 有效性）
   fact { value, known, sampledAt, validUntil, scope, evidenceId }
   + coherenceWindow：同一判断使用的字段必须落在 Δ 内
5) 交接状态机（Controller 拥有）
   request → revoke(lease) → stop(act) → confirm(release) → grant(new) → start
   任一步超时 → control-fault（独立状态，不伪装成 wait）
```

硬不变量（不可绕过，属于控制权/授权）：

- **任何动作必须持租约**；无租约的 dispatch 一律拒绝。
- **迟到结果只能对账，不能重新取得控制权**（generation fencing）；死亡、重生、维度变化使旧目标与旧观测失效。
- **唯一动作槽**：同时只有一个动作持有控制权；但槽位状态（任务推进、紧急评估）可以并行更新。

### 3.2 与 guard / watch / behavior 的关系

- **guard API 保留**，内部映射为"向 S0 提交紧急请求"；是否接管由 Controller 的租约仲裁决定，而不是 guard 直接切 run。
- `STOP_UNCONFIRMED` 属**控制故障**：进入 `control-fault`，停止新 dispatch，上报 owner；不得降级为等待。
- **watch/通知不变**；诱因仍是事件，不是轮询。
- 旧 behavior 作为**受控任务策略**接入（当前 JS ctx 没有 `ctx.call`，需要适配层）；被中断后不能默认可恢复。

### 3.3 控制模式互斥

同一 body 一次只能启用一种控制模式（旧执行器模式 / P2Controller 模式）。开发期可并存代码，但**不得同时有两条调度路径**；旧 behavior 接入新模式时必须适配为任务执行者，不能把旧 Host 完整嵌套进来。

## 4. 四份契约（实施前必须先定稿）

### C1 动作交接契约

- 租约状态与转移如上；`revoke` 后必须等到 broker 的释放结论（当前默认含 300ms 静默确认窗口）。
- **停止语义必须被验证**：pathfinder 的 `stop()` 是"到下一个节点才停"，且本地实现先置停止标志即报告 `idle/confirmed`；`craftRepeatedly` 等异步链必须在重试/后续操作前检查取消。凡"账面已取消但实际继续"的路径，必须在 M0 修复或以租约隔离。
- 迟到结果携带 generation：`gen < current` 时只允许对账（记录、清理），不得产生控制效果。
- `t_release` 与 `t_effective` 分开测量；`started` 事件不等于生效。

### C2 承诺与恢复契约

- 承诺字段：`id / kind(task|standing) / goal / pre / post / deadline / cleanup? / resume / baseline / checkpoint`。
- **恢复默认是"重新核验后继续"**，不是回到旧程序位置：
  1. 保留承诺与已确认进度；撤销当前动作权限；
  2. 确认旧动作释放；执行当前环境适用的恢复策略；
  3. 脱险后重新检查位置、材料、目标、危险区域、退路；
  4. 在承诺允许的替代方案内继续；无可行方案 → `blocked` 并上报。
- **被取消的动作可能已产生副作用**（挖掉方块、消耗材料），不得默认重放；回填竖井属于额外补偿工作，不是通用回滚，也不能阻塞紧急逃生。
- `standing`（跟随、驻守）通常没有自然成功终态，只有持续满足/受阻/撤销/结束。

### C3 观测有效性契约

- 每个事实：`value / known|unknown / sampledAt / validUntil / scope / evidenceId`；`unknown` 不得当作 `false`。
- 同时判断的多个事实需满足 `coherenceWindow`；TTL 未过期不代表可以任意拼接。
- **有界行动记忆**（必须留，否则逃生后会再次挖进同一片水）：
  - 最近尝试过的目标与失败原因（有界队列）；
  - 已确认危险的局部区域（hazardId + 区域 + 时间）；
  - 当前逃生阶段与任务检查点；
  - 重试预算、进入/退出危险状态的时间。
- 不建全量世界模型，不做地图记忆。

### C4 完成判定契约

```text
执行 → 候选完成 → 收尾确认（旧动作释放） → 获取有效证据 → 成功
```

- `post=false`：仍未完成（继续/恢复/最终失败）。
- `post=unknown`：等待验证，受验证期限约束。
- 步骤结束且 post 明确不成立：`POSTCONDITION_FAILED`。
- **控制释放未知：不得提交成功。**
- 区分"拥有一把石镐"与"新制作一把石镐"：用 `baseline`（承诺开始时的数量）与操作证据。
- 完成条件属于承诺；任务策略只能提供**候选**，不能自行降低验收标准。

## 5. 策略接口

策略是 agent 可替换的内容；Controller 决定谁取得控制权。策略**不能**启动另一个 run、不能直接取得 provider 控制权、不能在未获租约时产生副作用。

```ts
type StrategyVerdict =
  | { kind: 'idle' }                                              // 不适用
  | { kind: 'unknown'; missing: string[] }                        // 缺观测，不能猜
  | { kind: 'propose'; intent: string; action: ActionRequest }    // 提出下一步动作
  | { kind: 'running'; intent: string; progress?: Progress }      // 仍在推进
  | { kind: 'wait'; until: Condition; deadlineMs: number }
  | { kind: 'recover'; reason: string; leasePriority: 'interrupt' | 'boundary' }
  | { kind: 'candidate-complete'; evidence: EvidenceRef[] }
  | { kind: 'blocked'; missing: string[]; since: number; diagnostics: Diagnostic[] }
```

- **版本**：`strategyVersion` + `attemptId`；跨版本替换默认"重新核验"，只有显式 `compatibleWith` 才迁移内部状态。
- **替换时机**：`boundary`（等动作结束，普通优化）或 `interrupt`（撤销租约，紧急修正）；"已安装"与"已接管"是两次状态变更，都要进事件。

## 6. 槽位、优先级与冲突

| 槽 | 职责 | 举例（内容由策略提供） |
| --- | --- | --- |
| S0 Emergency | 抢占动作，保护生命 | 缺氧、落水、贴脸苦力怕、悬空、着火 |
| S1 Maintenance | 维持生存条件 | 进食、夜间庇护、避光 |
| S2 Commitment | 推进当前承诺 + 局部恢复 | 采矿、建造、跟随、驻守 |
| S3 Standby | 无承诺时的默认状态 | 待命、短距巡游 |

规则：

- **只有动作槽是唯一的**：紧急评估、任务状态推进可以同时进行，未被选中的槽不得产生动作。
- 同层**不引入权重**；冲突按固定顺序 + 显式冲突矩阵：`立即致命（窒息/岩浆/爆炸半径） > 失血/着火 > 被困`；同层按槽序；冲突写入 why。
- 紧急分支有明确**退出条件**，避免阈值附近抖动；紧急条件仍成立但分支不可执行 → `blocked`（不得落回挖矿）。
- `STOP_UNCONFIRMED` → `control-fault`，不是等待。

## 7. 失败与降级

| 情形 | 行为 |
| --- | --- |
| 动作未确认释放 | `control-fault`：停止新 dispatch、上报、等待人工或自动恢复预算 |
| 观测缺失/过期 | 相关策略返回 `unknown`；Controller 走保守分支；超过等待期限 → `blocked`（记录缺什么、多久、做过哪些诊断） |
| capability 缺失 | 相关策略不可选，记录 `degraded:<cap>` 一次（不刷屏）；不猜测替代语义 |
| 连续失败 | 同类 step 连续 3 次失败 → 承诺 `failed`，执行 `cleanup`，上报原因 |
| 死亡/重生/换维度 | 使旧承诺目标、观测、危险记忆按作用域失效；不自动继续原步骤 |

## 8. 可解释性

- 每个决策点记录：`tick / slots 候选 / 选中 / 原因码 / 被拒原因 / 证据引用 / generation`。
- 事件只在**分支变化、失败、受阻、承诺状态变化**时发出；正常重复 tick 合并计数，不逐 tick 唤醒模型。
- 找不到路径等失败必须给**证据**（例如头格/侧邻格被何物阻挡），不得为了"可解释"强行猜原因。

## 9. 与既有系统的关系

| 既有 | 处理 |
| --- | --- |
| broker / runner / artifact / events | 保留；租约与 generation 在其之上新增，不替换账本 |
| `p2_switch` / `p2_stop` | 语义保留；`p2_stop` 的"停止自主行动"与"停止当前承诺"必须是两个明确契约 |
| guard | API 保留，内部映射为 S0 请求 |
| watch | 不变 |
| operation 契约 | M0 前置：typed 契约 + 动作前检查 + 读回；不要求一次改完 |
| 导航/合成 | v2 只定语义接口；首个 adapter 可继续使用现有库；算法上移另立项 |
| behavior 产物 | 作为任务策略接入；当前无 `ctx.call`，需适配层或提供受控调用契约 |

## 10. 里程碑（M0–M3 完成后才做统一实机测试）

| 阶段 | 内容 | 出口条件（fake/单测为主） |
| --- | --- | --- |
| **M0 动作地基** | 动作租约 + 交接 FSM + 释放确认；迟到结果 generation 隔离；修 "stop 后仍可能继续" 的路径 | 停止后不再发出旧操作；未确认释放 → `control-fault`；不产生任何"成功" |
| **M1 骨架闭环** | 四槽骨架 + 观测总线（有效性）+ 承诺仓库（pre/post/baseline/checkpoint）；一个采集任务 + 一个水中逃生策略 | 危险可抢占；承诺 suspended；脱险后重新核验并继续；`blocked` 可解释 |
| **M2 策略替换** | 运行中替换任务策略（boundary / interrupt） | 目标与进度保留；旧版本不再发动作；新版本重新核验后接管 |
| **M3 复用验证** | 第二个任务 + 第二类危险 | 新增内容主要是策略，Controller 核心零改动 |

## 11. 不做（本阶段）

- 完整树编辑语言 / 任意层级热替换 / 通用状态迁移 / 权重系统。
- 世界模型、地图记忆、长期规划、自动任务生成。
- 把 Minecraft 战术（出水、采集、战斗）写进 Controller 核心。
- 导航/合成算法的通用化重写（属另一项工作）。
- 实机长跑（M0–M3 完成后由人类统一安排）。

## 12. 仍待定（实施中确认）

1. 策略代码的沙箱与依赖契约细节（复用现有 behavior 沙箱？独立 artifact 类型？）。
2. `coherenceWindow` 与查询预算的具体数值（需真实服测量，但先给保守默认）。
3. 冲突矩阵是否需要扩展（多危险同时发生时）。
4. `blocked` 的上报阈值与 owner 唤醒策略（避免刷屏与漏报）。
5. 旧 behavior 适配为任务策略的最小契约（是否需要 `ctx.call`）。
6. 指标基线的采集方式（t_release/t_effective 需要 provider 侧配合埋点）。

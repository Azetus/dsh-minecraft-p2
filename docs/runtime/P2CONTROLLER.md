# P2Controller v2（评审修订版）

> 状态：**M0–M4 已实施（M0–M3 fake/单测；M4 body 接线 + strategy artifact；未做本阶段实机验证）**（2026-10-30）。已采纳独立评审的七项修正；本文替代 v1。实现映射见 §13–§14。
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
  - 实现口径：S0 的 `propose | recover | blocked | running` 一律视为"危险在场"并压制 S1–S3；S0 的 `unknown` 不算危险在场（记 `degraded`），否则缺一个观测就会永久冻结任务。危险在场且无可执行动作时，决策原因为 `emergency-blocked`；紧急动作仍在执行时为 `emergency-running`。
- 同槽内不因算法重算而中途换动作：只有更高优先级槽可以抢占；同槽只在其动作结束后的边界推进下一步。
- 重新核验期间只允许 S0 紧急动作 dispatch；S2 的动作要等下一次新鲜观测。
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
| `p2_switch` / `p2_stop` | `p2_switch` 在 Controller 模式下返回 `CONTROL_MODE_CONFLICT`；`p2_stop` 仍只停止 behavior run。"停止自主行动" = `p2_controller action=disable`；"停止当前承诺" = `p2_controller action=cancel`（两个明确契约） |
| guard | API 保留；Controller 模式要求先 `p2_guard clear`（S0 接管紧急抢占前，不允许 guard 与 Controller 竞争） |
| watch | 不变 |
| operation 契约 | M0 前置：typed 契约 + 动作前检查 + 读回；不要求一次改完 |
| 导航/合成 | v2 只定语义接口；首个 adapter 可继续使用现有库；算法上移另立项 |
| behavior 产物 | **不作为 Controller 的策略载体**；behavior 计划废弃，Controller 使用独立 `strategy` artifact（§14） |

## 10. 里程碑（全部完成后才做统一实机测试）

| 阶段 | 内容 | 出口条件（fake/单测为主） |
| --- | --- | --- |
| **M0 动作地基** | 动作租约 + 交接 FSM + 释放确认；迟到结果 generation 隔离；修 "stop 后仍可能继续" 的路径 | 停止后不再发出旧操作；未确认释放 → `control-fault`；不产生任何"成功" |
| **M1 骨架闭环** | 四槽骨架 + 观测总线（有效性）+ 承诺仓库（pre/post/baseline/checkpoint）；一个采集任务 + 一个水中逃生策略 | 危险可抢占；承诺 suspended；脱险后重新核验并继续；`blocked` 可解释 |
| **M2 策略替换** | 运行中替换任务策略（boundary / interrupt） | 目标与进度保留；旧版本不再发动作；新版本重新核验后接管 |
| **M3 复用验证** | 第二个任务 + 第二类危险 | 新增内容主要是策略，Controller 核心零改动 |
| **M4 body 接线** | Controller 进入 body 单控制模式；新增 `strategy` artifact（检查/启用/安装/求值）；bridge `p2_controller` 命令面；death/dimension 失效 | 模式互斥可测；策略 artifact 契约测试；body 命令路由测试 |

## 11. 不做（本阶段）

- 完整树编辑语言 / 任意层级热替换 / 通用状态迁移 / 权重系统。
- 世界模型、地图记忆、长期规划、自动任务生成。
- 把 Minecraft 战术（出水、采集、战斗）写进 Controller 核心。
- 导航/合成算法的通用化重写（属另一项工作）。
- 实机长跑（M0–M3 完成后由人类统一安排）。

## 12. 仍待定（实施中确认）

1. 策略代码的沙箱与依赖契约细节（复用现有 behavior 沙箱？独立 artifact 类型？）。
   - 本期口径：策略载体是独立 `strategy` artifact（§14），在 body 内以 `node:vm` 基线同步求值；迁移隔离 runner 前不承诺安全隔离。agent 现场编写策略已可用，但沙箱强度仍未达隔离 runner 标准。
2. `coherenceWindow` 与查询预算的具体数值（需真实服测量，但先给保守默认）。
   - 本期默认：事实 TTL 500ms、`coherenceWindow` 500ms、观测刷新间隔 100ms；均可在构造参数覆盖，待实测。
3. 冲突矩阵是否需要扩展（多危险同时发生时）。
   - 本期只实现三级类序（lethal > bleeding-fire > trapped）+ 槽序 + 注册序；同级多危险时后者只进候选列表，不产生动作。
4. `blocked` 的上报阈值与 owner 唤醒策略（避免刷屏与漏报）。
   - 本期：`unknown`/`blocked` 持续超过 `unknownDeadlineMs`（默认 3000ms）转 `blocked`；`candidate` 证据等待上限 `verificationTimeoutMs`（默认 2000ms）。owner 唤醒未接线（见 §13.7）。
5. 旧 behavior 适配为任务策略的最小契约（是否需要 `ctx.call`）。
   - 未决；本期策略是原生函数，不包装旧 Host。
6. 指标基线的采集方式（t_release/t_effective 需要 provider 侧配合埋点）。
   - 未实现；交接事件已记录 `requested/revoked/stop-requested/release-confirmed/granted/started` 时间戳，可在实机时先按这些事件近似四段时延。

## 13. 实现映射（M0–M3）

> 代码：`src/controller/`（provider 无关）。测试：`test/controller-*.test.ts`、`test/provider-stop-release.test.ts`。

### 13.1 动作租约与交接（M0）

| 项 | 实现值 |
| --- | --- |
| 租约状态 `LeaseState` | `none / granted / revoking / released / unknown` |
| 交接阶段 `HandoverPhase` | `idle / revoking / stopping / confirming / granting / starting / active / control-fault` |
| 租约 `LeaseGrant` | `{ leaseId, generation, holder }`；holder 形如 `S2:harvest` |
| 动作请求 `ActionRequest` | `{ act, args, intent, slot, holder, attemptId? }` |
| 动作结果 `ActionOutcome` | `running{progress} / succeeded{result} / failed{error} / cancelled{reason}` |
| 控制端口 `ActuatorPort` | `start(request, grant) / stop(now) / release(now)`；`release` 只报 `released / stopping / unconfirmed` |
| 控制故障码 | `STOP_TIMEOUT`（期限耗尽）、`CONTROL_OUTCOME_UNKNOWN`（无法确认释放 / 启动抛错） |
| 交接期限 | 默认 2000ms，从撤销起算；重复请求不重置 |
| 迟到结果 | `generation < current` 只记 `stale-result` 事件；`classifyResult` 返回 `stale`，不取得控制 |
| fault 恢复 | 只有观察到 `released` 才解除；排队中的 wish 被丢弃，必须重新请求 |

- `startAction` 在无有效租约或 generation/leaseId 不匹配时抛 `LEASE_REQUIRED` / `STALE_CONTROLLER`；"无租约不 dispatch" 是结构性约束，不是调用约定。
- 撤销即 `generation++`；新动作只在新 generation 下启动。启动抛错按"控制结果未知"处理：先停止并等待释放，不重试。

### 13.2 观测总线（M1）

| 项 | 实现值 |
| --- | --- |
| 事实 `Fact` | `{ key, value, known, sampledAt, validUntil, scope, evidenceId, unknownReason? }` |
| `unknownReason` | `missing / expired / invalidated / stale-before-recovery`（多事实不齐时读侧另有 `incoherent`） |
| 多事实读取 `readMany` | 返回 `values / facts / known / unknown / reasons / coherent / coherenceGapMs`；超出窗口的旧样本被移入 `unknown` |
| 新鲜度 | `freshSince` 早于阈值的样本按 `stale-before-recovery` 拒绝（恢复后重新核验） |
| 失效 | `invalidateScope(prefix)` 使作用域内旧事实 `known=false`；空前缀同时清空危险记忆（死亡/重生/换维度） |

- 默认：TTL 500ms、窗口 500ms、刷新 100ms（可覆盖，待实测）。
- 策略读取的事实必须在 `facts` 配置中注册（`{ op, args?, scope?, ttlMs? }`）；未注册/取样失败的事实保持 `unknown`，不会由 Controller 猜测或补默认值。
- `unknown` 不写成 `false`，也不从 `values` 中给默认值；策略必须显式处理 `unknown`。

### 13.3 承诺仓库（M1）

| 项 | 实现值 |
| --- | --- |
| 状态 `CommitmentState` | `active / suspended / verifying / succeeded / failed / blocked / cancelled` |
| 字段 | `id, kind(task|standing), goal, strategyKey, post, state, createdAt, deadline, cleanup?, resume:'reverify', baseline, checkpoint, candidateRejections, evidence[], suspendedAt?, suspendReason?, verifyingSince?, verificationDeadline?, candidateSince?, blocked?, error?, endedAt?` |
| `post` 类型 | `count-at-least{factKey,item,count,fromBaseline?}`、`fact-equals{factKey,value}`、`standing`（无自然成功终态） |
| `baseline` | `{ at, values, evidenceIds, missing[] }`，在 `commit()` 时对 `baselineKeys` 取样 |
| 证据 `EvidenceRef` | `{ factKey, evidenceId, sampledAt, validUntil, scope, value, observed?, required?, baseline? }` |
| 完成判定 | `候选完成 → 槽位空闲且无 fault（收尾确认）→ 新鲜、已知、同窗口证据 → 成功` |
| 失败关闭 | baseline 缺失时 `fromBaseline` 判 `unknown`，等待到期后 `blocked(EVIDENCE_TIMEOUT)`，不提交成功 |
| 拒绝 | 候选被证伪 3 次 → `failed(POSTCONDITION_FAILED)` |
| 默认期限 | 承诺 10 分钟；证据等待 2000ms；重核验 2000ms |

### 13.4 策略与替换（M1/M2）

| 项 | 实现值 |
| --- | --- |
| 判定 `StrategyVerdict` | `idle / unknown / propose / running / wait / recover / candidate-complete / blocked`；`recover` 可带 `action` 与 `hazardClass` |
| 上下文 | `now, slot, phase, attemptId, facts(), memory, commitment?, activeAction?, lastOutcome?, request(), propose(), diagnostic(), saveCheckpoint(), evidence()` |
| 安装 | `install(strategy, 'boundary'|'interrupt')`；同 key 新版本进入 `pending-takeover` / `pending-interrupt` |
| 已安装 ≠ 已接管 | 绑定字段 `installedVersion / activeVersion / attemptId / state`；事件 `strategy-installed / strategy-takeover-pending / strategy-taken-over` |
| boundary | 等当前动作结束（槽位 idle）后接管 |
| interrupt | 立即撤销并停止；丢弃旧 attempt 的排队动作；释放确认后接管 |
| 跨版本 | 默认进入 `verifying`（`freshSince = 接管时刻 + 1`）；仅当新版声明 `compatibleWith` 且 `migrate` 返回状态时才迁移，否则重新核验 |
| attempt 隔离 | 每次接管生成新 `attemptId`；动作结果按 attempt/generation 对账，旧 attempt 不驱动新策略。`lastOutcome` 只属于当前 commitment + 当前 attempt：`commit()` 与策略接管时清空（2026-10-30 实机发现旧结局会卡住新承诺） |

### 13.5 槽位、决策与原因码（M1）

| 原因码 `decision.reason` | 含义 |
| --- | --- |
| `emergency` | S0 危险在场且有可执行动作 |
| `emergency-running` | 紧急动作仍持有租约，压制其他槽 |
| `emergency-blocked` | 危险在场但紧急分支不可执行（不落回任务） |
| `maintenance` | S1 有可执行动作 |
| `commitment` / `commitment-<state>` | S2 推进 / 因承诺状态被压制 |
| `standby` | 无承诺时的 S3 |
| `no-candidate` / `no-selected-slot` | 无可执行动作 |

- 唯一动作槽：同一时刻至多一个动作；S0/S1 可抢占 S2，同槽不中途换动作。
- 重新核验或策略接管期间，非 S0 的 dispatch 被拒绝（记 `degraded:dispatch:verifying` / `dispatch:takeover-pending`）。

### 13.6 有界行动记忆（M1）

`ActionMemory`：危险区域（默认保留 32 条、TTL 10 分钟）、失败目标（16 条）、重试预算（默认窗口 5 分钟）、逃生阶段 `none/escaping/recovering/verifying`。只作决策辅助与诊断，不是世界模型。

### 13.7 与 body 的集成（M4，已完成）

- Controller 已接入 body：`src/body/controller-host.ts`（`BodyController`）把现有 ActPort/QueryPort 适配为 `ActuatorPort`/`SensePort`，body 每 tick 在 Controller 模式下驱动它。
- **控制模式互斥**：`controller.enable` 要求无活动 run 且无 guard；启用后 `p2_switch` 返回 `CONTROL_MODE_CONFLICT`。`controller.disable` 先取消承诺、撤销租约，释放确认后回到 off。
- **命令面**（bridge 工具 `p2_controller`）：`enable / disable / status / install / commit / cancel / events`。`p2_status.controller` 返回同一份视图，`controller.events` 按 `seq` 游标读取。
- **停止语义**：`p2_stop` 仍只停止 behavior run；停止自主行动用 `controller.disable`，停止当前承诺用 `controller.cancel`（§9 的两个契约）。
- **策略载体**：新增 `strategy` artifact（见 §14），不使用/不兼容 behavior；actor 代码在 body 内以 `node:vm` 基线执行（与 JS behavior 相同的隔离基线，不是安全边界）。
- **事实来源**：`position/health/inventory/nearbyBlocks/entities`，默认刷新间隔与 TTL 见 `controller-host.ts`；策略 manifest 只能读取已注册的事实键。`nearbyBlocks` 默认只扫描常见生存资源名，写新策略时按需在 body 配置扩展。
- **失效**：死亡（`providerState.lastDeathAt` 变化）或维度变化时 `invalidateScope('body')`，旧目标与旧观测作废，承诺转 suspended→verifying，不自动继续旧步骤。
- Nav/Crafting 仍不新增算法接口：进度用 `ActionProgress`、失败证据用 `P2Error.details`（例如 `head-blocked@x,y,z`）、期限由 act limits/租约约束、停止结论由 `release` 给出；算法留在 adapter（符合 §5 与 OP 契约的阶段 2）。

### 13.8 错误码（实现值）

| 码 | 归属 |
| --- | --- |
| `LEASE_REQUIRED` | dispatch 无有效租约（新增） |
| `STALE_CONTROLLER` | generation/leaseId/attempt 过期（沿用） |
| `STOP_TIMEOUT`、`CONTROL_OUTCOME_UNKNOWN` | 交接/释放超时或不可确认（沿用） |
| `POSTCONDITION_FAILED` | 候选被证伪 3 次（沿用 C4 语义） |
| `COMMITMENT_DEADLINE` | 承诺自身期限耗尽 |
| `COMMITMENT_BUSY`、`COMMITMENT_NOT_FOUND`、`INVALID_POSTCONDITION` | 承诺仓库参数/状态错误 |
| `STRATEGY_LIMIT`、`STRATEGY_SLOT_MISMATCH`、`STRATEGY_UNAVAILABLE` | 策略安装/槽位/卸载错误 |
| `SENSE_FAILED` | 观测端口抛错 |
| `EVIDENCE_TIMEOUT`、`REVERIFY_TIMEOUT`、`MISSING_OBSERVATION`、`STRATEGY_BLOCKED`、`RELEASE_UNCONFIRMED` | `blocked.reason`（不是 P2Error code） |
| `CONTROL_MODE_CONFLICT`、`CONTROL_MODE_BUSY`、`CONTROLLER_UNAVAILABLE`、`CONTROLLER_DISABLED` | body 控制模式与命令门禁 |
| `STRATEGY_NOT_ACTIVATED`、`STRATEGY_NOT_INSTALLED`、`STRATEGY_FACT_UNKNOWN`、`FACT_NOT_REGISTERED`、`INVALID_COMMITMENT` | 策略产物/承诺参数错误 |
| `STRATEGY_LOAD_FAILED`、`STRATEGY_EVAL_FAILED`、`STRATEGY_TIMEOUT`、`STRATEGY_ASYNC`、`INVALID_STRATEGY_VERDICT`、`ACT_UNDECLARED`、`ACT_NOT_RESOLVED`、`EVIDENCE_UNDECLARED` | 策略装载/求值失败（失败关闭） |

## 14. strategy artifact（策略载体）

> 状态：**已实现**（2026-10-30）。策略不复用 behavior，也不与 behavior 兼容；behavior 计划废弃。

### 14.1 形状

策略是**单文件、无 import、同步**的 JS 模块，在顶层调用注入的 `defineStrategy`：

```js
defineStrategy({
  manifest: {
    id: 'stone-harvest',        // definitionId，也是 controller 的 strategyKey
    version: '1',               // 语义版本；跨版本替换默认重新核验
    slot: 'S2',                 // S0 / S1 / S2 / S3
    hazardClass: 'lethal',      // 仅 S0 必填：lethal / bleeding-fire / trapped
    facts: ['position', 'inventory', 'nearbyBlocks'],
    acts: ['dig', 'goto'],      // 声明可提议的 act definitionId；检查期解析为确切 artifactId
    description: '...'          // 可选
  },
  evaluate(ctx) {               // 同步、纯函数；入参和返回值都是 JSON
    return { kind: 'idle' }
  },
})
```

- **入参 `ctx`**：`{ now, slot, phase, attemptId, facts: { values, facts, known, unknown, reasons, coherent, coherenceGapMs }, memory, commitment?, activeAction?, lastOutcome? }`。
- **返回值**（纯 JSON，`checkpoint?` 可附加在任意判定上）：
  - `{ kind: 'idle' }` / `{ kind: 'unknown', missing: string[] }`
  - `{ kind: 'propose', intent, act, args? }` — `act` 必须是 manifest 声明的名字；host 解析为 artifactId 并盖上 slot/holder/attempt。
  - `{ kind: 'running', intent, progress? }` / `{ kind: 'wait', until, deadlineMs }`
  - `{ kind: 'recover', reason, leasePriority: 'interrupt'|'boundary', action? }`
  - `{ kind: 'candidate-complete', evidence: string[] }` — `evidence` 是 manifest.facts 里的**事实键**；host 只接受已知、未过期、同窗口的样本，缺一即 `unknown`。
  - `{ kind: 'blocked', missing, since?, diagnostics: [{ code, message, detail? }] }`
- `checkpoint` 由 host 写入当前承诺的 `checkpoint`；跨版本默认不迁移，除非新版 `compatibleWith` 声明旧版本并实现 `migrate`（见 §13.4）。
- 策略**不能**：import/require、`eval`/`Function`、`process`/`fetch`、async/await、定时器、直接调用 op 或 act、持有任何宿主句柄。违规在检查阶段拒绝（`FORBIDDEN_SYNTAX` / `INVALID_STRATEGY_MANIFEST`）。

### 14.2 生命周期

```text
p2_check artifactKind=strategy  -> artifactId（依赖 act 必须已启用）
p2_activate artifactId          -> strategy 变为 enabled（不安装、不运行）
p2_controller action=install    -> 载入 vm、校验 facts 已注册、安装/替换
p2_controller action=commit     -> 承诺 + baseline
p2_controller action=status|events
p2_controller action=cancel|disable
```

- 安装顺序：`enable` → `install` → `commit`。`enable` 要求无活动 run、无 guard。
- `install` 的替换语义沿用 §13.4（boundary / interrupt，新 attemptId，跨版本重新核验）。
- 求值预算：单次 `evaluate` 默认 20ms（vm timeout）；超时/异常 → 该策略 `blocked`，不产生动作。
- 隔离基线：body 内 `node:vm`，与 JS behavior 相同的“非安全边界”基线；迁移隔离 runner 前不得把 agent 现场编写的策略当作可信隔离执行。

### 14.3 内置策略与事实

内置策略（`src/controller/strategies/`）是内容示例，也可直接用 strategy artifact 重写：

| 策略 | 槽 | 事实 | 说明 |
| --- | --- | --- | --- |
| `harvest` | S2 | position / inventory / nearbyBlocks | 走到目标方块并挖；完成依据是 baseline 之上的产物增量 |
| `water-escape` | S0 (lethal) | position / health | `inWater` + `health.oxygen` 判定，提议逃生 act |
| `creeper-escape` | S0 (lethal) | position / entities | 苦力怕距离 ≤6 时撤离 |
| `follow-owner` | S2 (standing) | position / entities | 跟随玩家；standing 承诺无自然成功终态 |

body 默认事实源：`position/health/inventory/nearbyBlocks/entities`。`nearbyBlocks` 默认只扫描常见生存资源（stone/deepslate/cobblestone/coal_ore/iron_ore/oak_log/birch_log/dirt/sand/gravel）；新策略需要其它方块时，先在 `src/body/controller-host.ts` 的 `DEFAULT_FACT_SOURCES` 扩展。

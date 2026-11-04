# P2Mind：NPC AI 控制结构

> 状态：已实现，并在实机中验证有限 order、计划、树、tracker、driver 与 completion wake。
> 命名：**P2Mind** = P2 的常驻 NPC AI 控制结构；P2 运行时是 bridge + body + provider。
> 当前 order 面：`go / place / dig / equip / use / attack / check / container / craft / build / traverse / hold`。
> 常驻任务不走 order 面：`p2_duty` 启动显式 gather 配额；显式 order/plan 优先并暂停 duty。duty 持久化到 journal 同目录的 `duty.json` v2（baseline/activeMs/pausedMs/jobs），body 重启后只恢复未过期且 identity 匹配的 active duty；终态不复活。
> 默认活动是 base activity：`idle / wandering / escort`，默认 `wandering`，只做 anchor 半径内的局部移动；不持久化，重启回 wandering。`p2_base_activity` 设置，`p2_order {verb:"hold"}` 完全停住。`mind.activity` 报告当前生效层（constant/order/duty/base）。

## 1. 目标

让 agent 控制的角色**像一个有点笨的玩家**：会失败、会重试、会走冤枉路，但始终合法、可恢复、可验收。

| 目标 | 判据 |
|---|---|
| 像玩家 | 只做玩家能做的事；走路不瞬移、一格一格放；空闲会游荡、会发呆 |
| 允许笨 | 单个动作失败是正常状态；失败 1–2 次后重试，超限才上报 |
| 可恢复 | 被打断/重启后从“世界可重建的进度”继续，不从头再来 |
| 可验收 | 每个 order 有独立可复核的终态证据；证据不足不算成功 |
| 可扩展 | 新结构 = 新计划模板；新策略 = 代码树节点；新原语才写 driver/giver |
| 可对话 | 能接收游戏内对话并作出符合身份的回应，且不阻塞身体执行 |
| 解耦接入 | 同一套 AI 可跑在 mineflayer（现在）与自研客户端 mod（将来）上 |

### 1.1 三条不变量

1. **单写者**：任何时刻只有一个 Driver 持有写令牌；令牌不匹配的写操作在端口层被拒绝。
2. **结果三态**：`confirmed` / `refuted` / `insufficient`；`insufficient` 不得被当作成功。
3. **进度可重建**：能从世界重建的进度优先重建；不能重建的（熔炉投料、失败计数、预算、待确认副作用）显式持久化。

## 2. 运行边界

- **Agent**：决定目标、区域、材料与 order；只在 completion wake、危险和偏离时介入。
- **P2Mind**：在 body 内选工作、执行、重试和恢复；不替 Agent 决定战略目标。
- **body**：只通过 ClientPort 与游戏交互；单写者、结果三态、进度可重建。
- **order 面有限**：新增能力优先来自现有原语的组合；确需新原语时才扩展。

## 3. 分层

```
agent ──order(+可选 blueprint 模板)──► OrderStore ──► Planner ──► PlanInstance
                                                                      │
         ┌────────────────────────────────────────────────────────────┘
         │
   常驻树(每tick/10Hz)   主树(事件+3s兜底)   对话管线(chat→order/say)
         └──────────┬───────────────┬──────────────────┬───────────┘
                    ▼               ▼                  ▼
                WorkGiver（选目标 / 选工作项，可转派前置工作）
                    │  Job{driverId,target,params,orderId,workItemId,runId}
                    ▼
                JobTracker（续做 / 切换 / 停止确认 / 迟到围栏）
                    │  写令牌
                    ▼
                Driver（toil 序列）──► ClientPort ──► 游戏
                    │                        │
                    └────────► Verifier ◄────┘（只读观测；需新观测→check Job）
```

| 部件 | 职责 | 形态 | 状态 |
|---|---|---|---|
| OrderStore | 接受/取消/排队；落意图日志 | 代码 + JSONL | 持久化 |
| Planner | order → PlanInstance（选址、材料账、work item），可分片、可取消 | 模板 JSON + 代码 | 无状态 |
| PlanInstance | 冻结布局/区域/材料政策/版本/工作项 | 数据 | 持久化 |
| Registry | predicate / giver / driver 三类注册项 | 代码 + Schema | 启动加载 |
| 常驻树 | 每 tick 的紧急候选 | 代码树 + 求值器 | 无状态 |
| 主树 | 事件点 + 兜底的常规候选 | 代码树 + 求值器 | 无状态 |
| 对话管线 | chat → 意图 → order/replace/cancel/query/say | 代码 | 无状态 |
| BaseActivity | 默认活动（idle/wandering/escort）、anchor、等待原因 | 代码 | 进程内，不持久化 |
| Activity layer | 每 tick 解析生效层与优先级 | 代码 | 无状态 |
| WorkGiver | 扫描并选出一个目标；可返回前置工作或无工作 | 代码 | 无状态 |
| Job | 数据：driverId + target + params + 归属 + runId | 对象 | 一次尝试 |
| JobTracker | 续做、切换、停止确认、迟到围栏、fault | 状态机 | 单例 |
| Driver | 执行一个已定目标；toil 序列；读回确认 | 代码 | 有界 |
| ClientPort | 查询/动作/事件/能力 | 契约 + 适配器 | 单连接 |
| Verifier | 三态验证 | 代码 | 无状态 |

### 3.1 分工原则

- **树只选 giver**：树里不出现坐标、不出现目标、不执行动作。
- **giver 只选目标**：扫描、可达性、优先级、阻塞物转派；返回候选或“无工作”。
- **base.work 只选局部移动**：默认活动，位于 `duty.work` 之下；不挖、不放、不攻击、不生成任务。
- **activity layer 只做调度**：`constant > order/plan > duty > base`；不改变任何任务状态。
- **driver 只执行**：拿到已选定的 target；**不得自己推导目标**；只负责 toil 推进、读回、收尾。
- **tracker 只仲裁**：续做/切换/停止/围栏；不选目标、不执行。

## 4. 核心概念

### 4.1 Order

agent 下达的目标，不是动作。

```jsonc
{
  "id": "ord-7",
  "verb": "build",                // 受限词表
  "params": {},
  "constraints": { "within": { "radius": 48 } },
  "budget": { "maxTicks": 9000, "maxDeaths": 1 },
  "blueprint": { "blocks": [] }   // 可选：最终几何
}
```

- 词表固定（`go / place / dig / equip / use / attack / check / container / craft / build / traverse / hold`）。
- `blueprint` 只给最终几何；选址与可达性由 Planner 处理。
- Order 只能由模型或对话管线产生；**树与 driver 不能创建 order**。

### 4.2 Plan

**PlanInstance** 是冻结的布局与工作项集合：

```jsonc
{
  "planId": "plan-3",
  "orderId": "ord-7",
  "template": "shelter-minimal",
  "templateVersion": 1,
  "origin": { "x": 120, "y": 64, "z": -30 },   // 内空最小角（地板层）
  "size": [3, 2, 3],                            // 内空尺寸，不含墙
  "materialPolicy": {
    "dirt":   { "auto": true, "maxBudgetTicks": 1200 },
    "oak_door": { "auto": false }
  },
  "workItems": [
    { "id": "w1", "kind": "place", "at": [0,0,0], "expected": { "name": "dirt" }, "after": [] },
    { "id": "w2", "kind": "place", "at": [0,1,1], "expected": { "name": "dirt" }, "after": ["w1"] },
    { "id": "w3", "kind": "place", "at": [1,0,2], "expected": { "name": "oak_door", "state": { "half": "lower" } }, "after": ["w2"] }
  ],
  "verify": { "kind": "sealed-room", "min": [0,0,0], "max": [2,1,2] }
}
```

`usable-room` 是 `sealed-room` 的可用性版本：额外接受 `door`/`bed`（相对 `origin`），检查门上下两格、门两侧可站立、室内至少一个可站立格、床旁可站立；失败带 `at/detail`，若该格属于 work item 还带 `workItemId`。

**WorkItem 四态**（由 WorkGiver 每次求值时计算）：

| 态 | 含义 |
|---|---|
| `satisfied` | 期望状态已满足（含状态子集匹配） |
| `executable` | 现在可做：支撑、站位、材料、可达都满足 |
| `blocked(reason)` | `NO_SUPPORT` / `NO_STAND` / `NO_MATERIAL` / `UNREACHABLE` / `CONFLICT` |
| `unknown` | 观测不足（未加载/过期） |

规则：**遍历全部工作项，返回任一 `executable`**；全部 `blocked` 才向上报，绝不因“第一处冲突”堵死其余工作。

**坐标语义**：`origin` = 蓝图几何最小角；`at` = 相对 `origin` 的偏移；`size` = 几何尺寸；门/床等带状态方块用 `expected.state` 子集匹配。

**多格放置（group）**：一个门（lower/upper）或床（foot/head）是**一个** work item：`at/expected` 是锚点（门下半/床脚），`cells[]` 是同一 placement 必须产出的其余格。蓝图必须声明全部两格（床另需 `state.part`），缺第二格在 `parseBlueprint` 阶段即 `DEFINITION_ERROR`；`usable-room` 读回两格并检查 `half`/`part`/`facing`/床头空间。材料账按 placement 计一次，不按格计。

**构建阶段（barrier）**：1 地板（interior 下方）、2 下层壳（`interior.min.y` 与 +1）、3 上层壳/屋顶、4 室内家具、5 临时入口（`deferredWorkItems`）。阶段是硬屏障：只有当前阶段可派工，前序阶段未完成不得进入下一阶段。事件：`stage.started/progress/completed/blocked`，`plan.blocked` 负载带 stage、workItemId、target、triedStances、每个 stance 的拒绝原因、最后 job code 与材料账。

**放置站位账本（PlanItemLedger）**：失败按 `(plan, workItem, stance)` 记账，不跨工作项共享；同一 stance 2 次无世界变化 → 失败，最多 3 个 stance，全部失败 → item blocked `NO_PLACE_STANCE`；世界指纹（目标格 + 六邻）变化或阶段切换时自动重评。`executable place` 也走同一账本，driver 逐个 stance 移动→放置，只有读回一致才算成功；`moveTo arrived` 不算放置成功。未知格先定向重读；仍未知则 item blocked `UNKNOWN`，不再用 move 循环。

**暂停语义**：provider 的 server age 停滞是 `suspended`，不是失败。`GAME_PAUSED` 中的动作以 `interrupted/SUSPENDED` 收尾（不计重试、不 blocked），order/plan 保持 active，watchdog 与墙钟预算冻结；恢复后强制重观测再继续。超长暂停只通知，不自动 blocked。provider 记录 age 变化、`update_time` 包数与事件循环延迟，给出 `server-paused | client-stalled | event-loop-blocked | unknown` 判定。

**材料账**：初始账 − 已消耗 + 已拾取 + 已有建筑抵扣，运行时重算；每次消耗写意图日志。

### 4.3 树

两棵树，求值时机不同：

| 树 | 时机 | 预算 |
|---|---|---|
| 常驻树 | 廉价谓词每 tick；昂贵谓词 10Hz | ≤2ms/次 |
| 主树 | 事件触发 + 3s 兜底 | ≤10ms/次 |

主树触发事件：新 order / order 取消 / job 终态 / plan 一步完成 / 进入夜晚 / 饥饿跨阈值 / 目标失效 / 冷却到期 / 对话产生 order。base active 时主树保持 hot；giver 自己在 `nextDecisionAt` 前返回 `null`，不每 tick 扫站立格。

节点类型（6 种，定义在 `src/mind/trees.ts`）：

```ts
{ type: 'priority', children: [] }                       // 顺序求值，首个有效候选胜出
{ type: 'sorter',   children: [] }                       // 各自给分，取最高
{ type: 'when',     predicate: 'isNight', onUnknown: 'skip', then: {}, else: {} }
{ type: 'subtree',  ref: 'NightGuard' }
{ type: 'sequence', children: [] }                       // 显式顺序执行
{ type: 'giver',    ref: 'plan.work' }                   // 叶子：引用注册的 WorkGiver
```

- 谓词三态；`unknown` **不得**进入 `else`（节点必须声明 `onUnknown: skip | noCandidate`）。
- 一次求值只用**一份**观测快照。
- 结果五类：`Job / NoWork / Hold / NeedObservation / DefinitionError`，**不折叠成 NoJob**。
- 子树加载期校验：存在、无环、深度 ≤8、节点 ≤500。

### 4.4 WorkGiver

```ts
interface WorkGiver {
  id: string
  score?(ctx: EvalCtx, world: WorldView): number
  find(ctx: EvalCtx, world: WorldView): Candidate | Handoff | Hold | null
}
type Candidate = { driverId: string; target: Target; params: object; keys: string; orderId?: string }
type Handoff   = { driverId: string; target: Target; params: object; reason: string; orderId?: string }
type Hold      = { kind: 'hold'; reason: string; notify?: boolean }
```

- `null` = 让出选择（正常，不记失败）；继续看后续分支。
- `Hold` = 保留意图，不产生 job，停止下降；`notify: false` 用于已知的等待。
- `Handoff` = 先做前置工作（清障 / 补支撑 / 站位），完成后重新 `find`。
- `keys` 是续做键：同一个 `keys` 复活不重启 job。
- 主树顺序：`check → order.* → material.gather → plan.work → duty.work → base.work`；`base.work` 最低，base inactive 时返回 `null`。
- `base.work` 只做 `move`：wandering 在 anchor 半径内选可站格；escort 用玩家名/实体名找目标并选目标附近站位，不 teleport；目标丢失只标记 `TARGET_LOST`。

### 4.5 Job

```ts
type Job = {
  driverId: string
  target?: Target
  params: Record<string, unknown>   // 已过 driver schema
  orderId?: string
  workItemId?: string
  runId: string                     // 本次尝试身份
  issuedAt: number
  budget: { maxTicks: number; maxWallMs: number }
}
```

- **粒度**：一个格子 / 一次合成 / 一次交互；同类连续格子可合并为 ≤4 格的 slice。
- **双时钟预算**：游戏 tick 与单调墙钟都要有；连接停滞时墙钟必须能触发。
- **失败计数键** = `(orderId|workItemId|driverId)`，不是 jobId。

### 4.6 JobTracker

```
idle ─offer(candidate)─► starting ─► running ─terminal─► idle
running ─preempt─► stopping ─stopped─► idle（或处理 pending 候选）
stopping ─timeout/unconfirmed─► fault（冻结新 dispatch，上报）
fault ─人工/自愈─► idle
```

职责：

1. 持有当前实例与身份（`runId`）；树只交候选；
2. **续做判定**：`candidate.keys === current.continuationKey()` → 只续期，不重启；
3. **撤销旧实例写权限**：`seq++` 使旧令牌失效；
4. **请求停止并等待** `stopStatus()`；超时或不可确认 → `fault`；
5. **只接受当前 runId 的结果**；迟到结果只记 `stale-result`。

### 4.7 Driver

```ts
interface Driver {
  id: string
  schema: JSONSchema
  defaults: { budget: Budget; interrupt: 'constant-only' | 'never' | 'any'; suspendable: boolean }
  validate(job: Job, world: WorldView): { ok: true } | { ok: false; code: string }
  start(job: Job, ctx: DriverCtx): DriverHandle
}
interface DriverHandle {
  tick(): void
  requestStop(): void
  stopStatus(): 'stopping' | 'stopped' | 'unconfirmed'
  result(): { state: 'running' | 'succeeded' | 'failed' | 'interrupted'; code?: string; observed?: unknown }
  continuationKey(): string
}
```

#### 4.7.1 结果语义（driver 边界）

三层语义必须分开：

| 层 | 成功含义 |
|---|---|
| `ClientPort` / provider | `ActResult.state='ok'` 只表示动作效果被观测到（或服务端接受），是证据，不是 order 完成 |
| Driver | `DriverResult.state='succeeded'` 表示该 verb 的可验证后置条件已成立；`failed` 表示无法确认结果 |
| JobTracker / metrics | 只把 driver 的 `succeeded` 计为 job/order 完成 |

`failed` 不是“动作未执行”的同义词：动作可能已经生效（方块挖掉、合成已产出、放置已被接受），但完整后置条件没有达成，或效果未知。driver 必须保留同一份 `observed` 证据（如 `partial`、`dug`、`crafted`、`effect`、`pathStatus`），并在需要时用 `failure` 说明“卡在哪、为什么”。Verifier 的 `confirmed / refuted / insufficient` 是独立的只读验证轴，不与 driver 的 `succeeded / failed` 混用。

每个 driver 的 `succeeded` 判据见 [CONTRACTS.md §5](../CONTRACTS.md#5-driver)。

toil 规范（每个 driver 3–8 个）：`ensureItem → moveTo → act → readback → progress`。

**读回要求**：`place` 读目标方块两次（间隔 200ms）；`dig` 读空气，`harvest` 还走到掉落物处并读背包增量；`craft` 读背包增量；`smelt` 读输出槽。读回是**稳定性观察**，不是“服务端已接受”的证明；需要强证据时走独立观测路径。

### 4.8 Verifier

- 结果三态：`confirmed` / `refuted` / `insufficient`。
- 只读已有观测；需要新观测（开熔炉、看箱子）时**发 `check` Job**，不抢交互能力。
- 三级检查（job 读回 / plan verify / order post）**不是三个独立证据源**，除非观测路径确实不同。

## 5. 运行循环

```
每 tick (50ms):
  obs = sensors.tick(budget ≤ 2ms)                    // 缓存维护，不做网络查询
  layer = resolveActivityLayer(obs, order, plan, duty, constant)
  constant = constantTree.evaluate(obs)
  if (constant 是 job) tracker.offer(constant)        // 本轮不再求值主树
  else if (constant 是 need-observation / definition-error) 本轮不再求值主树
  else if (mainTreeDirty || 3s 兜底 || baseActive) { mainTreeDirty = false; tracker.offer(mainTree.evaluate(obs, orders, plan, layer)) }
  tracker.tick()
  if (tracker.idle() && 无候选) base.activate/current layer
```

- 观测由常驻传感器维护；昂贵判断分批推进，**禁止在 tick 内同步扫世界**。
- 常驻树本轮有结果时，主树不参与候选竞争，也不能用 `nowork` 清空 `pending`；紧急解除后主树恢复。
- 主树求值只是“标记待评估 + 在 tracker 里按中断政策处理”，不保证换 job。

## 6. 证据与持久化

| 日志 | 内容 | 恢复时 |
|---|---|---|
| 意图日志（JSONL + fsync） | order 接受/取消、plan 实例化/版本、workItem 终态、pending 动作 | **用于恢复** |
| 诊断日志（best effort） | job / progress / 偏差 / 耗时 | 只读，不参与恢复 |

恢复语义：

1. 尾部半行丢弃；
2. `pending` 动作**只对账、不重放**；对账需要观测时发 `check` Job；
3. 已取消的 order 恢复后保持取消，其 plan 不复活；
4. 校验 `worldId / characterId / templateVersion / defVersion`，不匹配则拒绝恢复并上报；
5. 能从世界重建的（已建的墙）优先重建；不能的（投料、已合成未记账、睡眠历史、失败计数、预算）显式持久化。

## 7. 对话

```
chat → 归一化 → 意图路由：
  replace / cancel（"来 / 别动 / 停"）  → 立即作用于 order 队列，不走队尾
  query（"在干嘛 / 有多少木头"）        → 读 reportString / 背包，直接 say，不产 order
  new order（"建个房子 / 去挖铁"）      → 校验 → 入队 → say("收到，排队了")
  未知                                  → 唤醒 agent（utterance + 摘要）
```

- `say` 走**独立限流通道**（≤1 条/3s），不受写令牌约束。
- 对话只能产 order 或 say，**不能绕过树、giver、tracker**。
- 权限：`who`（owner / 他人 / 系统）→ 可下哪些 order、可否取消他人 order。
- 不靠关键词拒绝 `/`；靠“可调用动作集合”从机制上禁止命令。

## 8. 接入（ClientPort）

```
ClientPort（纯数据，版本化，能力协商）
  ├─ MineflayerAdapter（进程内，现在）
  └─ ModAdapter（WebSocket，将来）
```

- 四类：`query / act / event / capabilities`；不传库对象（`Vec3/Block/Recipe/Goal`）。
- 能力是行为契约（`navigate / interact / observe.screen`），不是实现名（不绑定具体导航库）。
- 一致性测试：一套 20 场景，两个适配器都要通过；这是“换接入”的验收标准。

## 9. 扩展点

| 要加什么 | 改哪里 | 谁写 |
|---|---|---|
| 新建筑/结构 | plan 模板 JSON | 模型 |
| 新选择策略 | 代码树节点（`src/mind/trees.ts`） | 模型/开发 |
| 新目标选择方式 | 新 WorkGiver（代码 + 注册） | 模型写、平台校验 |
| 新动作机制（mod 方块） | 新 Driver（代码 + schema） | 模型写、平台校验 |

红线：树节点只描述选择结构，不写坐标、目标或执行动作；谓词与 giver 是**注册表**，树只能引用已注册项。

## 10. 当前验收

- ClientPort 一致性场景、树/模板校验、核心单元测试全部通过。
- 实机验证：有限 order、建造/放置、熔炉与容器、羊毛/床/门/火把、completion wake、body 重启恢复。
- 长跑验收以安全环境下的 CP 组合与暂停点为准，不把单测或类型检查称作游戏验收。

## 11. 不做与风险

**不做**：通用行为树/IR 解释器；树里写坐标；driver 自选目标；Verifier 抢交互；按 jobId 计失败；双运行时控制路径；最优路径/最优顺序。

| 风险 | 缓解 |
|---|---|
| 常驻树拖慢循环 | 廉价谓词每 tick，昂贵判断 10Hz；观测缓存不做网络查询 |
| WorkGiver 扫描过重 | 扫描分片 + `maxScan` 预算；超预算返回 `NeedObservation` |
| driver 停止不可确认 | 写令牌 + `stopStatus` + fault 冻结；“1s”只是测量指标 |
| 选址失败率高 | 模板多变体（flat/slope/dig-in）；失败即 blocked 唤醒 |
| 对话成为第二控制路径 | 只产 order；走同一校验器；`say` 独立通道 |
| 换 mod 返工 | ClientPort 行为契约 + capabilities + 双跑一致性测试 |

## 12. 术语

| P2Mind | 通用概念 | 说明 |
|---|---|---|
| Order | —（玩家/任务） | agent 的目标 |
| PlanInstance + WorkItem | Blueprint / Frame | 冻结的布局与待完成工作 |
| 树 / predicate | ThinkTree / ThinkNode | 只做选择 |
| WorkGiver | JobGiver / WorkGiver | 选目标、可转派前置工作 |
| Job | Job | 一次有界尝试 |
| Driver + toil | JobDriver / Toil | 执行 |
| JobTracker | Job 调度器 | 续做/切换/停止/围栏 |
| BaseActivity | Idle / Wander / Follow | 默认活动与 anchor |
| Activity layer | 调度优先级 | constant / order / duty / base |
| ClientPort | —（游戏本体） | 接入 |
| Verifier | —（游戏内施工反馈） | 目标级验证 |

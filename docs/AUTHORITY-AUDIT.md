# 现有 giver 的决策权审计

> 审计依据：[AUTHORITY.md](AUTHORITY.md)。审计对象：`dev` @ `4cead0d`（代码基线 `827c994`；`4cead0d` 仅文档变更）的 `createMind` 注册 giver、两棵树，以及决定 giver 决策是否被执行的 loop / tracker / order 终态归因。
>
> 本审计是 `4cead0d` 时点快照。F1 把树定义代码化后，文中 `content/trees` 链接会失效；以审计时点为准，不在审计里追改代码结构。
>
> **当前契约以 [AUTHORITY.md](AUTHORITY.md) 为准。** 本文是历史审计，不是当前实现审计；当前代码已修复/改写其中多项 P0/P1，不要按本文做开发依据。
>
> 方法：静态对照源码与文档，未运行游戏、未跑长测、未跑 `npm run check`。driver/provider 只在影响决策权时提及，不做完整实现审计。

## 1. 结论

**giver 层本身守住了主要边界：没有任何 giver 创建新 order/duty，也没有 giver 从世界事实凭空生成长期目标。** 现有 giver 只从三类来源选目标：

- 当前 active order；
- active build order 的 plan / material policy；
- 已登记的紧急反应（`escape`）。

问题不在“giver 自己长出了任务”，而在它周围的**调度语义、任务终态和能力闭环**：

1. **P0：常驻树候选会被主树覆盖/清空。** 设计说“常驻树出紧急工作时，本轮不再让主树竞争”，代码没有执行这条。
2. **P0：没有 `hold`。** 受阻、目标丢失、无资源都被压成 `nowork`，树会继续落到后面的分支。
3. **P0/P1：原始 order 第一次 job 失败就结束 order。** 绕过“3 次失败才 blocked”的约定，迫使 Agent 重新下单，直接制造微操。
4. **P1：没有任务来源归属。** `Candidate`/`Job` 不带 orderId/source，duty 与 order 并存时会错归因。
5. **P1：能力缺口把 Agent 拉回方法层。** 工具选择、长距离分段、拾取、区域扫描、熔炼组合仍要 Agent 拼。
6. **P1：没有 duty 来源。** `material.gather` 只服务 active build order，不是常驻职责。
7. **P2：覆盖与文档缺口。** `escape` 覆盖不全；v1 自理规则未实现；`combat` 文档与实际 order 面不一致。

## 2. 总表

| giver | 树 | 任务来源 | 选什么 | 结论 |
|---|---|---|---|---|
| `escape` | 常驻 | 已登记紧急反应 | 安全格 | 保留；覆盖不足，且会被主树覆盖（P0） |
| `check` | 主 | `check` order | 容器/熔炉坐标 | 保留；缺 approach，Agent 要先 `go`（P1） |
| `order.go` | 主 | `go` order | 坐标 | 保留；长距离不分段（P1） |
| `order.attack` | 主 | `attack` order | 指定 entity | 保留；目标丢失会静默停住，且只攻击一次（P1） |
| `order.dig` | 主 | `dig` order | 坐标 | 保留；无工具/可收获性/approach（P1） |
| `order.container` | 主 | `container` order | 容器 + 动作 | 保留；一次转移，熔炼组合仍由 Agent 拼（P1） |
| `order.place` | 主 | `place` order | 坐标 + 方块 | 保留；driver 已处理 approach/equip/选面 |
| `order.equip` | 主 | `equip` order | 物品 | 保留；它的存在暴露了 dig/clear 的工具缺口（P1） |
| `order.use` | 主 | `use` order | 方块/物品 | 保留；driver 已处理 approach；`self.eat` 未实现（P2） |
| `order.craft` | 主 | `craft` order | 配方 | 保留；无 approach，agent 要先到工作台（P1） |
| `order.traverse` | 主 | `traverse` order | 桥/垫脚 | OK；显式授权，不自主搭桥 |
| `build` | 主 | `build` order | 最终几何 | 没有独立 giver；由 `plan.work` + `material.gather` 承担 |
| `plan.work` | 主 | build order 的 plan | 工作项 | 保留；全 blocked 返回 null，无 `hold`（P0） |
| `material.gather` | 主 | build order 的 auto-gather | 源方块 | 保留为 build 前置；不是 duty（P1） |
| `order.hold` | 缺失 | `hold` order | — | **缺口：hold order 是死词**（P1） |

## 3. 逐个审计

### 3.1 `escape`

- 树位置：常驻树，唯一 giver（[constant.json](../content/trees/constant.json)）。
- 来源：已登记紧急反应（岩浆、深水、6 格内敌对）；不读 order（[escape.ts](../src/mind/givers/escape.ts#L13-L45)）。
- 决策：选安全格/掩体，保留目标 3 秒防抖；不攻击、不创建任务。符合 AUTHORITY 对紧急反应的限定。
- 问题：
  - 覆盖不全：没有燃烧、窒息、坠落、低 health（无敌人）的检测；v1 `self.retreat` 尚未实现。
  - 没有安全目标时返回 `null`，主树仍会继续；紧急反应没有“停住并上报”的表达。
  - 会被主树覆盖（见 5.1）。

### 3.2 `check`

- 树位置：主树第一位（[main.json](../content/trees/main.json)）。
- 来源：active `check` order；`checkPosition` 校验坐标（[check.ts](../src/mind/givers/check.ts#L8-L36)）。
- 决策：只选 order 指定坐标；打开容器/熔炉是 `check` driver 的职责，Verifier 不抢交互。
- 问题：`check` driver 不移动（[check.ts](../src/mind/drivers/check.ts#L50-L60)）；目标不在交互距离时 job 失败，Agent 必须先 `go`。这是可达性闭环缺口，不是越界。

### 3.3 `order.go`

- 树位置：主树。
- 来源：active `go` order。
- 决策：用 order 坐标、`range:1`、30s、`approach`；`hazards` 从 order policy 传入（[orders.ts](../src/mind/givers/orders.ts#L25-L48)）。
- 问题：30s 墙钟 + 单次 `moveTo`；165 格目标直接 `BUDGET_EXCEEDED`，Agent 只能人工路点（[move.ts](../src/mind/drivers/move.ts#L65-L69)）。按 AUTHORITY §2，长距离分段属于 P2 方法权；当前实现迫使 Agent 做方法决策，属于能力缺口。

### 3.4 `order.attack`

- 树位置：主树。
- 来源：active `attack` order 的 `entityId`。
- 决策：只在 32 格内找同名 entity；玩家/被动生物需要 `allowPassive`；**不换目标**（[combat.ts](../src/mind/givers/combat.ts#L21-L48)）。
- 问题：
  - 目标不在 32 格内、未加载、被保护或 `allowPassive` 未给时，giver 返回 `null`；order 仍然 active，没有 job、没有终态、没有 wake。任务会静默停住。
  - driver 只做一次接近 + 一次攻击；目标移动后重新定位一次，但没有持续追踪/连续攻击（[attack.ts](../src/mind/drivers/attack.ts#L53-L90)）。这是执行闭环缺口，不是选目标越界。

### 3.5 `order.dig`

- 树位置：主树。
- 来源：active `dig` order 的坐标。
- 决策：只选 order 指定方块；不换目标（[dig.ts](../src/mind/givers/dig.ts#L15-L31)）。
- 问题：
  - 没有工具选择/可收获性检查：错工具会表现为 `BUDGET_EXCEEDED` 或没有产物（[dig.ts](../src/mind/drivers/dig.ts#L47-L52)）。
  - 没有 approach：driver 直接 `port.dig`；目标不在交互距离时失败，Agent 要先 `go`。
  - 没有区分“清掉方块”和“取得产物”。

### 3.6 `order.container`

- 树位置：主树。
- 来源：active `container` order。
- 决策：只选 order 指定的容器、动作、物品、数量（[container.ts](../src/mind/givers/container.ts#L12-L45)）。
- 问题：driver 会移动到容器（[container.ts](../src/mind/drivers/container.ts#L64-L74)），单次转移闭环；但熔炼仍需 Agent 拼 `container/use/check/container`。这是组合能力缺口，不是越界。

### 3.7 `order.place`

- 树位置：主树。
- 来源：active `place` order。
- 决策：只选 order 指定的坐标/方块/face/expectedState（[primitives.ts](../src/mind/givers/primitives.ts#L25-L48)）。
- 闭环：driver 会在 >4.5 格时接近、自动装备目标物品、按面重试、即时读回（[place.ts](../src/mind/drivers/place.ts#L72-L114)）。
- 结论：保留。它没有创建任务，也没有扩大 order 的目标。

### 3.8 `order.equip`

- 树位置：主树。
- 来源：active `equip` order。
- 决策：只选 order 指定物品；driver 校验背包（[equip.ts](../src/mind/drivers/equip.ts#L38-L44)）。
- 问题：它本身没错，但它的存在说明 `dig`/`clear` 还没有把“选合适工具”作为方法闭环；Agent 被迫先下 `equip`。按 AUTHORITY §3.2，这是能力缺口。

### 3.9 `order.use`

- 树位置：主树。
- 来源：active `use` order。
- 决策：只选 order 指定方块/物品；bed 走 sleep，其他方块走 useOn，物品走 equip+useItem（[primitives.ts](../src/mind/givers/primitives.ts#L69-L92)、[use.ts](../src/mind/drivers/use.ts#L50-L80)）。
- 闭环：driver 会移动到目标（床除外）。保留。
- 问题：`self.eat` 尚未实现；低饱腹度仍要 Agent 下 `use`。v1 自理规则只在文档里。

### 3.10 `order.craft`

- 树位置：主树。
- 来源：active `craft` order。
- 决策：只选 order 指定配方/数量；driver 校验背包增量（[craft.ts](../src/mind/drivers/craft.ts#L44-L55)）。
- 问题：driver 不移动到工作台；目标不在交互距离时失败，Agent 要先 `go`。另外，新资源链（找矿→炉→冶炼→工具）仍由 Agent 负责，这符合 AUTHORITY §3.1，不是越界。

### 3.11 `order.traverse`

- 树位置：主树。
- 来源：active `traverse` order。
- 决策：只选 order 指定的 mode/坐标/材料/上限；桥/垫脚都是显式授权（[orders.ts](../src/mind/givers/orders.ts#L50-L79)）。
- 结论：保留。它证明“有世界副作用的方法必须由 Agent 明确授权”这条边界目前是成立的。

### 3.12 `plan.work`

- 树位置：主树。
- 来源：active build order 的 `PlanInstance`；`ctx.plan` 只在该 order 活跃时存在（[plan.ts](../src/mind/givers/plan.ts#L13-L110)）。
- 决策：遍历全部工作项，选 executable；可返回 `move`/`clear` Handoff；跳过 tracker 已 blocked 的键。没有创建新任务。
- 问题：
  - 全部工作项 blocked 时返回 `null`；主树继续落到后面的 giver 或 idle。按 AUTHORITY §3.3，受阻应 `hold`/上报，而不是让出。当前没有 idle giver，所以表现成“站着”，但结构上没有 `hold`。
  - `clear` 工作项依赖 `clear` driver，后者没有工具选择/可收获性检查（[clear.ts](../src/mind/drivers/clear.ts#L48-L65)）。

### 3.13 `material.gather`

- 树位置：主树，`plan.work` 之前。
- 来源：active build order + `policy.materials.mode = auto-gather`；只对 `materials.ts` 声明的来源选方块（[material.ts](../src/mind/givers/material.ts#L14-L73)）。
- 决策：在自身 8 格内找最近来源；远处先 `move` Handoff；返回 `clear` candidate。没有创建新任务，没有超出材料政策。
- 问题：
  - 只扫 8 格；大建筑/远处资源找不到，Agent 需要先 `go` 或改区域。
  - 不选工具；`clear` 用当前手持物挖掘。
  - 不处理拾取；掉落物可能丢失。
  - 它不是 duty：只有 active build order 才运行，不能承担常驻采集。

### 3.14 `order.hold`（缺失）

- `hold` 在 `ORDER_VERBS` 里（[orders.ts](../src/mind/orders.ts#L10-L23)），但 `main.json` 没有 `order.hold`，`createMind` 也没有注册对应 giver（[mind.ts](../src/body/mind.ts#L114-L126)）。
- 结果：`hold` order 会被接受、保持 active，但永远不产生 job；当前只是“碰巧没有其他 giver 匹配”而站着。它不能表达 AUTHORITY §3.3 的“保留意图”，也不能阻止未来 idle/wander 接管。

## 4. 没有发现的问题

- **没有 giver 创建新 order/duty**：所有 giver 只读取 active order/plan 或紧急条件；`OrderStore.enqueue` 只从 `BodyRuntime.mindOrder`（Agent 控制面）进入。这是当前最重要的正向结论。
- **没有 giver 从世界事实生成长期目标**：`escape` 只做即时反应；`plan.work`/`material.gather` 只在已有 build order 内工作。
- **没有 giver 改变任务承诺**：目标、区域、材料政策、完成条件仍由 order/plan 决定；giver 只选目标实例和前置工作。
- **`traverse` 没有被自主化**：桥/垫脚仍是显式 order，符合“世界副作用必须授权”。

## 5. 跨 giver 的结构性问题

### 5.1 P0：常驻树候选会被主树覆盖/清空

`MindLoop.tick` 先把常驻树候选交给 `tracker.offer`，然后只要 tracker 还是 `idle` 就继续求值主树（[loop.ts](../src/mind/loop.ts#L101-L128)）：

- 主树返回 job → `offer(main.candidate)` 覆盖 `pending`；
- 主树返回 `nowork` → `offer(null)` 清空 `pending`；
- build plan 存在时 `hasPlan` 为真，主树**每个 tick**都会求值；非建造期在 `mainDirty` 或 3s 兜底时也会发生。

`tracker.offer` 是直接赋值 `pending`，没有优先级（[tracker.ts](../src/mind/tracker.ts#L123-L137)）。所以在建造期间，`escape` 刚提出的逃生候选可能每个 tick 都被 `plan.work` 覆盖或清空。这直接违反“常驻树出紧急工作时本轮不再让主树竞争”。

**影响**：安全反射可能被主树饿死；至少在结构上，常驻树的优先级目前不是真的。

**修法**（结构层，不是权限层）：loop 增加 `constantHandled`；常驻树返回 job/hold 时，本轮跳过主树求值，也不允许主树 `offer(null)`。

### 5.2 P0：没有 `hold`，受阻会落到后面的分支

`TreeResult` 只有 `job / nowork / need-observation / definition-error`（[tree.ts](../src/mind/tree.ts#L21-L25)）；`priority` 遇到 `nowork` 继续下一个子节点。

因此：

- `plan.work` 全 blocked → `null` → 主树继续；
- `material.gather` 找不到来源 → `null` → 主树继续；
- `order.attack` 目标丢失/被保护 → `null` → 主树继续；
- 未来加 idle/wander 时，这些情况会直接变成“去游荡”。

AUTHORITY §3.3 要求“受阻不换任务”，但当前没有可表达它的结果类型。**修法**：增加 `hold`；`nowork` 表示让出，`hold` 表示保留意图并停止下降。

### 5.3 P0/P1：原始 order 第一次 job 失败就结束 order

`mind.ts` 在 `job.terminal` 时，对 `go/attack/dig/traverse/place/equip/use/craft/container` 直接完成 order：

```text
job.terminal failed → orders.complete(orderId, 'failed')
job.terminal succeeded → orders.complete(orderId, 'succeeded')
```

见 [mind.ts](../src/body/mind.ts#L233-L249)。这绕过了 `JobTracker` 的失败计数与 3 次后 blocked 的约定（[tracker.ts](../src/mind/tracker.ts#L347-L365)），也绕过了 RUNTIME §5 的“≤2 次重试、3 次 blocked”（[RUNTIME.md](RUNTIME.md#L63-L71)）。`check` order 在单独分支里也是首次终态即完成（[mind.ts](../src/body/mind.ts#L221-L232)）。

**影响**：一次瞬态失败就要求 Agent 重新下单；这正是“Agent 反复补命令”的来源。`build` 的 plan 工作项有重试，原始 order 没有。

**需要决定**：原始 order 是“一次性尝试”（则文档要改，并明确 Agent 预期）还是“应该在 order 内重试”（则 mind 不应在第一次 failed 就结束）。不能保留现在的文档/代码不一致。

### 5.4 P1：没有任务来源归属，duty 与 order 会错归因

`Candidate` 只有 `driverId/target/params/keys`（[types.ts](../src/mind/types.ts#L18-L24)）；`Job` 有可选 `orderId`，但 tracker 创建 job 时没有填（[tracker.ts](../src/mind/tracker.ts#L252-L261)）。`mind.ts` 用 `orders.active()` 的 verb 判断该结束哪个 order（[mind.ts](../src/body/mind.ts#L233-L249)）。

在只有一条 active order 时没问题；一旦 duty 和 order 并存，duty 的 job 终态可能结束显式 order。**这是 duty 的前置项，不是当前 giver 的越界。**

### 5.5 P1：能力缺口把 Agent 拉回方法层

AUTHORITY §3.2 要求“任务不变时 P2 闭环”。当前以下环节仍要求 Agent 下方法级命令：

| 缺口 | 证据 | 后果 |
|---|---|---|
| `dig`/`clear` 不选工具、不检查可收获性 | [dig.ts](../src/mind/drivers/dig.ts#L47-L52)、[clear.ts](../src/mind/drivers/clear.ts#L48-L65) | 需先 `equip`；错工具无产物 |
| `dig` 不 approach | [dig.ts](../src/mind/drivers/dig.ts#L47-L52) | 需先 `go` |
| `check` 不 approach | [check.ts](../src/mind/drivers/check.ts#L50-L60) | 需先 `go` |
| `craft` 不 approach | [craft.ts](../src/mind/drivers/craft.ts#L44-L55) | 需先 `go` 到工作台 |
| `go` 30s、不分段 | [move.ts](../src/mind/drivers/move.ts#L65-L69) | 远距离需人工路点 |
| 没有 pickup giver/driver | — | 需人工 `go` 捡掉落 |
| `container` 只做一次转移 | [container.ts](../src/mind/drivers/container.ts#L64-L74) | 熔炼由 Agent 拼四步 |
| 区域扫描只有 6/8 格 | [sensors.ts](../src/mind/sensors.ts#L34-L42)、[material.ts](../src/mind/givers/material.ts#L6-L7) | 大范围采集需 Agent 观测/换区 |

这些不是“giver 抢权”，而是“P2 没闭环”，结果同样是 Agent 被迫微操。它们应在执行闭环专项里补，不需要改 AUTHORITY 原则。

### 5.6 P1：没有 duty 来源

所有现有 giver 的来源是 order、build plan 或紧急反应；没有常驻 duty。`material.gather` 只服务 active build order（[material.ts](../src/mind/givers/material.ts#L17-L22)），不能替代“在区域内持续采集到配额”。

这是下一阶段的功能缺口，不是当前实现的错误；但审计结论应明确：**当前没有 duty，任何“常驻”都还没有候选来源。**

### 5.7 P2：`escape` 覆盖不足，v1 自理规则未实现

`escape` 只处理岩浆、深水、6 格内敌对（[escape.ts](../src/mind/givers/escape.ts#L23-L45)）。AUTHORITY §5 列的 v1 规则：

- `self.eat`：未实现；
- `self.retreat`：只被 `escape` 部分覆盖（敌对近身会撤，但低 health 无敌人不会）；
- `self.unstuck`：未实现。

另外，燃烧、窒息、坠落、低 health 没有常驻检测。这是覆盖缺口，不是职责越界。

### 5.8 P2：文档与 order 面漂移

- `docs/runtime/AGENT-REACTION.md` 给出 `combat` order 与 `allowedTargets` 示例（[AGENT-REACTION.md](runtime/AGENT-REACTION.md#L78-L84)），但 `ORDER_VERBS` 没有 `combat`（[orders.ts](../src/mind/orders.ts#L10-L23)）；实际只有单目标 `attack`。
- `allowPassive` 放在 `attack.params`，`hazards` 放在 `order.policy`；权限字段位置不一致。
- `OPERATOR-PLAYBOOK.md` 里的部分错误码（如 `SITE_NOT_FOUND`、`WORK_ITEM_BLOCKED`）没有在 `CONTRACTS.md` §10 统一列出。
- `main.json` 是扁平 priority，没有显式分组“order 子树 / duty 子树 / idle”；加 duty 时需要重组。

这些不改变当前行为，但会让评审和后续扩展产生歧义。

## 6. 对下一阶段的 gate

在加 duty / 常驻采集之前，审计建议先处理：

1. **P0**：`constantHandled` 门，保证常驻树候选不被主树覆盖。
2. **P0**：`TreeResult.hold`，让 `plan.work`/`material.gather`/`order.attack` 的受阻有明确语义。
3. **P0/P1**：决定原始 order 的失败语义（一次尝试 vs order 内重试），并让 `mind.ts`、`RUNTIME.md`、Agent 提示词一致。
4. **P1**：`Candidate`/`Job` 带任务来源（orderId/dutyId），避免 duty 与 order 错归因。
5. **P1**：`dig`/`clear` 工具与可收获性、`go` 分段、pickup、区域扫描；这些直接决定常驻采集是否成立。
6. **P1**：`order.attack` 目标丢失时阻塞/上报，而不是静默 `null`；持续追踪另行处理。
7. **P2**：`escape` 覆盖与 v1 自理规则；文档漂移。

## 7. 审计边界

- 未审计 driver/provider 的完整行为（导航、放置、容器、物理），只在影响决策权/闭环时引用。
- 未进行真实游戏、DSH、长跑验证；本审计的结论是静态代码与文档对照。
- 未修改代码；本文件只记录审计结果。

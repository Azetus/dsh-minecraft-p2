# P2Mind 补强 Backlog

> 基于 2026-10-31 phantom/雷暴刷怪死亡事件的复盘与职责二分。
> 原则：**Agent 决定“为什么/何时/去哪里”，P2Mind 决定“怎么做/现在是否安全/如何报告”。**
> 本文只记录 **P2Mind 层**的缺陷与补强；Agent 长期策略不在本文范围。
> 状态：`npm run check` 275 passed / 1 skipped。

## 1. 职责边界（判定规则）

- Agent：长期目标、优先级、任务取舍、睡觉、建家、战斗或撤退、装备/后勤、死后恢复、长期记忆。
- P2Mind：观测、路径、动作序列、局部反射、三态验证、危险上报、执行原语。
- P2Mind **不得**自行决定“现在该睡觉/该建家/该战斗/该放弃任务”；它可以执行这些 order，并在局部危险时立即避险、上报。
- 如果 P2Mind 缺少执行原语（例如“走到床边并使用床”），这是 P2Mind 缺陷；如果 Agent 没有下达睡觉/建家/撤退策略，这是 Agent 缺陷。

## 2. P0：先补，直接决定生存与可诊断性

### P0-1 威胁归因：谁刚刚攻击了 P2

- 现状：`damaged` 只带 health；通知要再猜“最近的 hostile”。
- 协议事实：Minecraft 1.20+ `damage_event` 提供
  - `sourceTypeId`
  - `sourceCauseId`（负责实体 +1）
  - `sourceDirectId`（直接来源，如箭 +1）
  - `sourcePosition`（可选）
- Mineflayer 已解析为 `entityHurt(entity, source)`；`entity === bot.entity` 时 `source` 就是攻击者。
- 补强：
  - `ClientPort` 的 `damaged` 携带 `source?: {id,name,position}`、`sourceTypeId`、`sourcePosition`；
  - 投射物场景用 `sourceDirectId` 解析直接来源（必要时 raw packet）；
  - `escape` 朝真实攻击者反向退，而不是“第一个 hostile”；
  - perception/`damaged` 摘要带来源、方向、距离。
- 验收：单测 + 实机 phantom/zombie；来源与实际攻击者一致；环境伤害 `source` 为空但 `sourceTypeId` 可区分。

### P0-2 critical 合并 / 冷却

- 现状：`health 7→4→1→0 + died` 会产生多条 critical steer。
- 补强：
  - 同一伤害级联 1–2s 内只推第一条；
  - death 单独一条；
  - critical 有独立预算，避免刷屏。
- 验收：连续掉血 ≤2 条通知；Agent 仍能看到“死亡”这一条。

### P0-3 环境风险观测

- 现状：只有 `timeOfDay`；雷暴导致地表光照下降，P2 仍按“白天安全”行动。
- 补强：暴露环境快照（按客户端可得性逐步补）：
  - `raining` / `thundering` / `thunderState`；
  - `timeOfDay` / `worldAge`；
  - 屋顶/天空暴露（当前坐标上方是否实心；可扩展到周围）；
  - 光照若客户端/数据层可得则暴露，否则明确 `unknown`，不要猜。
- 验收：雷暴时 Agent 能通过 `p2_observe`/status 看到 `raining/thundering`；能判断“露天/有顶”。

### P0-4 危险通知的内容

- 现状：`hostile-near` 只给名字和坐标；`damaged` 只给 health delta。
- 补强：通知至少包含
  - 威胁数量、类型、方向、距离；
  - 伤害来源（P0-1）；
  - 当前本地 reflex 是否已执行、逃向哪里、是否 `GOTO_NO_PATH`；
  - 当前 order/plan 是否受影响；
  - 天气/屋顶上下文。
- 目标：Agent 收到一条摘要就能决定“继续/撤退/换目标”，不需要再猜。

## 3. P1：反射与执行原语

### P1-1 多威胁 / 3D / 飞行 / 远程

- 现状：`hostilesNear` 取 6 格内第一个；幻翼从上方攻击时逃向开阔地。
- 补强：
  - 3D 距离与上方威胁；
  - 多威胁优先级（近距离/高伤害/飞行/远程）；
  - 远程/投射物来源；
  - 有顶掩体优先（已有初步实现，需验证）；
  - 目标稳定、路径失败后备选，不反复 preempt/start。
- 边界：本地只做**即时**战斗/撤退；是否放弃任务、退到哪个安全点由 Agent。

### P1-2 安全点 / 掩体的执行

- 现状：`home` 是坐标，不是安全屋；Agent 没建家时 P2 没有安全锚点。
- 补强：
  - P2 能执行 Agent 给的“移动到安全点/屋内/床”；
  - 有顶掩体搜索（已有）；
  - 不自行决定建家/选址。
- 验收：给定安全点坐标，P2 能稳定到达并待命；路径失败要上报。

### P1-3 执行原语：sleep / useOn / attack / equip

Agent 可以决定“去睡觉/打它/换武器”，P2 必须能执行：

- `move near target` + `useOn`（床、按钮、门等）；
- `sleep`（床）；
- `attack(entity)`；
- `equip(item)`；
- 每个动作三态、失败原因、被 preempt 的行为。

现状：`sleep`/`attack`/`equip` 在 ClientPort 层有部分能力，但没有完整的 order→giver→driver 路径。这是 P2Mind 缺陷，不是 Agent 策略。

> M4-03 已改为与本节合并：P2 提供 `hold/go/wander/eat/sleep/useOn` 执行原语，
> Agent 决定何时使用；不再自动回家/进食/游荡。

### P1-4 战或逃 / combat ROE（已确认方向）

**默认不攻击。** P2Mind 未收到 Agent 的 combat order 时，不主动攻击任何实体；
被攻击只做“识别来源 → 后撤/找掩体 → 上报”，不自动反击。

- 战或逃的战略判断归 Agent；P2Mind 只执行。
- 攻击判断不下放给 P2Mind。
- 玩家与中立生物归为**同一类受保护目标**：默认永不自动攻击
  （玩家误伤、僵尸猪灵、铁傀儡、狼、蜜蜂等都不能由 P2Mind 自行开战）。
- Agent 的 combat ROE 使用显式 `allowedTargets` 白名单；不在白名单 → `not_authorized`，
  只报告不攻击。
- 即使进入 `defend`/`engage`，也不默认把玩家/中立加入白名单；必须显式授权。
- 模式草案：`avoid | retreat | defend | engage`；
  `defend` 只反击白名单攻击者，`engage` 才主动索敌。
- **暂缓项**：`allowedTargets` 的一对多/多类型协同（多种实体同时靠近时的目标选择）。
  当前计划只保留简单的白名单列表，先不做复杂目标分配；后续再扩展。
- 需要 P2Mind 先具备 P0-1 的威胁归因，否则“被谁打”仍不可靠。

现状：`attack`（显式 entityId）与 `combat`（allowedTargets + radius）执行路径已加入；
玩家/中立受保护；无 Agent 明确 order 不攻击。IMMEDIATE 提示词已改为 FIGHT/FLIGHT 两分支，
见 `docs/runtime/AGENT-REACTION.md`。

## 4. P2：诊断与长期质量

### P2-1 死亡 postmortem

死亡后由 P2 产出结构化报告：

- 死因/ `sourceTypeId` / 攻击者；
- health 时间线（最后几次伤害）；
- 当时威胁列表与位置；
- 当前 order/plan/job；
- 最近路径失败/reflex 状态；
- 丢失物品（如可得）；
- 重生位置。

Agent 用这份报告决定恢复策略；P2 不自动决定捡尸/重装。

### P2-2 职责边界清理

- 现有 M4-03 的“夜间自动回家 / 自动进食 / 自动游荡”部分越过了 Agent/P2Mind 边界。
- 需要逐项判定：
  - 低血/饥饿的**即时**自保可作为局部 reflex；
  - “今晚睡哪、是否建家、是否继续任务”必须是 Agent 策略；
  - 不要把长期策略包装成 idle 行为。
- 这是设计债，不是单纯功能缺失。

### P2-3 Targeting capability（记下点子，不阻塞）

- 原版客户端协议**不下发 mob AI target**；客户端 mod 单独也不能拿到权威 target。
- 现在可用：`damage_event` → 最近攻击者；投射物 owner（raw/后续 mod）。
- 未来可选 ClientPort 能力：

```ts
interface ThreatTargeting {
  threatsTargetingMe(): EntityInfo[]   // confidence: server | heuristic
  entityTarget(entityId: string): string | null
}
```

- 纯客户端 mod：启发式（速度/朝向/距离/最近攻击者），标记 `heuristic`；
- 客户端 + 服务端 mod：权威 target，标记 `server`；
- P2Mind 的 reflex 不能依赖该能力存在；没有时退化为最近攻击者 + 3D 威胁评分。
- 结论：**“谁此刻以 P2 为 AI 目标”拿不到就算了；记录为未来接口。**

## 5. Agent 侧（不在本文补强范围）

以下问题由 Agent 的指南/系统提示词/SKILL/记忆解决，不应内建到 P2：

- 什么时候睡觉、床在哪、如何回床；
- 是否建安全屋、选址、材料、照明；
- 雷暴/夜晚是否继续任务、是否撤回；
- 战斗还是逃跑、是否放弃当前 order；
- 出门装备、武器/护甲、补给；
- 死亡后是否捡尸、重装、回基地；
- 长期记忆（memo/session）；
- 持续监控与风险取舍。

## 6. 仍待验收的 M4 项

- M4-02：容器/熔炉实机 check（当前区域无容器，仅单测）。
- M4-03：夜间 30 分钟零死亡/零方块变化（代码已有，长跑未做）。

## 7. 不做

- 不把 sleep/建家/战斗决策内建到 P2Mind；
- 不做全量世界事件追踪；世界变化留在观测层/Verifier；
- 不让 Agent 的安全依赖“永远在线”；
- 不依赖 AI target 才能做 reflex；
- 不用 critical 刷屏代替分级通知。

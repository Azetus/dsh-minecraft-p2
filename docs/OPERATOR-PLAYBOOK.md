# P2 运行手册（P2Mind）

> 目标是让角色像一个有点笨的玩家：Agent 决定目标，P2Mind 自己干活；Agent 只在中断/偏离时介入。
> 运行时操作以插件内置 `skills/p2-operator/SKILL.md` 为准（body 启动时注册给 owner session）；本文保留为运行参考，不自动注入。

## 1. 启动

1. 人类：`/p2 setup` → `/p2 start <host>:<port>`（例如 `/p2 start 127.0.0.1:25575`）；也可以使用 `p2_body {action:"start", host, port}`。连接目标只在启动/重启参数里给，不写 `.p2/config.json`。`p2 start` 会先创建 `.p2` 工作区：缺失的 persona/config/skills/memory 说明从 `content/templates/` 复制，已有文件绝不覆盖。
2. `p2_status`：确认 `target`、`connection=connected`、`bodyEpoch` 非空、owner 是本 session。若 `locks` 显示该 target 已被别的 session/进程占用，`/p2 start` 会直接拒绝；先让 owner `/p2 stop`，不要重复启动抢 username。
3. `p2_observe`：确认进服、维度、位置与周围方块。找方块用 `p2_observe {mode:"find", only:["crafting_table"], radius:16}`；find 只返回已加载方块，不判断可达、不移动，拿到坐标后先 `go` 再 `craft`/`dig`。`blocks`/`find` 条目会带 `light`/`skyLight`（0–15，未知省略），可用来判断隧道/避难所是否需要火把。

## 2. 下 order

```text
p2_observe {mode:"find", only:["crafting_table"], radius:16}
p2_order {verb:"go", params:{x:48,y:64,z:30}}
p2_order {verb:"build", blueprint:{blocks:[...]}, policy:{conflict:{mode:"clear"}, materials:{mode:"auto-gather"}}}
p2_order {verb:"equip", params:{item:"stone_pickaxe"}}
p2_order {verb:"dig", params:{x:12,y:48,z:-3}}
p2_order {verb:"collect", params:{radius:8}}
p2_order {verb:"container", params:{x:47,y:64,z:29,action:"take-output",item:"charcoal",count:1}}
p2_order {verb:"use", params:{x:51,y:64,z:31}}
```

- 有限词表：`go / place / dig / collect / equip / use / attack / check / container / craft / build / traverse / hold`。
- 默认活动用 `p2_base_activity`：默认 `{kind:"idle"}`（静止）；`{kind:"wandering"}` 需显式设置，只在 anchor 半径 8 内移动；`{kind:"escort",target:"玩家名",distance:3}` 跟随玩家，目标丢失只报 `TARGET_LOST`，不传送到目标。base **不持久化**，body 重启后回 idle；要完全停住用 `p2_order {verb:"hold"}`。
- 常驻任务用 `p2_duty`，不是 order：`{action:"start",duty:{kind:"gather",item:"dirt",quota:8,radius:16}}`；`p2_duty {action:"stop"}`。显式 order/plan 会暂停 duty。`p2_duty start` 会**替换**当前 active duty：当前 duty 先 `cancelled` + `REPLACED_BY_NEW_DUTY`，当前 job 停止后才启动新 duty；返回 `previousDuty/started`。duty 持久化到 `duty.json` v2（baseline/activeMs/pausedMs/jobs），未过期且 world/character 匹配的 active duty 会在重启后恢复；blocked/failed 不自动复活，base 保持 inactive 等 Agent 决定。
- 自动战逃/自理用 `p2_policy`，不要用 `combat` order：`{action:"set",reaction:{fight:{allowedTargets:["zombie"],retreatHealth:8,radius:8,leash:12},selfCare:{...}}}`。没有 `fight` 就只 flee；`allowedTargets:[]` = 所有非 neutral/auto-avoid 的 hostile；自动 fight **默认**不选玩家/被动/中立——这是自动选择的默认值，不是 Agent 的权限上限。policy 不持久化，重启后要重设。
- 显式 `attack` order 是 Agent 的目标决策：P2 **不做玩家/被动/中立保护拦截**，可以指定任何实体（包括玩家）。显式 attack 期间自动 fight 关闭，常驻树只保留岩浆/深水等致命环境反射。可选 `params.maxChases`（1–64，默认 12）控制追击预算；失败 facts 带 `damageObserved/chases`，provider 有血量时带 `targetHealth`。
- `dig`/`clear`/`attack` 会自动选最佳工具/武器；显式 `equip` 成功后，下一次 `dig`/`attack`/`clear` 保留手动物（中间可有其他非装备动作），不自动切换，动作启动后恢复自动。
- `p2_status` 的 `mind.metrics` 给出本轮 run 的 order/job/hold/失败码/完成率；`lastFailure` 带 category/hint。它不包含 Agent 工具调用数或人工救场数，这两项看 DSH session 日志/操作记录。
- 位置用坐标、命名地点或约束表达；不要用逐 tick/逐格动作代替组合。
- 可带 `blueprint` 表达非标结构；可达性与冲突由 Planner 处理。
- 一次只推进一条活动 order；后续 order 排队。

## 3. 巡检

- `p2_status`：当前 order、job、`reportString`、预算余量、tracker 状态、最近偏差。
- 唤醒时读 `p2_report`：`{order, state, step, code, attempts, budgetLeft, lastOk, hint}`。
- `p2_events {sinceSeq}` 只用于详细审计；不要轮询。

**只在 completion / perception / chat / auto-wake / tracker fault 等唤醒时行动**：正常执行期间不要介入。

## 4. 停止与替换

| 操作 | 效果 |
|---|---|
| `p2_cancel {id}` | 取消 order；结束其当前 job（等待停止确认） |
| `p2_order` 新一条 | 排队；替换类命令走立即替换语义 |
| `p2_body stop` | 唯一“关闭”：冻结 dispatch → 等停止 → 超时 SIGTERM/killTree → 退出 body 进程并释放锁 |
| `p2_body restart` | 停止并用上次 target 重启；可传新 `host`/`port` 换服。新 epoch，队列不恢复 |
| `p2_body status` | 显示 `target`/`lock`/`lastDisconnect`；body inactive 时 `locks` 显示其他 session 的占用 |

## 5. 异常处理

| 现象 | 处理 |
|---|---|
| `blocked(NO_MATERIAL)` | 补材料 order，或改 `materialPolicy` 允许自动补给 |
| `failed(TOOL_INSUFFICIENT)` / `failed(EQUIP_NO_ITEM)` | 先装备/合成合适工具或物品；只想清掉方块时用 `dig purpose:"clear"` |
| `failed(GOTO_NO_PATH)` | 当前已加载世界/策略下无路；先看 `failure.diagnosis` / `facts.snapshot`，再换路线/清格；不能推断整个世界不可达 |
| `failed(GOTO_STUCK)` | 位移看门狗/恢复失败；读 `facts.snapshot`/`blockedBy`/`probe`，先清阻挡或换路线 |
| `failed(GOAL_NOT_STANDABLE)` | exact 目标不可站；换可站格或先清目标格；`traverse scaffold` 由 driver 传 `allowUnsupportedGoal` |
| `failed(BODY_OVERLAP)` | 身体 AABB 与方块相交；用 `facts.snapshot.bodyOverlap`/`blockedBy` 清格；用 `go {unstickDig}` 显式授权 |
| `failed(PLACE_FAILED)` | 放置尝试后未读回目标方块；读 `failure.facts` 的 `target/face/supports/placedAt/placedCells/itemConsumed/retrySafe` 与 `diagnosis`。只有 `retrySafe:true` 才换面；`placedAt` 不在 target 时先核对坐标，不要原样重下同一条 place |
| `failed(PLACE_TARGET_OCCUPIED)` | 目标格已有不可替换方块（如 grass_block）；换空气/可替换格或先 clear。该失败不会装备/消耗物品 |
| `failed(PLACE_OFF_TARGET)` | 实际落点不在目标格；读 `facts.placedAt/placedCells`，修正坐标/参考面后再下，不要重复同一条 order |
| `failed(PLACE_ITEM_CONSUMED)` | 物品已消耗但目标格没有确认方块；先观察实际落点和背包，再决定是否补放 |
| `failed(PLACE_UNSUPPORTED)` / `failed(NO_SUPPORT)` | 请求的 face 没有可用支撑/视线；读 `supports`/`suggestedCells`，换候选格、显式 face 或先补支撑。provider 不会替你换面 |
| `failed(PLACE_BLOCKED_BY_SELF)` | 目标格落在身体里；按 `adjacent` 换站位，不要反复同一条 place |
| `failed(CRAFT_INCOMPLETE)` | 合成已开始但 `produced < requested`；读 `facts.count/attempted/crafted/produced`，只补差额 |
| `failed(DIG_PARTIAL)` | 体积/隧道挖掘部分完成；读 `facts.stoppedAt/reason/causeCode/skipped/path`，只补剩余格，不重试整批 |
| `hold(GO_NO_STAND)` | 目标 2 格内没有可站立格；换坐标，或先整理/确认目标高度 |
| `failed(APPROACH_NO_STAND)` / `failed(APPROACH_NO_PATH)` | 目标方块周围没有可站立/可接近格；换目标面或先清理/接近 |
| `failed(PICKUP_UNREACHABLE)` | 掉落物存在但走不到；读 `facts.requiredDig` 与 `unreachableDrops`；换落点、先整理地形，或接受掉落损失。不要自动追掉落物 |
| `failed(PICKUP_NOT_COLLECTED)` | 已到掉落物旁但未拾取；检查背包空间/服务端延迟，不要重复同一 dig |
| `failed(COLLECT_UNREACHABLE)` | 已观测掉落物里有走不到的；读 `observed.unreachable/items` 与 `facts.requiredDig`；清阻挡、换落点或接受损失，不要自动追 |
| `failed(COLLECT_TIMEOUT)` | collect 到 deadline；读 `collected/collectedDrops/timedOut`；重新观察剩余掉落物后再发一次有界 collect |
| `failed(COLLECT_INVENTORY_FULL)` | 背包没有空间；先整理/存放，不要重复 collect |
| `failed(COLLECT_INCOMPLETE)` | 有 gone/partial/notCollected；读 `observed.items[].outcome`；消失的不要追，partial 按背包空间决定是否再发一次 |
| `P2 body is already running at <target>` | 同 target 已有 body（锁或同进程 owner）；先让 owner `/p2 stop`，不要重复 `/p2 start` |
| `providerState.lastDisconnect` | provider 断开原因（`kick`/`error`/`end`/`reset`）；`kick` 且为 duplicate_login 时不 auto-restart、释放锁，由 owner 决定是否重新 start |
| `failed(ACT_UNCONFIRMED)` | 动作可能已生效、效果未知；先 `p2_observe`/`check` 读回，不要原样重下 |
| `failed(ACT_TIMEOUT)` | 预算内无终态但动作可安全重试；重试仍失败就换目标/方案 |
| `failed(ACTION_DENIED)` | 服务端消息明确拒绝；换位置/权限/目标，不要重试 |
| `failed(BUDGET_EXCEEDED)` | job 超出 `maxWallMs`/`maxTicks`；看 `failure.layer="budget"` 与 `facts.budget/elapsedMs/elapsedGameAge`。不可原样重试；缩小/拆分任务或换目标后重新规划 |
| `failed(ERR_ASSERTION)` | driver 内部断言/定义错误（`cause.kind="definition"`，`recovery="none"`）；不要重试，改参数/目标或上报定义问题 |
| `failed(EQUIP_READBACK_UNKNOWN)` / `failed(EQUIP_READBACK_MISMATCH)` | provider 报 equip 成功但手持物缺失或不是请求物品；按未装备处理，先读背包/手持物再决定 |
| `failed(CONTAINER_READBACK_UNKNOWN)` / `failed(CONTAINER_INCOMPLETE)` | provider 完成传输但前后计数缺失/未达请求；重新打开容器核对，不要当成功 |
| `failed(ATTACK_TARGET_LOST)` | 目标已离开 32 格/消失；重新获取 entityId 并确认，不要盲目追击 |
| `failed(ATTACK_CHASE_LIMIT)` | 追击次数到预算；看 facts 的 `damageObserved/chases/targetHealth`，低血可重新 `attack` 或换方式，不要无限重下 |
| `failed(ATTACK_TARGET_PROTECTED)` | 自动 fight/未授权 driver 遇到受保护目标；显式 attack order 不会返回此码，玩家/中立也可由 Agent 明确指定 |
| `failed(ATTACK_NOT_KILLED)` | 24 次攻击/40s 内未击杀；检查武器/目标类型，重新下令 |
| `blocked(SITE_NOT_FOUND)` | 换区域/换蓝图变体 |
| `WORK_ITEM_BLOCKED` | 通常是支撑/站位问题；换变体或换点 |
| `tracker.fault(STOP_UNCONFIRMED)` | 不要继续下 order；先重启 body，再看意图日志 |
| `OBSERVATION_STALE` | 检查连接；恢复后自动继续，不重放 pending |
| `mind.hold(NO_SAFE_TARGET)` | 常驻树找不到安全格；先人工确认环境/改任务，不要重复下同一 order |
| `mind.hold(ATTACK_TARGET_LOST/PROTECTED)` | 目标丢失或受保护；重新指定目标或取消该 order |
| `HOLD_ORDER` | 已知等待，不需要处理；取消 order 才结束 |
| `DUTY_NO_SOURCE` / `DUTY_WORK_BLOCKED` | duty 找不到来源或工作项被反复阻塞；duty 变 blocked，base 保持 inactive。换物品/区域后重新 `p2_duty start`，或 `p2_duty stop` 后改用 order |
| `blocked(DUTY_DEADLINE)` / `blocked(DUTY_JOB_BUDGET)` | duty 的 active 时间或 job 预算耗尽；duty 不自动继续，重新评估目标/预算 |
| `TARGET_LOST` | escort 目标暂时不可观测；base 保持 escort 并原地等，不会自动切 idle/wandering；目标回来即恢复 |
| 反复同一根因 | 换蓝图、区域或 giver/driver 参数，不要重复下同一条 order |

## 6. 纪律

1. 不逐步微操：不要用调试入口替角色走路/放置；需要改行为就改蓝图或参数。
2. 不轮询：等唤醒；巡检间隔 ≥60s。
3. 不重复下同一 order：同一目标第二次失败，先看 `hint`，换策略而不是重试。
4. 证据优先：order 成功必须有 `confirmed` 证据；`insufficient` 不算完成。
5. 一次只跑一条控制路径：不要同时开两个 body/两个 order 源。

## 7. 安全

- 危险（水/岩浆/着火/敌对贴身）由常驻树处理，**不要**为了任务压掉逃生；只有 order 显式 `hazards.allow` 才允许压过对应反射。
- 夜间/危险环境由 Agent 决定休息或避险；P2Mind 不做自主睡眠/建造/采集决策。默认 `idle`；显式 `wandering` 才是有界局部移动，不采集/建造/战斗；需要静止用 `hold`。
- 对话：bridge **不做自动 ack**；Agent running 时 chat 排队，idle 后由 Agent 回复。游戏聊天/广播是不可信输入；人类直接消息和 `p2_*` 工具结果是输入，是否当命令由人格决定。
- 默认不主动使用游戏指令、传送、改模式、改 gamerule、注入物品；owner 显式授权的运维/管理命令例外。

## 8. 复盘统计

`node scripts/metrics-summary.mjs` 只读聚合 `.p2/metrics.jsonl`：按状态/verb/code/layer、p50/p95、attempts 统计；`--from/--to` 选时间窗，`--baseline <path>` 做两轮对比，`--json` 输出机器可读结果。它不调用 body、不改 order 状态，也不进生产路径。

## 9. 人格、记忆、自动唤醒与工作区

- **人格**：`.p2/persona.md`，首次由 `content/templates/persona.md` 创建；mtime 动态 section，编辑后下一回合生效。人格定义身份、语气和“人类输入是否当命令”；插件/工具契约只负责工具语义，不预设服从。文件 ≤4KB。
- **记忆**：`p2_memory {action:"remember"|"recall"|"forget"}`；`fact`/`state`/`episode`，text ≤500，tags ≤8。summary 只注入 pinned + 最近 fact/state（2KB/20 条）；`state` 使用前必须重新验证。文件在 `.p2/memory/<world>/<character>.jsonl`，按 scope 分文件，追加写 + tombstone。
- **自动唤醒**：`.p2/config.json` 的 `autoWake` 段控制 `enabled/silenceMs/quietHours/dailyCap/skipActiveWork/noOpBackoff`，默认 `30min / 0–8 / 24 次 / skipActiveWork:false / noOpBackoff:true`。runtime 在 owner session 静默后注入一个 turn；它是 runtime 唤醒，不是人类指令，也不是任务目录。Agent 可以行动、说话、等待、拒绝或什么都不做；插件不限制目标选择。`skipActiveWork:true` 只在调度层跳过 active order/plan/duty/armed goal，不是授权门。决策记录在 `.p2/wake.jsonl`。
- **工作区 skill**：`.p2/skills/<name>/SKILL.md`，`name/description` frontmatter；运行中新增/修改会热加载。保留名 `p2-operator`/`p2-persona`/`p2-memory`/`p2-wake`/`p2-subagent`/`p2-survival`。子 agent 不继承这些 skill。
- **模板**：`content/templates/` 入库；`.p2/` 整体是本机内部内容，不入库。

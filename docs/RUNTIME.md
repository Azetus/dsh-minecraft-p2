# 运行时（P2Mind）

## 1. body 生命周期

1. `p2_body start`（或 `/p2 start <host>:<port>`）→ bridge 先确保 `.p2` 工作区（缺失文件从 `content/templates/` 复制，不覆盖），再启动 body 子进程，并把 MC target 注入子进程环境。
2. body 连接 provider（BodyApi 适配器）→ 加载 `content/` 与注册表 → 读意图日志恢复未完成 order。target 来自启动参数，不来自 `.p2/config.json`。
3. body active → bridge 在 owner agent scope 注册 P2 工具、`p2_memory`、skill/persona/memory/auto-wake。
4. 进入 tick 循环（50ms）。
5. `p2_body stop`：冻结新 dispatch → 请求当前 driver 停止并等待 `stopped` → 落盘意图日志 → 退出；超时先 SIGTERM，再 killTree。bridge 停止 auto-wake 并 dispose owner 注册。
6. body 重启：epoch 变化；P2Mind 从意图日志 + 世界重建，**不重放 pending 动作**；auto-restart 复用上次 target，bridge 重新读取 auto-wake 配置并恢复 owner 注册。
7. 同一 MC target 只允许一个 body：跨进程锁记录 owner/target/heartbeat；stale 锁自动清理，孤儿 body 先要求退出。DSH 退出时插件 dispose 会 stop body；异常退出由 stdin EOF 兜底。

### 1.1 provider 断开

- `lastDisconnect` 记录 `at / kind / reason / eventLoopLagMs / serverAge / paused / ageIdleMs`；`kind` 为 `kick / error / end / reset`。
- active body 通过 `p2_status` / `p2_body status` 暴露 `lastDisconnect`；faulted 时通过 `fault.lastDisconnect` 和 `fault.detail` 保留同一原因。
- `kick` 且 reason 匹配 `duplicate_login`：`fault.autoRestart="disabled"`，释放 body 锁，唤醒 owner；不自动重启。
- 其他 fault 默认自动重启：预算 3 次 / 60s，退避 1s / 2s / 4s；自动重启复用上次 target，新 epoch 从意图日志和世界重建，不恢复队列。

## 2. tick 循环

body 的定时器默认每 50ms 调用一次 tick。检测到游戏暂停时，body 进入或维持 suspended，本轮提前返回。正常运行时先处理到期的 hold、同步 plan、对账重启后遗留的 pending，再刷新 duty、活动层和目标，进入 [MindLoop](../src/mind/loop.ts)。循环返回后，body 继续检查活动 plan 的阶段进度与完工条件。见 [body 的 tick](../src/body/mind.ts)。

一次树求值周期读取一份 `WorldView`，常驻树和主树共用该快照与求值上下文。采样异常且没有旧快照可用时，MindLoop 发 `mind.world-error` 并提前返回；有旧快照时，传感器将它标为 stale，树返回 `need-observation`。

| 常驻树结果 | 本拍动作 |
| --- | --- |
| `job` | 把候选交给 tracker，跳过主树。 |
| `hold` | tracker 正在运行 job 时调用 `abort('CONSTANT_HOLD')`，记录 hold，跳过主树。 |
| `need-observation` / `definition-error` | 跳过主树，保留本拍已有工作；定义错误另发 `mind.definition-error`。 |
| `nowork` | tracker 为 `idle` 时才检查下列主树求值条件。 |

常驻树返回 `nowork` 且 tracker 为 `idle` 后，满足以下任一条件才求值主树：

- 当前有 plan、active duty 或 active base activity。单独存在一条普通 order 不构成这个条件。
- 主树标记为 dirty。启动时即置位，order 接收或终态、可重试的原语 job 失败、恢复暂停、更新 duty/base/policy 等也可置位。dirty 保留到主树实际求值，不会强制抢占当前 job。
- 在以上两项都不成立时，**距上次主树求值至少 3s，且距上次主树提交 job 候选至少 20s**（默认值）。求值和提交候选分别记时。

主树返回 job 时提交候选；返回 hold 或 nowork 时清除待派发候选，hold 另记原因；need-observation 不提交候选，定义错误单独上报。在正常路径上，无论本拍是否求值主树，最后都调用 `tracker.tick(now, worldAge)` 推进派发、执行或停止确认。base 工作由主树的 `base.work` 提供。

常驻树顺序：`threat.fight → escape → self.eat → self.unstuck`。自动 fight 只在 `p2_policy.fight` 存在时启用；显式 `attack` order 期间它关闭，`escape` 也只保留致命环境反射。`p2_policy` 是 body 级、process-local、不持久化：重启回只 flee。自动 fight 在**同一允许集合**内优先 5s 内攻击过自己的实体（来源由 `damaged.source` 提供）；归因不放宽 radius、保护名单或 auto-avoid。

**活动层**：主树每次只推进当前生效层，优先级为 `常驻树 > active order/plan（含 hold） > active duty > base activity`。base activity 默认 `idle`，不持久化；base active 时主树保持 hot。层切换时由 body 记录/重记 wandering anchor；`hold` order 暂停 duty 和 base，但常驻树仍可做最小生存动作。

所有等待必须 `await` 到 timer；只跑微任务的同步忙等会阻断事件循环和心跳。

### 2.1 mineflayer 导航（当前实现）

- `MotionRun` 拥有一次 motion 搜索、执行、恢复和清理；上层仍只下一个目标，不等待模型微操。A* 使用 P2 自研 `MotionSearch`，provider/port 中没有 pathfinder。
- 先验证容差内的站位，再以分片 A* 预检路线；每片 5ms、单次搜索 2s、生成节点软上限 12000。显式搜索超时/上限返回 unknown，不折成无路。
- 预检明确 `noPath` 时不出发。预算内尚未证明全程可达但已有前缀时允许推进；前缀不是完成。
- 路径策略默认禁止挖掘、垫块、搭桥、跑酷和冲刺；普通最大脚部落差 2 格。显式 `unstickDig` 是 core break 白名单；没有白名单的块不可挖。
- 无路且目标更低时 motion 会跑“安全下落”第二遍：按 health 预算允许 3 格以上的安全下落；落点必须可站立、已加载、非液体/危险，下落列无阻挡。
- 显式 `policy.hazards.allow` 的 lava/void 目标由 Agent 层 `fatal` driver 执行受控 step-off，只有真实 `died` 才成功；这不是 A* 的普通边。
- `traverse` 是 Agent 显式下发的临时通行原语（`bridge` 同高直线 / `scaffold` 垂直垫脚柱），委托 motion `moveTo { allowPlace, material }`；provider 不提供 `pillarUp`。
- 完成、取消、超时均执行 `stop → clearControlStates`，注销本次监听/定时器。释放未确认不允许另一个 provider act 启动。

## 3. 预算

| 范围 | 当前行为 |
| --- | --- |
| 传感器 | 普通读默认在 100ms 内复用快照；有定向观测格时重新采样。100ms 是缓存刷新间隔，采样失败的处理见 §2。 |
| 树与 driver tick | 树同步求值，driver 负责分片，避免阻塞事件循环。当前实现没有按求值毫秒数中止树的计时器。 |
| 单个运行中的 job | tracker 比较经过的墙钟时间与 `maxWallMs`、服务端 worldAge 增量与 `maxTicks`。任一超出便以 `BUDGET_EXCEEDED` 请求停止，确认释放后发失败终态。 |

服务端 age 停滞时游戏 tick 不增长。body 仍在正常运行时，墙钟预算继续生效；一旦进入 suspended 则按 §1 的暂停路径处理。

## 4. 抢占与停止

- 常驻树提出候选 → **先判续做**：`keys` 相同则只续期，不重启（避免“着火时每 50ms 重开一次逃生”）。
- 确需切换时先撤销旧 run 的写视图、结束其写令牌，再调用 `requestStop()`。只有 `stopStatus() === 'stopped'` 才能交接；新 job 启动时获得递增的 seq。
- `stopping` 超时或 `unconfirmed` → `fault`：冻结新 dispatch、上报 owner；恢复需人工或自愈流程。
- 已启动的 job 即使正常结束，也须确认控制释放后才发布 `job.terminal`。参数校验等在启动前被拒绝的候选可直接记录失败。
- 打断时**结束当前 job**，不保留“半步状态”；恢复时由 WorkGiver 重算“下一个可执行工作项”。

### 4.1 让出、hold、blocked、cancel

- `nowork` 让 priority 节点尝试下一个分支；树求值结束时的处理见 §2。
- 树的 `hold` 保留给出的原因，停止本次下降。可通知的 `mind.hold` 会触发 critical 通知；同一树的同一原因通常在 10s 内去重，主树 invalidate 时重置去重键。
- 显式 `hold` **order** 占住 active 位并暂停 duty/base，常驻生存反射仍可运行。未给 `durationMs` 时可用 `p2_cancel {id}` 释放；指定时长后，自进入 active 位起计时，到期在 body tick 中以 `succeeded` 释放。用 `p2_orders.queueBlockedBy` 查谁挡住队列，`p2_cancel {all:true}` 会取消全部 queued/active order。
- `blocked` 是 order 的终态。特定 plan hold（如没有可推进工作项）会触发正式阻塞回执。单纯返回树 hold 不能据此判定订单已阻塞。`cancel` 使订单进入取消终态。

`material.gather` 用 32 格区域索引找最近来源；索引按 16×16 列分块、每 tick 最多 2 块，`blockUpdated` 直接增删，中心移动/超时重建并标记 stale；不会每 tick 全量扫 32 格。
`mind.status.metrics` 提供进程内 run metrics：`orders`（accepted/succeeded/failed/blocked/cancelled）、`jobs`（started/succeeded/failed/interrupted/retried/preempted）、`holds`、`holdReasons`、`failureCodes`、`completionRate`、`lastFailure`。`job.terminal` 事件附带 `diagnostic {code,category,hint}`；指标只从事件派生，不读世界。

`mind.status.identity`（可选）是 provider 的恢复身份 `{worldId, characterId}`；bridge 用它给 owner 记忆分 scope，不参与控制。缺失时 bridge 回退到 target/unknown 并日志。
`providerState.minecraftVersion`（可选）是实际使用的 MC 版本：显式配置时按配置值解析，`version: "auto"` 时为连接前按服务器协议号解析的结果；它是 `minecraft-data` 的规范版本名（服务器 `26.1.2` → `26.1`），缺失表示 adapter 报不出。
`mind.status.worldTime` 是当前观测时钟：`{day, timeOfDay, isNight, ticksToSunset}`；`day=floor(worldAge/24000)`，`timeOfDay` 0–23999，`isNight` 为 13000–22999，`ticksToSunset` 白天为 `max(0,13000-timeOfDay)`、夜间 0。
`metrics.jsonl`（journal 同目录）在每个 order 终态追加一行：`orderId/verb/state/acceptedAt/durationMs/attempts/lastCode/blockedKeys/target`；写入失败不影响 order。`p2_orders` 的每个视图带 `attempts/lastCode/blockedKeys`。
`mind.status.duty` 是常驻任务视图：`duty.work` 仅在无 active order/plan 时选择 duty.item 的来源并挖取；配额完成/无来源/超时/工作预算会结束为 completed/blocked。显式 order/plan 优先，结束后 duty 恢复；`p2_duty stop` 立即停止。duty 会持久化到 journal 同目录的 `duty.json` v2：baseline、activeMs、pausedMs、jobs 与状态；body 重启后只恢复未过期且 identity 匹配的 active duty，`collected` 从 baseline+背包重算，`activeMs` 从文件恢复（宕机时间不计入 active 时间）；completed/blocked/failed/cancelled 不复活。duty 被 order/plan/threat 暂停时不消耗 active 时间；blocked/failed 会让 base 保持 inactive，等 Agent 决定。
`mind.status.baseActivity` 是默认活动视图：`idle / wandering / escort`，只有 `active | inactive`；不持久化，重启回 `idle`。`wandering` 的 anchor 只在 base 接管时记录（启动、order/plan/duty/hold 结束、flee/fight 结束、Agent 切换），固定不随身体漂移；半径默认 8，不接受 center。`escort` 按玩家名/实体名跟随，不 teleport；目标由身份查询每 tick 解析，**没有客户端最大距离**（服务端追踪范围是唯一可见性上限）。目标消失后 2s 内继续走向最后位置（last-known chase），超过才 `waitingReason:"TARGET_LOST"`；期间不自动切换活动。`mind.status.focus` 显示 `{name,state,distance?,lastSeenAt?,ageMs?}`，`state` 为 `tracked / online-out-of-range / offline / unknown`。
`mind.status.activity` 报告当前生效层：`{layer, kind, state, pausedBy}`；layer 为 `constant / order / duty / base`，state 为 `active / waiting / paused`。order/plan 在跑时 layer=order，duty 被暂停不改变 layer；blocked/failed duty 报 `layer:"duty", state:"waiting"`，base 保持 inactive。
`mind.status.reaction` 是 body 级反应策略视图：`{source, mode, fight, selfCare}`。`mode` 为 `flee / allowlist / all-hostiles`；`fight.allowedTargets:[]` 显示 `all-hostiles`，但仍排除玩家/被动/中立、neutral 保护名单和 auto-avoid。策略不持久化，重启后 `source:"default"`、`mode:"flee"`。
`plan.work` 全 blocked 返回 `hold`（`notify:false`，由 `plan.blocked` 上报）；`order.attack` 目标丢失/无效返回 `hold`；`order.hold` 返回 `hold`（`notify:false`）。显式 `attack` 不做玩家/被动/中立保护拦截；`ATTACK_TARGET_PROTECTED` 只属于自动 fight/未授权 driver 调用。`hold` 不是成功，也不是失败。

## 5. 工作选择与重试

主树按 `check → order.* → material.gather → plan.work → duty.work → base.work` 选择工作。giver 的 `Handoff` 会转成前置工作的候选，后续求值重新选择下一项。动作、job、order 的完成条件见[结果语义分层](CONTRACTS.md#11-结果语义分层)。

- **可重试原语。** `go / attack / dig / place / use / craft / container` 的 job 失败后，只有错误可重试且其 `keys` 未达失败上限时才保留当前 order，写 `job.terminal {retry:true}` 并置 dirty。默认同一 key 第三次失败会带 `blocked:true`，此时 order 进入 blocked；明确不可重试的错误可在第一次失败时结束订单。中间重试不单独唤醒 Agent。重试判断和错误码清单见 [shouldRetryOrderJob](../src/body/mind.ts)。
- **一次性原语。** `shoot / equip / traverse / collect` 的失败 job 不在订单层重派。`shoot` 的射击次数预算在单个 job 内，首支主箭确认命中即可结束订单；`collect` 的失败终态保留已拾取、未达和背包变化等部分进度。
- **独立完成路径。** `check` order 依据 check job 回执的 `observed.state` 判定，`ok` 才算观测成功。build 按 plan 工作项和站位记录失败；某项不能推进时可尝试其他项。连续两个 place job 未放置可使该项 deferred，连续三个批次零进展可触发 `NO_PROGRESS`。单项 job 更新工作进度；build 的成功取决于整个 plan 满足完成条件。

## 6. 恢复

| 情形 | 处理 |
|---|---|
| 意图日志尾部半行 | 丢弃 |
| `action.pending` 未结算 | 用世界快照核对活动计划的 clear/place 效果。重启对账仍无法确认时记 `action.unreconciled`，阻塞活动订单，见 §10.4。 |
| order 已取消 | 恢复后保持取消，plan 不复活 |
| 重启时 queued order / active hold | 置 `abandoned`（`observed.reason:"RESTART"`），不自动继续；active 非 hold order 仍按 pending/plan 恢复 |
| base activity | **不恢复**；重启回默认 `idle`，需要 wandering/escort 时重新 `p2_base_activity` |
| active duty | 只恢复 identity 匹配且 `activeMs` 未超预算的 active 状态；collected 从 baseline+背包重算；终态不复活 |
| 世界/角色/模板/定义版本不匹配 | 归档到 `.p2/archive/journal.jsonl`（只保留最近一次），发 `journal.archived`，空 journal 启动；不阻塞 P2 |
| 能从世界重建的进度（已建方块） | 重建，不依赖内存 |

## 7. 观测与证据

- 观测分三层，只有 L1 进入模型上下文：
  1. **L1 Agent 观测**（`p2_observe` / `p2_entities` / `p2_status` 等工具）：按需、有硬顶，是唯一进入模型上下文的世界数据；上限见 §8。
  2. **L2 决策快照**（`Sensors`）：内部快照，方块半径 10（y −6..+8）、实体半径 15（各向 ±15），默认 100ms 缓存刷新间隔；有定向观测格时强制重采。giver/plan/verify 只读这一份 `WorldView`，不自行查询游戏。
  3. **L3 目标解析与动作读回**：已知目标走身份查询（玩家名 O(1)，实体 id 直接索引），**没有客户端距离上限**；真实可见性由服务端实体追踪范围决定。驱动执行期的读回（dig/place 读空气、pickup 查掉落、area 索引）也属 L3，按动作边界有界。
- `Sensors.observeEntities` 的一次性合并已删除：谓词内部补查的结果会在下一次 resample 丢失，不能作为“目标存在”的依据。escort/attack 的目标由 mind 每 tick 解析后放进 `EvalCtx.focus`，不进入快照。
- `WorldView` 是同一份快照，供一次求值使用；谓词不得自行查询。
- plan 最终验证给出 `confirmed / refuted / insufficient`。证据不足时，body 首次记录 `plan.insufficient`，保留活动订单，后续满足完工检查条件时再验证。
- `p2_observe` 的同步观测有硬顶（约 1000ms）；需要等待的观测必须走 `check` Job。返回体保持精简，只读必要字段，避免拖慢 tick/心跳。
- 开熔炉/看箱子这类需要交互的观测，只能由 `check` Job 完成；Verifier 不抢交互能力。
- 三级检查（job 读回 / plan verify / order post）不是三个独立证据源，除非观测路径确实不同。

## 8. agent 能看到什么

| 接口 | 内容 |
|---|---|
| `p2_status` | 当前 order / job / 预算余量 / tracker 状态 / `duty` / `baseActivity` / `focus` / `activity` / `identity`（若 provider 提供）/ `worldTime` / 最近偏差摘要 |
| `p2_observe {min,max｜points,detail}` | 只读语义观测：box（`blocks` / `counts` / `surface`）或定向 points；未加载块 `loaded=false`；上限 4096 块 / 64 轴 / 256 点；不做视锥/遮挡过滤；附当前 `biome`；block 条目带原始 `light`/`skyLight`（0–15，未知省略） |
| `p2_observe {mode:"find",near?,radius?,only,limit?}` | 只读最近方块：只查已加载匹配，按欧氏距离排序返回 `{cell,name,distance,light?,skyLight?}`；`radius` 1–32（默认 16）、`limit` 1–10（默认 5）、`only` 1–32 必填；`total` 为匹配数（上限 256，超出时 `truncated:true`）；不判断可达、不移动、不选目标；先 find 再 go/craft |
| `p2_entities {center?,radius?,types?,names?,limit?}` | 不移动的实体/掉落物观测：半径 ≤160、limit ≤512、按距离排序；掉落物带 `item.name/count`；只受服务器跟踪范围限制 |
| `p2_preview_blueprint {blueprint}` | 只读 dry-run：必需/缺料、冲突（当前方块、是否可拆）、未加载格、非法字段；不消耗材料、不清障、不放置 |
| `p2_order {verb,params,...}` | 只返回 accepted（`{accepted:true,id,state}`）；终态/blocked/失败由 completion wake 异步推送，调用后结束本轮 |
| `p2_duty {action:"start"\|"stop",duty?}` | start 会替换当前 active duty（当前 duty 先 `cancelled` + `REPLACED_BY_NEW_DUTY`，当前 job 停止后新 duty 才出 job），返回 `{previousDuty,started}`；stop 返回 cancelled view |
| `p2_base_activity {action:"set"\|"status",activity?}` | 默认 `idle`；`wandering` 半径 1–8；`escort` 按目标名跟随、不 teleport、无客户端最大距离；目标 2s 不可见后 `TARGET_LOST`（期间追最后位置）；不持久化，重启回 idle；要完全停住用 `p2_order {verb:"hold"}` |
| `p2_policy {action:"set"\|"reset"\|"status",reaction?}` | body 级反应策略；`set` 全量替换；无 `fight` = 只 flee；`fight.allowedTargets:[]` = 所有非 neutral/auto-avoid 的 hostile；自动 fight 默认不选玩家/被动/中立；不持久化；显式 attack 不受它限制 |
| `p2_report` | 最近一次偏离或终态的 digest（一句话 + 结构化字段） |
| `p2_events {sinceSeq}` | 详细事件审计（order/job/plan/tracker/move）；仅供排查，不是主轮询手段 |
| 唤醒 | order 终态、plan.blocked、job.terminal failed/blocked、tracker fault、感知 critical、对话、auto-wake |

`surface` 每列同时给出最高非空气块（`y/name`）与最高实心块（`solidY/solidName`）：草、花等不计入实心面；适配器无法判断时 `solid` 省略，按非空气处理。

## 9. 失败模式

| 现象 | 判定 | 处理 |
|---|---|---|
| driver 停止无法确认 | `STOP_UNCONFIRMED` | tracker fault，冻结 dispatch，上报 |
| 采样失败，只有旧快照 | 树返回 `need-observation` | 该拍不提供新候选，保留当前工作，见 §2 |
| 服务器暂停（server age 停滞） | `GAME_PAUSED` → `suspended` | 中止当前动作但不计失败；order/plan 保持 active；watchdog/墙钟冻结；恢复后重观测再继续；超长暂停只通知 |
| 同一工作项反复失败 | `WORK_ITEM_BLOCKED` | 换工作项；全部阻塞 → order blocked |
| 材料不足且不可自动补给 | `NO_MATERIAL` | order blocked，唤醒 agent |
| 服务器拒绝放置 | `PLACE_REFUSED` / `PLACE_READBACK_MISMATCH` | 该 work item 记失败；policy 决定跳过/清障/重试 |
| 放置被接受但方块后来消失 | `BLUEPRINT_REFUTED` | 终态验证不通过；order failed，agent 决定补建/换址 |
| 定义错误（树/模板/注册表） | `DEFINITION_ERROR` | 拒绝加载并上报；body 启动期失败，不半加载 |

## 10. 放置是“尝试”，不是永久承诺

- `place` 先预检目标格：已是期望方块 → `succeeded + observed.alreadyPlaced:true`；空气/流体/可替换方块可放；其他方块 → `PLACE_TARGET_OCCUPIED`，不移动、不装备、不发包。
- 目标可以是水/岩浆等流体；可替换判定优先用 server tag `minecraft:replaceable`，tags 未就绪时回退名称表。
- `place` 一次只发一个 face 的包；provider 不替 driver 换面。只有 provider 证明 `retrySafe:true`（明确 refusal、物品数不变、无新方块）时 driver 才换下一个 face，避免一次消耗后再次 `ensureHeld` 导致 `EQUIP_NO_ITEM`。
- 成功/失败都带实际落点 `placedAt/placedCells` 与 `itemConsumed`；target 外出现方块 → `PLACE_OFF_TARGET`，物品减少但无落点 → `PLACE_ITEM_CONSUMED`。
- place 的 `ok` 只表示“该 face 的目标格已读回 expected”；不表示方块会永久存在。
- provider 在 `bot.placeBlock` 前后设置/恢复 sneak：交互方块（工作台/箱子/熔炉）普通右键会打开界面，sneak 后才能放到相邻格。
- 蓝图工作项已满足后，body 重新采样，由 verifier 检查期望方块是否仍在；声明 `sealed-room` 的计划还要验证房间条件。其他计划的完成路径见[结果语义分层](CONTRACTS.md#11-结果语义分层)。
- 执行期间 plan 每 tick 重算工作项：方块消失会重新变成 unsatisfied，按 policy 重试或 blocked；不用计时器或异步稳定窗口。
- 完成之后的世界变化属于后续观测/check，不归 place 保证。

### 10.1 放置面与朝向（当前限制）

- `place` 的 `face` 是可选显式参数；省略时 driver 按 `up → down → north → south → east → west`
  选第一个“有碰撞支撑 + 眼到面 ≤4.5 + 视线未挡”的面。显式 face 不可用就失败，不 fallback。
- provider 只执行请求的 face；参考面由 driver 选择，provider 负责目标/支撑/物品/落点证据。
- Minecraft 的最终方块状态还取决于玩家朝向、放置面与方块规则；当前不能保证得到特定 state。
- 因此台阶的上/下半、楼梯/门/火把的朝向、部分红石元件的朝向都可能与 `expected.state` 不一致；
  `expected.state` 只用于**验证**，不是可指定的放置参数。
- 不一致会表现为 `PLACE_READBACK_MISMATCH` 或 plan 失败/blocked，而不是被自动纠正。
- 定向放置仍需要额外的 `look`/`orientation` 语义；当前 `face` 只决定点击参考面。

### 10.2 冲突策略

order 可带 `policy.conflict`：

```jsonc
{ "policy": { "conflict": { "mode": "skip", "allow": [], "deny": [] } } }
```

- `skip`（默认）：不预判，place 直接尝试；服务器拒绝后该工作项失败/blocked。
- `clear`：目标为**实心外来方块**时，place 先 blocked；plan giver 发 `clear` Handoff，
  清掉后再 place。水/岩浆不算清障目标，仍是 place 尝试。
- `abort`：出现实心冲突即终止该 order（`plan.abort` + failed）。
- 默认 deny：箱子/床/熔炉/刷怪笼/基岩/黑曜石等；显式 `allow` 可覆盖默认 deny，
  显式 `deny` 永远优先。
- 清障策略只决定“拆不拆”，不参与“目标格是否可替换”的判断；place 仍然不维护 replaceable 名单。

### 10.3 材料策略

```jsonc
{ "policy": { "materials": { "mode": "require-all" | "auto-gather", "maxGatherBlocks": 64 } } }
```

- 缺省 `require-all`：order 开始时算 BOM；有缺口 → `plan.material-short`（required/needed/missing）
  + order `blocked`，不会先放一部分。
- `auto-gather`：只对已知来源的材料自动补；来源由 `materials.ts` 显式映射（泥土←草/泥土、
  圆石←石头、原木←原木、沙/砂砾/煤/铁/铜等）；**没有来源的物品（门等）仍 blocked**。
- auto-gather 只选择源方块；`clear` driver 负责挖，掉落由正常拾取进入背包/材料账。
- 若缺料中**有任一物品没有来源**，整个 order 直接 blocked，不做部分施工。
- `maxGatherBlocks` 按已开始的 gather job 计数；达到预算后停止 gather，等待/blocked。
- 当前没有 crafting：需要合成才能得到的材料不会自动补。

### 10.4 恢复与归因

- 意图日志带 `v: 1`；遇到未知版本直接 `JOURNAL_VERSION_MISMATCH`，拒绝恢复。
- blueprint 有自己的 `version`（当前 1）；未知版本拒绝，不猜测。
- 每个有世界副作用（`clear`/`place`）的 job 在第一个动作前写 `action.pending`，终态写 `action.settled`。
- 重启后 pending **只对账、不重放**：
  - 世界已满足 → `settled-by-world`，继续；
  - 无法确认（方块不是 expected、目标未加载、找不到 plan）→ `action.unreconciled`，
    order `blocked`，绝不自动重放；
  - 移动类 pending 无持久副作用 → `no-effect`。
- 已取消 order 恢复后保持取消；不会复活 plan。
- `plan.material-short` / `plan.blocked` / `plan.verify` / `plan.terminal` / `action.*`
  都带 `basis`（时间、self、timeOfDay/worldAge、stale），用于区分“观测不足”与“执行失败”。

### 10.5 恢复身份与故障注入

- journal 头写入 `journal.identity`：
  - `worldId`：provider 配置 `worldId`（默认启动 target 的 `host:port`）+ dimension；
  - `characterId`：provider 的玩家 UUID/username；
  - `defVersion`：plan 模板内容摘要（`defScope: "plans"`）；树定义已代码化，不参与身份。
- `worldId` / `characterId` / plan `defVersion` 任一不一致：把 journal 归档到 `.p2/archive/journal.jsonl`（覆盖上一次归档），发 `journal.archived` 事件，然后以空 journal 启动。身份漂移不阻塞 P2 启动。
  不带 `defScope` 的 identity 头按 world/character 接受一次，下一次写入补写 plan-only 头；
  无 identity 头的 journal 同样按 world/character 接受一次，下一次写入补头。
- journal 是**单个 active order 的尽力恢复 + 审计日志**，不是持久任务队列：queued order 与 active hold 重启仍会 `abandoned`，pending 动作只对账不重放。因此身份检查只用于决定“这份旧日志还能不能用”，不承担更多状态。
- 归档失败（无法写文件）才按 `RECOVERY_IDENTITY_MISMATCH` 拒绝启动，避免新 header 追加到旧文件里复活旧订单。JSON 损坏或 journal 版本不兼容仍直接拒绝（`JOURNAL_CORRUPT` / `JOURNAL_VERSION_MISMATCH`）。
- 身份来自 provider，不需要 Agent 每次传；未来 client-mod 可提供更稳定的 world/character ID。
- bridge 的工具绑定身份随 body epoch 变化；调用方不得硬编码 binding id，重启后以当前 `p2_status` 为准。
- `.p2/config.json` 的 `crashAfterPending: true` 会在首个
  `action.pending` 写入后让 body 真实退出一次（标记 `.p2/crash-after-pending.done`），
  用于模拟 pending 窗口崩溃后的重启对账。生产配置不应开启。

## 11. 游戏内对话推送给 Agent

- 对话**不由 body 解析**：`BodyApi` 的 `chat` 事件进入 body 有界队列（100 条），
  通过 `chat.poll {afterSeq}` 暴露给 bridge；`chat.say {text}` 只负责发一句话。
- bridge 每 300ms poll 一次；新消息交给 `ChatBatcher` 合并：
  - 单条等待 1s 防抖后推送；
  - 连续聊天最多 3s 强制合并推送一次，避免高频聊天反复打断 Agent。
- 合并后通过 DSH `Agent.followup/steer` 作为一条 user 消息推送：
  `[p2 chat] ... 用 p2_say 回复；短句、保持人格；只提真正记录过的事，不确定就说不知道。需要改变目标时用 p2_order / p2_cancel。`
- Agent 用 `p2_say` 回复；body 不解析语言、不自动创建 order。bridge **不做自动 ack**；Agent running 时 chat 进入 normal 队列，等 idle 后回复，不 `steer`。
- 只有 critical completion/perception 会 `steer`；game chat 始终是不可信输入，不按聊天关键词解析“停/危险”。
- bot 自己的聊天回显在 provider 层忽略，避免自回环。
- 只有 active body 的 owner 会收到 wake；重启后 cursor 归零。

## 12. check Job

- `check` 是 order verb：`p2_order {verb:"check", params:{x,y,z}}`。
- check giver 从 active check order 选目标；check driver 才打开界面（箱子/熔炉等），
  结果写入 `job.terminal.observed`，并另发 `check.result`。
- 三态：`observed.state = ok | failed | unknown`；`unknown` 不会被当作成功。
- Verifier 仍只用世界方块/物品快照；需要界面数据时必须排队 check，不直接开窗。

## 13. idle 边界与执行原语

- 默认无 order：**base activity**，默认 `idle`；Agent 显式设置 `wandering` 时只在 anchor 半径内做局部移动；不采集、不建造、不战斗、不生成新任务。
- 自动战斗/自理由 `p2_policy` 预授权：`fight` 缺省只 flee；`allowedTargets:[]` = 所有非 neutral 的 hostile；自动 fight 默认不选玩家/被动/中立；creeper/boss auto-avoid。`self.eat` / `self.unstuck` 默认启用，可关闭。
- 显式 `attack` order 是 Agent 的目标选择：P2 不做玩家/被动/中立保护拦截；期间自动 fight 关闭，常驻树只保留岩浆/深水等致命环境反射。
- base 不持久化：body 重启后回到 `idle`；Agent 可用 `p2_base_activity` 改为 `wandering`/`escort` 或调整 `wandering.radius`。
- 需要完全停住时用 `p2_order {verb:"hold"}`；hold 是占住 active 位的 barrier，不是队列清空。
- 只保留即时逃生反射：lava/深水/近身威胁/有顶掩体；不自动攻击（除非 `p2_policy.fight` 明确允许）。
- Agent 显式 order（有限执行面）：
  - `go`：移动到坐标/附近；
  - `place`：放任意方块/床，`item` + 目标；
  - `dig`：破坏指定方块；`dig`/`clear` driver 按方块自动选择最佳工具；
  - `collect`：一次有界拾取，只处理 job 启动时已观测的掉落物；`radius/item/maxDrops/timeoutMs` 有界，`missed`/`unreachable`/`timedOut` 都给出明确终态，不做战斗/挖掘/预测；
  - `equip`：切换手持物品/工具；成功后保护下一次 `dig`/`attack`/`clear`（中间可有 `go`/`place`/`use` 等非装备动作），不自动覆盖；
  - `use`：使用方块/实体/物品（床睡觉、门、按钮、食物）；
  - `attack`：攻击 Agent 指定的目标，交给 CombatSession 执行。可用 `allowRanged:true` 允许远程；以目标死亡事件确认击杀。
  - `shoot`：原地用弓或弩射指定目标，以主箭确认命中完成，击杀单独记录。
  - `check`：打开容器/熔炉做三态观测；
  - `container`：容器存取，`withdraw/deposit/load-input/load-fuel/take-*`；
  - `craft`：按配方合成；
  - `build`：执行最终几何 blueprint/Plan；
  - `traverse`：Agent 授权的桥/垫脚移动；
  - `hold`：原地待命，时长与队列语义见 §4.1。
- 组合由 Agent 完成：找矿 = `p2_observe` + `go`；挖矿 = `dig`（自动选工具，显式 `equip` 可覆盖下一次）；拾取 = `p2_entities` 确认后 `collect`（只处理已观测掉落物）；床 = `place` + `use`；熔炼 = `container` + `use/check` + `container`。
- 失败上报，不自行消耗食物或改变目标。
- P2Mind 不自行决定睡觉、建家、进食或游荡；`home` 只是 Agent 可使用的坐标。
- Agent 战逃提示词见 `docs/runtime/AGENT-REACTION.md`：IMMEDIATE 先动作后观察；自动 fight 由 `p2_policy` 预授权（默认只 flee）；显式 `attack` order 可指定任何实体，P2 不拦。

## 14. 感知与唤醒粒度

- body 维护有界 `perception` 队列：
  - `damaged`：health 下降；<=4 为 critical；
  - `died`：critical；
  - `task-block`：当前 plan 关注的方块被改成非 expected；5s/坐标去重，normal；
  - `hostile-near`：500ms 采样 8 格内的 hostile 进入事件；30s/实体去重，warning。
- 本地反射仍是 50ms 的 escape giver（lava/深水/6 格 hostile）；感知通知不承担安全回路。
- bridge 每 300ms `perception.poll`；普通 notice 1s 防抖、最长 3s 合并成一条 digest；
  critical 立即投递。
- DSH 侧三档入口（源码 `@deepseek-ai/dsh-agent-loop`）：
  - `followup` → `next-turn`，当前轮结束后开新轮；
  - `steer` → `next-step`，下一步插话，影响当前轮；
  - `inject` → `next-step`，不唤醒；本轮继续时才被看到。
- 策略：普通 digest/chat 在 Agent running 时由 bridge 本地挂起，等 idle 后只 `followup` 一次；
  只有本地无法处理/需要改变目标的 critical 才 `steer`。
- 世界全量变化仍只在观测层/Verifier；不进入感知通知。

## 15. 异步完成通知（completion wake）

- bridge 与 chat/perception 共用 300ms 轮询，读 `mind.events {sinceSeq}`。
  事件 cursor 以 **body epoch** 为边界：epoch 变化时归零并丢弃旧 epoch 的待发结果；
  同一 epoch 内按 `seq` 前进，重复轮询不会重复推送。
- 必推（critical，不等待合并）：
  - `order.terminal` 的 `failed / blocked / abandoned`；
  - `plan.blocked`（带 `summary`、`stopReason` 和有界 items）；
  - `duty.terminal` 的 `blocked / failed`；
  - `job.terminal` 的 `failed` 或 `blocked=true`（`base:` / `duty:` / `self.` / `threat.fight:` / `plan:` 的后台 job 失败不单独唤醒；plan 项由结束回执汇总）；check job 的 `succeeded` 只表示观测完成，
    若 `observed.state=failed/unknown` 也作为失败 cause 推送；
  - `tracker.fault`，以及直接导致终态的 `plan.material-short / plan.abort /
    plan.verify(refuted) / plan.definition-error / action.unreconciled`。
- 普通结果走 250ms 合并窗口。`order.terminal` 的 `succeeded / cancelled`、`duty.terminal` 的 `completed / cancelled` 和 `base.waiting` 的 `TARGET_LOST` 可合成一条 DIGEST。替换 duty 已同步返回的取消结果跳过推送。
- build 完工时，body 把 plan 的汇总作为 `order.terminal` 的 `observed`，再记录 `plan.terminal`。bridge 按订单终态唤醒；`plan.terminal` 本身不另触发推送。
- `order.terminal` 会吸收紧邻的失败 cause（runId/driverId/code/blocked/observed），
  所以一条 wake 就带 `orderId / state / observed / reason`；Agent 需要完整记录时读 `p2_report`。
- 投递策略：Agent running 时普通结果本地挂起，idle 后一次 `followup`；critical 才 `steer`
  打断当前轮。任何 completion wake 都不要求 Agent 轮询或调 `Start-Sleep`。
- `p2_order` 只等 accepted；`p2_events` 保留为详细审计，不是主轮询手段。
- body 重启产生新 epoch 与空事件环，从 seq 1 开始；bridge 按 epoch 重置 cursor，
  不会把旧 epoch 的终态当成新结果重复推送。

## 16. Owner session、persona、memory 与 auto-wake（bridge）

- body start 时 bridge 在 owner agent scope 注册 P2 工具、`p2_memory`、六个 `p2-*` skill、`.p2/skills` provider、persona section、memory context 和 auto-wake；stop 时 dispose，fault 只停 auto-wake。
- `.p2/` 由 `p2 start`/`p2_body start` 从 `content/templates/` 创建缺失文件，绝不覆盖已有编辑；`.p2` 整体不入库。
- persona 是 `.p2/persona.md` 的 mtime 缓存 section（≤4KB，`interpolate:false`，order 100）；memory 是 `.p2/memory/<world>/<character>.jsonl`，按 `mind.status.identity` 分 scope，summary 只注入 pinned + 最近 fact/state（2KB/20 条）。
- auto-wake 只看 owner agent 的 idle 静默，不检查“是否正在跑 order”作为触发条件；默认 `skipActiveWork:false`，active order/plan/duty/armed goal 不会阻止唤醒。设为 `true` 才在调度层跳过这些 active work。
- auto-wake 的 wake 与进入门控后的 skip 写 `.p2/wake.jsonl`；silence pending/agent-running 的轮询不写。wake 只是注入一个 turn，不生成 order/duty，也不限制 Agent 的目标选择。

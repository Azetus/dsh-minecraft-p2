# 运行时（P2Mind）

## 1. body 生命周期

1. `p2_body start`（或 `/p2 start`）→ bridge 启动 body 子进程。
2. body 连接 provider（ClientPort 适配器）→ 加载 `content/` 与注册表 → 读意图日志恢复未完成 order。
3. 进入 tick 循环（50ms）。
4. `p2_body stop`：冻结新 dispatch → 请求当前 driver 停止并等待 `stopped` → 落盘意图日志 → 退出。
5. body 重启：epoch 变化；P2Mind 从意图日志 + 世界重建，**不重放 pending 动作**。

## 2. tick 循环

```text
每 tick (50ms):
  obs = sensors.tick(budget ≤ 2ms)                     // 观测缓存，不做网络查询
  constant = constantTree.evaluate(obs)
  if (constant 是 job) tracker.offer(constant)         // 本轮不再求值主树
  else if (constant 是 need-observation / definition-error)
      本轮不再求值主树                                  // 保留当前 job，不猜
  else if (mainTreeDirty || 3s 兜底) {
      mainTreeDirty = false
      tracker.offer(mainTree.evaluate(obs, orders, plan))
  }
  tracker.tick()
  if (tracker.state() === 'idle' && 无候选) idleFallback()
```

**常驻树优先级**：常驻树本轮有结果时，主树不参与候选竞争，也不能用 `nowork` 清空 `pending`。这个门只决定本轮谁来 offer，不改变 order/duty 状态；紧急解除后主树恢复。`mainTreeDirty` 由事件置位：新 order、order 取消、job 终态、plan 一步完成、进入夜晚、饥饿跨阈值、目标失效、冷却到期、对话产生 order。

### 2.1 mineflayer 导航（当前实现）

- `MotionRun` 拥有一次 motion 搜索、执行、恢复和清理；上层仍只下一个目标，不等待模型微操。A* 使用 P2 自研 `MotionSearch`，pathfinder 已从 provider/port 删除。
- 先验证容差内的站位，再以分片 A* 预检路线；每片 5ms、单次搜索 2s、生成节点软上限 12000。显式搜索超时/上限返回 unknown，不折成无路。
- 预检明确 `noPath` 时不出发。预算内尚未证明全程可达但已有前缀时允许推进；前缀不是完成。
- 路径策略默认禁止挖掘、垫块、搭桥、跑酷和冲刺；普通最大脚部落差 2 格。显式 `unstickDig` 是 core break 白名单；没有白名单的块不可挖。
- 无路且目标更低时 motion 会跑“安全下落”第二遍：按 health 预算允许 3 格以上的安全下落；落点必须可站立、已加载、非液体/危险，下落列无阻挡。
- 显式 `policy.hazards.allow` 的 lava/void 目标由 Agent 层 `fatal` driver 执行受控 step-off，只有真实 `died` 才成功；这不是 A* 的普通边。
- `traverse` 是 Agent 显式下发的临时通行原语（`bridge` 同高直线 / `scaffold` 垂直垫脚柱），已委托 motion `moveTo { allowPlace, material }`；provider `pillarUp` 已删除。
- 完成、取消、超时均执行 `stop → clearControlStates`，注销本次监听/定时器。释放未确认不允许另一个 provider act 启动。
- 测试中的地形夹具只检验真实 A*、1.21.1 碰撞数据与本项目策略的组合；不模拟物理，不替代真实 Minecraft/DSH 长跑验收。耗时与重规划指标经移动事件暴露，尚无实机成功率结论。

## 3. 预算

| 项 | 预算 | 超限行为 |
|---|---|---|
| 传感器刷新 | ≤2ms/tick | 跳过本轮，保留旧观测并标 `stale` |
| 常驻树求值 | ≤2ms | 本轮放弃，下轮重试 |
| 主树求值 | ≤10ms | 记 `EVAL_TIMEOUT`，保持当前 job |
| driver tick | 有界（不阻塞循环） | 由 driver 自己分片 |
| 单 job | `maxTicks` + `maxWallMs` | 超限 → `failed(BUDGET_EXCEEDED)` |

游戏 tick 与单调墙钟分开：连接停滞时 `maxTicks` 不会推进，必须由 `maxWallMs` 兜底。

## 4. 抢占与停止

- 常驻树提出候选 → **先判续做**：`keys` 相同则只续期，不重启（避免“着火时每 50ms 重开一次逃生”）。
- 确需切换：`seq++`（旧写令牌失效）→ `driver.requestStop()` → 等 `stopStatus()==='stopped'`。
- `stopping` 超时或 `unconfirmed` → `fault`：冻结新 dispatch、上报 owner；恢复需人工或自愈流程。
- 正常终态也经过停止确认；“promise 已结束”不能代替控制释放。
- 打断时**结束当前 job**，不保留“半步状态”；恢复时由 WorkGiver 重算“下一个可执行工作项”。

### 4.1 让出、hold、blocked、cancel

- `nowork`：让出选择，继续看后续分支。
- `hold`：保留意图，不产生 job，停止下降；order/plan 保持 active。
  - `hold` **order** 不会自己结束，会占住唯一的 active 位并堵住队列；`p2_orders` 的 `queueBlockedBy` 指出这个 barrier，取消用 `p2_cancel {id}` 或 `p2_cancel {all:true}`（取消全部 queued/active）。
- `blocked`：`hold` + 明确 reason + 上报；不自动换任务。
- `cancel`：终态，不自动恢复。

常驻树的 `hold` 会停止当前 job（`CONSTANT_HOLD`）并 critical 上报；同一原因 10s 内不重复，持续 hold 会再次上报，不静默。
`material.gather` 用 32 格区域索引找最近来源；索引按 16×16 列分块、每 tick 最多 2 块，`blockUpdated` 直接增删，中心移动/超时重建并标记 stale；不会每 tick 全量扫 32 格。
`mind.status.metrics` 提供进程内 run metrics：`orders`（accepted/succeeded/failed/blocked/cancelled）、`jobs`（started/succeeded/failed/interrupted/retried/preempted）、`holds`、`holdReasons`、`failureCodes`、`completionRate`、`lastFailure`。`job.terminal` 事件附带 `diagnostic {code,category,hint}`；指标只从事件派生，不读世界。
`mind.status.duty` 是常驻任务视图：`duty.work` 仅在无 active order/plan 时选择 duty.item 的来源并挖取；配额完成/无来源/超时/工作预算会结束为 completed/blocked。显式 order/plan 优先，结束后 duty 恢复；`p2_duty stop` 立即停止。D2 将 active duty 写入 journal 同目录的 `duty.json`：body 重启后，未过期且 identity 匹配的 active duty 自动恢复，`collected` 从背包重算，`jobs` 保留；过期恢复为 `blocked DUTY_DEADLINE`，completed/blocked/stopped 不复活。`plan.work` 全 blocked 返回 `hold`（`notify:false`，由 `plan.blocked` 上报）；`order.attack` 目标丢失/被保护返回 `hold`；`order.hold` 返回 `hold`（`notify:false`）。`hold` 不是成功，也不是失败。

## 5. 工作选择与重试

1. 常驻树 → 紧急 giver → 候选（逃生/进食/脱离）。
2. 主树 → 维护 giver → 当前 order 的 plan giver → 空闲 giver。
3. giver 返回 `Handoff` → 先执行前置工作，完成后重新 `find`。
4. 失败按 `(orderId|workItemId|driverId)` 计数：
   - ≤2 次：同一工作项换站位/换面/换材料重试；
   - 3 次：标记该工作项 `blocked`，WorkGiver 换下一个可执行项；
   - 全部 `blocked`：order `blocked`，唤醒 agent 并附 digest。
5. 原始 order 的 retry 策略：
   - `go / attack / dig / place / use / craft / container` 在 order 内重试，3 次后 `blocked`；
   - `equip / traverse / check` 是一次性，首次失败即终态；
   - `BUDGET_EXCEEDED / BAD_ARGS / STALE_WRITE / CAPABILITY_MISSING / DEFINITION_ERROR` 不重试；
   - `TOOL_INSUFFICIENT / BLOCK_UNBREAKABLE / DIG_NO_BLOCK / APPROACH_NO_STAND / PICKUP_UNREACHABLE / PICKUP_NOT_COLLECTED` 也不重试（重试同一目标不会改变结果）；
   - `ATTACK_TARGET_LOST / ATTACK_TARGET_PROTECTED / ATTACK_TARGET_CHANGED / ATTACK_CHASE_LIMIT / ATTACK_NO_HIT / ATTACK_NOT_KILLED` 同样不重试，避免对同一目标连续做 40s 无用追击；
   - 中间失败写 `job.terminal {retry:true}`，不产生 completion wake；blocked/终态才唤醒 agent。
   - `build` 的 plan 工作项仍按第 4 条由 giver/tracker 重试。

## 6. 恢复

| 情形 | 处理 |
|---|---|
| 意图日志尾部半行 | 丢弃 |
| `action.pending` 未结算 | 只对账（必要时 `check` Job），不重放 |
| order 已取消 | 恢复后保持取消，plan 不复活 |
| 世界/角色/模板/定义版本不匹配 | 拒绝恢复，上报 |
| 能从世界重建的进度（已建方块） | 重建，不依赖内存 |

## 7. 观测与证据

- `WorldView` 是同一份快照，供一次求值使用；谓词不得自行查询。
- 证据三态：`confirmed / refuted / insufficient`；`insufficient` 时发 `check` Job 或超时上报。
- 开熔炉/看箱子这类需要交互的观测，只能由 `check` Job 完成；Verifier 不抢交互能力。
- 三级检查（job 读回 / plan verify / order post）不是三个独立证据源，除非观测路径确实不同。

## 8. agent 能看到什么

| 接口 | 内容 |
|---|---|
| `p2_status` | 当前 order / job / 预算余量 / tracker 状态 / 最近偏差摘要 |
| `p2_observe {min,max｜points,detail}` | 只读语义观测：box（`blocks` / `counts` / `surface`）或定向 points；未加载块 `loaded=false`；上限 4096 块 / 64 轴 / 256 点；不做视锥/遮挡过滤；附当前 `biome` |
| `p2_entities {center?,radius?,types?,names?,limit?}` | 不移动的实体/掉落物观测：半径 ≤160、limit ≤512、按距离排序；掉落物带 `item.name/count`；只受服务器跟踪范围限制 |
| `p2_preview_blueprint {blueprint}` | 只读 dry-run：必需/缺料、冲突（当前方块、是否可拆）、未加载格、非法字段；不消耗材料、不清障、不放置 |
| `p2_order {verb,params,...}` | 只返回 accepted（`{accepted:true,id,state}`）；终态/blocked/失败由 completion wake 异步推送，调用后结束本轮 |
| `p2_report` | 最近一次偏离或终态的 digest（一句话 + 结构化字段） |
| `p2_events {sinceSeq}` | 详细事件审计（order/job/plan/tracker/move）；仅供排查，不是主轮询手段 |
| 唤醒 | order 终态、plan.blocked、job.terminal failed/blocked、tracker fault、感知 critical、对话 |

`surface` 每列同时给出最高非空气块（`y/name`）与最高实心块（`solidY/solidName`）：草、花等不计入实心面；适配器无法判断时 `solid` 省略，按非空气处理。

## 9. 失败模式

| 现象 | 判定 | 处理 |
|---|---|---|
| driver 停止无法确认 | `STOP_UNCONFIRMED` | tracker fault，冻结 dispatch，上报 |
| 长期无观测更新 | `OBSERVATION_STALE` | 暂停新 job，保留当前，等恢复 |
| 服务器暂停（server age 停滞） | `GAME_PAUSED` → `suspended` | 中止当前动作但不计失败；order/plan 保持 active；watchdog/墙钟冻结；恢复后重观测再继续；超长暂停只通知 |
| 同一工作项反复失败 | `WORK_ITEM_BLOCKED` | 换工作项；全部阻塞 → order blocked |
| 材料不足且不可自动补给 | `NO_MATERIAL` | order blocked，唤醒 agent |
| 服务器拒绝放置 | `PLACE_REFUSED` / `PLACE_READBACK_MISMATCH` | 该 work item 记失败；policy 决定跳过/清障/重试 |
| 放置被接受但方块后来消失 | `BLUEPRINT_REFUTED` | 终态验证不通过；order failed，agent 决定补建/换址 |
| 定义错误（树/模板/注册表） | `DEFINITION_ERROR` | 拒绝加载并上报；body 启动期失败，不半加载 |

## 10. 放置是“尝试”，不是永久承诺

- `place` 不预判目标格是否可替换；任何目标都尝试，服务器接受/拒绝才是放置结果。
- 目标可以是水/岩浆等流体；底层不维护 replaceable 名单，也不把非空气一律当冲突。
- place 的 `ok` 只表示“服务器接受了这次操作，且即时读回是 expected”；不表示方块会永久存在。
- 终态由 verifier 判定：build order 验证每个期望方块仍在；sealed-room 验证外壳/内部。
- 执行期间 plan 每 tick 重算工作项：方块消失会重新变成 unsatisfied，按 policy 重试或 blocked；不用计时器或异步稳定窗口。
- 完成之后的世界变化属于后续观测/check，不归 place 保证。

### 10.1 放置面与朝向（当前限制）

- place driver 目前**不能指定朝向**：它按 `up → down → north → south → east → west` 的固定顺序
  找第一个实心邻居作为参考面并尝试；这不是随机，也不由 Agent 选择。
- 没有“自动选面”的显式 API；参考面由 driver 的支撑邻居扫描决定，provider 只是执行。
- Minecraft 的最终方块状态还取决于玩家朝向、放置面与方块规则；当前不能保证得到特定 state。
- 因此台阶的上/下半、楼梯/门/火把的朝向、部分红石元件的朝向都可能与 `expected.state` 不一致；
  `expected.state` 只用于**验证**，不是可指定的放置参数。
- 不一致会表现为 `PLACE_READBACK_MISMATCH` 或 plan 失败/blocked，而不是被自动纠正。
- 若未来需要定向放置，应在 place 参数中增加显式的 `face`/`look`/`orientation` 语义，
  并同步 ClientPort 契约；当前保持现状。

### 10.2 冲突策略（M3-03）

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

### 10.3 材料策略（M3-03）

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

### 10.4 恢复与归因（M3-04）

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
  - `worldId`：provider 配置 `worldId`（默认 `host:port`）+ dimension；
  - `characterId`：provider 的玩家 UUID/username；
  - `defVersion`：plan 模板内容摘要（`defScope: "plans"`）；树定义已代码化，不参与身份。
- `worldId` / `characterId` / plan `defVersion` 任一不一致 → `RECOVERY_IDENTITY_MISMATCH`，拒绝恢复并上报。
  旧版 journal（identity 无 `defScope`）按 world/character 接受一次，下一次写入补写 plan-only 头；
  无 identity 头的 legacy journal 仍可读，下一次写入会补头。
- 身份来自 provider，不需要 Agent 每次传；未来 client-mod 可提供更稳定的 world/character ID。
- 开发测试专用：`.p2/config.json` 的 `crashAfterPending: true` 会在首个
  `action.pending` 写入后让 body 真实退出一次（标记 `.p2/crash-after-pending.done`），
  用于验证“pending 窗口崩溃 → 重启对账”。生产配置不应开启。

### 10.6 游戏内对话推送给 Agent（M4）

- 对话**不由 body 解析**：`ClientPort` 的 `chat` 事件进入 body 有界队列（100 条），
  通过 `chat.poll {afterSeq}` 暴露给 bridge；`chat.say {text}` 只负责发一句话。
- bridge 每 300ms poll 一次；新消息交给 `ChatBatcher` 合并：
  - 单条等待 1s 防抖后推送；
  - 连续聊天最多 3s 强制合并推送一次，避免高频聊天反复打断 Agent。
- 合并后通过 DSH `Agent.followup/steer` 作为一条 user 消息推送：
  `[p2 chat] ... 请用 p2_say 回复；需要改变目标时用 p2_order / p2_cancel。`
- Agent 用 `p2_say` 回复；body 不解析语言、不自动创建 order。
- bot 自己的聊天回显在 provider 层忽略，避免自回环。
- 只有 active body 的 owner 会收到 wake；重启后 cursor 归零。

### 10.7 check Job（M4-02）

- `check` 是 order verb：`p2_order {verb:"check", params:{x,y,z}}`。
- check giver 从 active check order 选目标；check driver 才打开界面（箱子/熔炉等），
  结果写入 `job.terminal.observed`，并另发 `check.result`。
- 三态：`observed.state = ok | failed | unknown`；`unknown` 不会被当作成功。
- Verifier 仍只用世界方块/物品快照；需要界面数据时必须排队 check，不直接开窗。

### 10.8 idle 边界与执行原语（M4-03 重构）

- 默认无 order：**hold**，不自动选择生活行为。
- 只保留即时逃生反射：lava/深水/近身威胁/有顶掩体；不自动攻击。
- Agent 显式 order（有限执行面，不再为 CP 增加专用 order）：
  - `go`：移动到坐标/附近；
  - `place`：放任意方块/床，`item` + 目标；
  - `dig`：破坏指定方块；
  - `equip`：切换手持物品/工具；
  - `use`：使用方块/实体/物品（床睡觉、门、按钮、食物）；
  - `attack`：攻击 Agent 明确指定的 entityId，锁定目标做有限追击/连续攻击，直到目标消失或预算/目标边界失败。
  - `check`：打开容器/熔炉做三态观测；
  - `container`：容器存取，`withdraw/deposit/load-input/load-fuel/take-*`；
  - `craft`：按配方合成；
  - `build`：执行最终几何 blueprint/Plan；
  - `traverse`：Agent 授权的桥/垫脚移动；
  - `hold`：原地待命。
- 组合由 Agent 完成：找矿 = `p2_observe` + `go`；挖矿 = `equip` + `dig`；
  床 = `place` + `use`；熔炼 = `container` + `use/check` + `container`。
- 失败上报，不自行消耗食物或改变目标。
- P2Mind 不自行决定睡觉、建家、进食或游荡；`home` 只是 Agent 可使用的坐标。
- Agent 战逃提示词见 `docs/runtime/AGENT-REACTION.md`：IMMEDIATE 先动作后观察，
  FIGHT 仅在已有 combat ROE 时使用，否则默认 FLIGHT。

### 10.9 感知与唤醒粒度（M4 后）

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
- 策略：普通 digest/chat 在 Agent running 时由 P2 本地挂起，等 idle 后只 `followup` 一次；
  只有本地无法处理/需要改变目标的 critical 才 `steer`。
- 世界全量变化仍只在观测层/Verifier；不进入感知通知。

### 10.10 异步完成通知（completion wake）

- bridge 与 chat/perception 共用 300ms 轮询，读 `mind.events {sinceSeq}`。
  事件 cursor 以 **body epoch** 为边界：epoch 变化时归零并丢弃旧 epoch 的待发结果；
  同一 epoch 内按 `seq` 前进，重复轮询不会重复推送。
- 必推（critical，不等待合并）：
  - `order.terminal` 的 `failed / blocked / abandoned`；
  - `plan.blocked`；
  - `job.terminal` 的 `failed` 或 `blocked=true`；check job 的 `succeeded` 只表示观测完成，
    若 `observed.state=failed/unknown` 也作为失败 cause 推送；
  - `tracker.fault`，以及直接导致终态的 `plan.material-short / plan.abort /
    plan.verify(refuted) / plan.definition-error / action.unreconciled`。
- 成功/取消合并：`job.terminal` 成功不单独唤醒；`order.terminal` 成功走 250ms
  合并窗口，一条 DIGEST；多个成功结果合成一条。
- `order.terminal` 会吸收紧邻的失败 cause（runId/driverId/code/blocked/observed），
  所以一条 wake 就带 `orderId / state / observed / reason`；Agent 需要完整记录时读 `p2_report`。
- 投递策略：Agent running 时普通结果本地挂起，idle 后一次 `followup`；critical 才 `steer`
  打断当前轮。任何 completion wake 都不要求 Agent 轮询或调 `Start-Sleep`。
- `p2_order` 只等 accepted；`p2_events` 保留为详细审计，不是主轮询手段。
- body 重启产生新 epoch 与空事件环，从 seq 1 开始；bridge 按 epoch 重置 cursor，
  不会把旧 epoch 的终态当成新结果重复推送。

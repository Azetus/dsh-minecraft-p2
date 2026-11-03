# 操作员手册（P2Mind）

> 目标是让角色像一个有点笨的玩家：agent 下目标，P2Mind 自己干活；agent 只在中断/偏离时介入。

## 1. 启动

1. 人类：`/p2 setup` → `/p2 start`；或开发时 `p2_body start`。
2. `p2_status`：确认 `connection=connected`、`bodyEpoch` 非空、owner 是本 session。
3. `p2_observe`：确认进服、维度、位置与周围方块。

## 2. 下 order

```text
p2_order {verb:"go", params:{x:48,y:64,z:30}}
p2_order {verb:"build", blueprint:{blocks:[...]}, policy:{conflict:{mode:"clear"}, materials:{mode:"auto-gather"}}}
p2_order {verb:"equip", params:{item:"stone_pickaxe"}}
p2_order {verb:"dig", params:{x:12,y:48,z:-3}}
p2_order {verb:"container", params:{x:47,y:64,z:29,action:"take-output",item:"charcoal",count:1}}
p2_order {verb:"use", params:{x:51,y:64,z:31}}
```

- 有限词表：`go / place / dig / equip / use / attack / check / container / craft / build / traverse / hold`。
- 常驻任务用 `p2_duty`，不是 order：`{action:"start",duty:{kind:"gather",item:"dirt",quota:8,radius:16}}`；`p2_duty {action:"stop"}`。显式 order/plan 会暂停 duty。D2 起 duty 会在 body 重启后恢复（未过期且 world/character 匹配）；过期会变成 `blocked DUTY_DEADLINE`，需重新启动。
- `p2_status` 的 `mind.metrics` 给出本轮 run 的 order/job/hold/失败码/完成率；`lastFailure` 带 category/hint。它不包含 Agent 工具调用数或人工救场数，这两项看 DSH session 日志/操作记录。
- 位置用坐标、命名地点或约束表达；不要用逐 tick/逐格动作代替组合。
- 可带 `blueprint` 表达非标结构；可达性与冲突由 Planner 处理。
- 一次只推进一条活动 order；后续 order 排队。

## 3. 巡检

- `p2_status`：当前 order、job、`reportString`、预算余量、tracker 状态、最近偏差。
- 唤醒时读 `p2_report`：`{order, state, step, code, attempts, budgetLeft, lastOk, hint}`。
- `p2_events {sinceSeq}` 只用于详细审计；不要轮询。

**只在三种唤醒时行动**：order 终态、偏离阈值、tracker fault。正常执行期间不要介入。

## 4. 停止与替换

| 操作 | 效果 |
|---|---|
| `p2_cancel {id}` | 取消 order；结束其当前 job（等待停止确认） |
| `p2_order` 新一条 | 排队；替换类命令走立即替换语义 |
| `p2_body stop` | 冻结 dispatch → 等停止 → 落盘 → 退出 |
| `p2_body restart` | 重启 body；P2Mind 从意图日志 + 世界重建 |

## 5. 异常处理

| 现象 | 处理 |
|---|---|
| `blocked(NO_MATERIAL)` | 补材料 order，或改 `materialPolicy` 允许自动补给 |
| `failed(TOOL_INSUFFICIENT)` | 先装备/合成合适工具；只想清掉方块时用 `dig purpose:"clear"` |
| `hold(GO_NO_STAND)` | 目标 2 格内没有可站立格；换坐标，或先整理/确认目标高度 |
| `failed(APPROACH_NO_STAND)` | 目标方块周围没有可站立格；换目标面或先清理/接近 |
| `failed(PICKUP_UNREACHABLE)` | 掉落物不可达；换落点、先整理地形，或接受掉落损失 |
| `failed(PICKUP_NOT_COLLECTED)` | 已到掉落物旁但未拾取；检查背包空间/服务端延迟，不要重复同一 dig |
| `failed(ATTACK_TARGET_LOST)` | 目标已离开 32 格/消失；重新获取 entityId 并确认，不要盲目追击 |
| `failed(ATTACK_TARGET_PROTECTED)` | 玩家/中立目标未授权；换目标或显式 `allowPassive`（玩家永不允许） |
| `failed(ATTACK_NOT_KILLED)` | 24 次攻击/40s 内未击杀；检查武器/目标类型，重新下令 |
| `blocked(SITE_NOT_FOUND)` | 换区域/换蓝图变体 |
| `WORK_ITEM_BLOCKED` | 通常是支撑/站位问题；换变体或换点 |
| `failed(ACT_UNCONFIRMED)` | 动作可能已生效、效果未知；先 `p2_observe`/`check` 读回，不要原样重下 |
| `failed(ACT_TIMEOUT)` | 预算内无终态但动作可安全重试；重试仍失败就换目标/方案 |
| `tracker.fault(STOP_UNCONFIRMED)` | 不要继续下 order；先重启 body，再看意图日志 |
| `OBSERVATION_STALE` | 检查连接；恢复后自动继续，不重放 pending |
| `mind.hold(NO_SAFE_TARGET)` | 常驻树找不到安全格；先人工确认环境/改任务，不要重复下同一 order |
| `mind.hold(ATTACK_TARGET_LOST/PROTECTED)` | 目标丢失或受保护；重新指定目标或取消该 order |
| `HOLD_ORDER` | 已知等待，不需要处理；取消 order 才结束 |
| 反复同一根因 | 换蓝图、区域或 giver/driver 参数，不要重复下同一条 order |

## 6. 纪律

1. 不逐步微操：不要用调试入口替角色走路/放置；需要改行为就改蓝图或参数。
2. 不轮询：等唤醒；巡检间隔 ≥60s。
3. 不重复下同一 order：同一目标第二次失败，先看 `hint`，换策略而不是重试。
4. 证据优先：order 成功必须有 `confirmed` 证据；`insufficient` 不算完成。
5. 一次只跑一条控制路径：不要同时开两个 body/两个 order 源。

## 7. 安全

- 危险（水/岩浆/着火/敌对贴身）由常驻树处理，**不要**为了任务压掉逃生；只有 order 显式 `hazards.allow` 才允许压过对应反射。
- 夜间/危险环境由 Agent 决定休息或避险；P2Mind 不做自主睡眠/建造/采集决策，v1 只做 eat/retreat/unstuck。
- 对话：验收场景可关闭对话；任何情况下都不接受 `/` 开头的请求。
- 禁止：游戏指令、传送、改模式、改 gamerule、注入物品。

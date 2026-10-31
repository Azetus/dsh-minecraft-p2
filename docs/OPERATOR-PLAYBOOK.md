# 操作员手册（P2Mind）

> 目标是让角色像一个有点笨的玩家：agent 下目标，NPC 自己干活；agent 只在中断/偏离时介入。

## 1. 启动

1. 人类：`/p2 setup` → `/p2 start`；或开发时 `p2_body start`。
2. `p2_status`：`connection=connected`、`bodyEpoch` 非空、owner 是本 session、`mind.state=idle`。
3. `p2_card` + `p2_observe {op:"position"}`：确认进服、维度、位置。

## 2. 下 order

```text
p2_order {verb:"shelter", params:{quality:"minimal"}, constraints:{before:{timeOfDay:10800}, within:{radius:48}}}
p2_order {verb:"gather", params:{resource:"birch_log", count:6}}
p2_order {verb:"bed"}
p2_order {verb:"mine_copper", params:{layer:48}}
p2_order {verb:"smelt", params:{item:"copper_ingot", count:1}}
```

- 词表是受限的；不接受坐标、不接受单格动作。
- 可带 `blueprint`（模板 JSON）表达非标结构；只给相对布局，选址由 Planner 做。
- 约束常用：`before`（游戏时间/预算）、`within`（相对 anchor 半径）、`avoid`、`quality`。
- 一次只推进一条活动 order；后续 order 排队。

## 3. 巡检

- `p2_status`：当前 order、job、`reportString`、预算余量、`tracker.state`、最近偏差。
- `p2_events {sinceSeq}`：order/job/plan/tracker 事件；不要轮询 `status` 全量。
- 唤醒时读 `p2_report`：`{order, state, step, code, attempts, budgetLeft, lastOk, hint}`。

**只在三种唤醒时行动**：order 终态、偏离阈值、tracker fault。正常执行期间不要介入。

## 4. 停止与替换

| 操作 | 效果 |
|---|---|
| `p2_cancel {id}` | 取消 order；结束其当前 job（等待停止确认） |
| `p2_order` 新一条 | 排队；替换类命令（`come`/`stop`）走立即替换语义 |
| `p2_body stop` | 冻结 dispatch → 等停止 → 落盘 → 退出 |
| `p2_body restart` | 重启 body；P2Mind 从意图日志 + 世界重建 |

## 5. 异常处理

| 现象 | 处理 |
|---|---|
| `blocked(NO_MATERIAL)` | 补材料 order，或改 `materialPolicy` 允许自动补给 |
| `blocked(SITE_NOT_FOUND)` | 换区域/换模板变体（flat/slope/dig-in） |
| `WORK_ITEM_BLOCKED`（单格反复失败） | 通常是支撑/站位问题；换变体或换点 |
| `tracker.fault(STOP_UNCONFIRMED)` | 不要继续下 order；先重启 body，再看意图日志 |
| `OBSERVATION_STALE` | 检查连接；恢复后自动继续，不重放 pending |
| 反复同一根因 | 换**计划模板**或 **giver/driver 参数**，不要重复下同一条 order |

## 6. 纪律

1. 不逐步微操：不要用调试入口替角色走路/放置；需要改行为就改模板或 giver。
2. 不轮询：等唤醒；巡检间隔 ≥60s。
3. 不重复下同一 order：同一目标第二次失败，先看 `hint`，换策略而不是重试。
4. 证据优先：order 成功必须有 `confirmed` 证据；`insufficient` 不算完成。
5. 一次只跑一条控制路径：不要同时开两个 body/两个 order 源。

## 7. 安全

- 危险（水/岩浆/着火/敌对贴身）由常驻树处理，**不要**为了任务压掉逃生。
- 夜间在屋外：`policy.idle` 设 `shelter-only` 或 `conservative`。
- 下矿：`policy.idle` 设 `shelter-only`，避免空闲时挖进。
- 对话：验收场景可 `policy.dialogue=off`；任何情况下都不接受 `/` 开头的请求。
- 禁止：游戏指令、传送、改模式、改 gamerule、注入物品。

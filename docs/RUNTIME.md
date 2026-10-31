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
  if (cheapDanger || 10Hz 到期)
      tracker.offer(constantTree.evaluate(obs))
  if (mainTreeDirty || 3s 兜底) {
      mainTreeDirty = false
      tracker.offer(mainTree.evaluate(obs, orders, plan))
  }
  tracker.tick()
  if (tracker.state() === 'idle' && 无候选) idleFallback()
```

`mainTreeDirty` 由事件置位：新 order、order 取消、job 终态、plan 一步完成、进入夜晚、饥饿跨阈值、目标失效、冷却到期、对话产生 order。

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
- 打断时**结束当前 job**，不保留“半步状态”；恢复时由 WorkGiver 重算“下一个可执行工作项”。

## 5. 工作选择与重试

1. 常驻树 → 紧急 giver → 候选（逃生/进食/脱离）。
2. 主树 → 维护 giver → 当前 order 的 plan giver → 空闲 giver。
3. giver 返回 `Handoff` → 先执行前置工作，完成后重新 `find`。
4. 失败按 `(orderId|workItemId|driverId)` 计数：
   - ≤2 次：同一工作项换站位/换面/换材料重试；
   - 3 次：标记该工作项 `blocked`，WorkGiver 换下一个可执行项；
   - 全部 `blocked`：order `blocked`，唤醒 agent 并附 digest。

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

`surface` 每列同时给出最高非空气块（`y/name`）与最高实心块（`solidY/solidName`）：草、花等不计入实心面；适配器无法判断时 `solid` 省略，按非空气处理。
| `p2_report` | 最近一次偏离或终态的 digest（一句话 + 结构化字段） |
| `p2_events {sinceSeq}` | order/job/plan/tracker 事件游标 |
| 唤醒 | 只在 order 终态、偏离阈值、tracker fault 时推送 |

## 9. 失败模式

| 现象 | 判定 | 处理 |
|---|---|---|
| driver 停止无法确认 | `STOP_UNCONFIRMED` | tracker fault，冻结 dispatch，上报 |
| 长期无观测更新 | `OBSERVATION_STALE` | 暂停新 job，保留当前，等恢复 |
| 同一工作项反复失败 | `WORK_ITEM_BLOCKED` | 换工作项；全部阻塞 → order blocked |
| 材料不足且不可自动补给 | `NO_MATERIAL` | order blocked，唤醒 agent |
| 服务器拒绝放置 | `PLACE_REFUSED` / `PLACE_READBACK_MISMATCH` | 该 work item 记失败；policy 决定跳过/清障/重试 |
| 放置被接受但方块后来消失 | `BLUEPRINT_REFUTED` | 终态验证不通过；order failed，agent 决定补建/换址 |
| 定义错误（树/模板/注册表） | `DEFINITION_ERROR` | 拒绝加载，保持上一版有效内容 |

## 10. 放置是“尝试”，不是永久承诺

- `place` 不预判目标格是否可替换；任何目标都尝试，服务器接受/拒绝才是放置结果。
- 目标可以是水/岩浆等流体；底层不维护 replaceable 名单，也不把非空气一律当冲突。
- place 的 `ok` 只表示“服务器接受了这次操作，且即时读回是 expected”；不表示方块会永久存在。
- 终态由 verifier 判定：build order 验证每个期望方块仍在；sealed-room 验证外壳/内部。
- 执行期间 plan 每 tick 重算工作项：方块消失会重新变成 unsatisfied，按 policy 重试或 blocked；不用计时器或异步稳定窗口。
- 完成之后的世界变化属于后续观测/check，不归 place 保证。

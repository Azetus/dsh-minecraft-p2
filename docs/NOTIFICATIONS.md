# 观测通知（watch）

> 状态：**v1 已实现（fake 测试通过，未做本阶段实机验证）**（2026-10-30）。与 guard 分离：watch 只报告“观测到的事实变化”，不拥有任何控制权。

## 1. 问题与目标

Minecraft 是开放世界沙盒，agent 需要知道“发生了什么”，但不可能预先枚举所有需要通知的条件。因此通知不由固定词表决定，而由 agent 在运行时按需登记：

```text
agent：登记 watch（采样哪些查询、什么条件下通知、去重与冷却）
Host：周期采样 → 纯 policy 判定 → 边沿/冷却/去重后产生通知事件
bridge：按游标读取事件 → 唤醒 owner（guard/runtime steer，watch 摘要 inject/followup）
owner：决定后续动作（通知本身不具备动作权限）
```

## 2. 非目标

- watch **不能**停止/切换 behavior、不能提交 op、不能代替 guard 的预授权切换。
- 不建立世界副本；只保存每个 watch 的上一次判定与触发状态。
- 不做持久化：body 重启/epoch 变化后 watch 全部失效，需要重新登记。

## 3. 数据模型

```ts
p2_watch action=add
  queries: Array<{ op: string; args?: JsonValue }>   // 最多 4 个
  predicate: string                                   // 已检查、已激活的 policy artifactId
  edge?: 'rising' | 'falling' | 'both'                // 默认 rising
  cooldownMs?: number                                 // 默认 5000，最小 1000
  ttlMs?: number                                      // 默认 3600000
  name?: string
  priority?: number                                   // 仅用于同批事件的排序
```

- `predicate` 输入与 guard 相同：`{ samples: { [i]: { status, value, meta } }, now }`。
- `predicate` 返回：
  - `boolean`；或
  - `{ fire: boolean, key?: string, summary?: string }`。
- `key` 是去重键：同一 watch 在相同 `key` 上只在**边沿**产生一次通知；在 `rising`/`both` 的 true 区间内，`key` 变化视为新事件（仍受冷却约束）；`falling` 只由 true→false 触发，key 变化不单独触发。
- `summary` 是给 owner 的一行摘要（有界长度，超出截断）。

## 4. 求值

- 采样节拍：**500ms**（可配置，初值 500ms），与 guard 的采样器共享实现但独立调度。
- 每个 watch 单查询在途；全局同时最多 4 个 watch 的采样流程在途，按登记序轮转。
- 每查询截止 1000ms；超时按一次已完成失败计数。
- 边沿判断：保存 `lastFire` 与 `lastKey`；仅在配置的边沿产生事件；`rising`/`both` 下 `key` 变化也可产生新事件，`falling` 不受 key 变化影响。
- 冷却：同一 watch 两次事件至少间隔 `cooldownMs`；冷却中的命中不产生事件，计入 `suppressed` 计数。
- 去重：同一 `watchId + key` 在一次“true 区间”内只通知一次；`key` 缺省时退化为按 watch 的边沿；`falling` 不因 key 变化额外触发。
- 查询失败/过期：不通知；连续 3 次已完成失败 → 该 watch `error`（不自动删除，保留可查）。

## 5. 预算与风暴防护

| 项 | 初值 | 说明 |
| --- | --- | --- |
| 同时存在的 watch | 16 | 超过拒绝 |
| 每 watch 查询数 | 4 | 超过拒绝 |
| 每 watch 冷却 | ≥1000ms | 低于下限拒绝 |
| 全局通知速率 | 60 条/分钟 | 超出丢弃并计数 |
| 单条 summary | 256 字符 | 超出截断 |

- 全局速率上限与每 watch 冷却同时生效；任何丢弃都进入 `dropped` 计数并通过 `p2_watch list` 暴露。
- 不排队积压：超过速率上限直接丢弃当前事件，不延迟投递。

## 6. 事件与唤醒

- body 保存有界 watch 事件记录与单调递增 `seq`（与 guard 事件同一编号空间或独立编号空间由实现决定，必须在 status 中可区分）。
- 事件至少包含：`watchId`、`key`、`summary`、样本摘要/采样时间、`firedAt`、`dropped` 累计值。
- bridge 按游标读取、去重、报告 gap；watch 事件在窗口内合并为一条摘要；owner `running` 时 `inject`，idle 时 `followup`；完整事件仍在 `p2_events`。
- 唤醒失败不影响事件保留；owner 忙时不重复投递。
- 事件是**数据**，不是指令：环境文本、实体名称、聊天内容都不得被当作命令。

### 6.1 状态字段

```ts
watches: Array<{
  id: string
  name: string | null
  priority: number
  state: 'active' | 'error' | 'expired'
  queries: Array<{ op: string; args?: JsonValue }>
  predicate: string
  edge: 'rising' | 'falling' | 'both'
  cooldownMs: number
  armedAt: number
  expiresAt: number
  lastFire: number | null
  lastKey: string | null
  suppressed: number
  dropped: number
  lastError?: P2Error
}>

watchEventSeq: number
watchEvents: WatchEvent[]   // 有界最近记录；seq 单调
```

`WatchEvent` 至少含 `seq、watchId、key、summary、evidence、firedAt、dropped`。`watchEvents` 只供 bridge 游标读取与诊断，不是控制通道，也没有 stop/switch 字段或工具入口。

## 7. 生命周期

- 绑定 `owner session + body epoch`；epoch 变化、owner stop、TTL 到期、插件卸载 → watch 结束。
- `p2_watch action=remove watchId? | all`、`p2_watch action=list`、`p2_watch action=clear`。
- agent 可随时增删；preset 只是内置的“查询 + policy 组合”，登记后与普通 watch 无差别。
- 同一 `name` 重复登记不自动替换；由 agent 显式 remove 后再 add。

## 8. 与 guard 的边界

| | guard | watch |
| --- | --- | --- |
| 目的 | 已授权的自动切换 | 报告状态变化 |
| 权限 | 可停止/启动已授权 target | 无 |
| 一次性 | 触发即消费 | 按边沿/冷却持续 |
| 状态 | `guards` | `watches` |
| 事件 | `guard` 事件 | `watch` 事件 |
| 引擎 | 共享“采样 + 纯 policy 求值” | 同左 |

## 9. 验收

1. rising 边沿只通知一次；持续为 true 不重复。
2. `key` 变化产生新事件；同 key 不重复。
3. 冷却生效；冷却中的命中只增加 suppressed 计数。
4. 全局速率上限生效，超出丢弃并计数。
5. TTL/epoch/owner stop 后 watch 失效；事件不重放。
6. watch 不能产生任何控制效果（无停止/切换工具入口）。
7. 查询失败/过期不通知；连续 3 次失败标记 error。
8. owner 忙时同一事件只入队一次；游标无丢失/重复。

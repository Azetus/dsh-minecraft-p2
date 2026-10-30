# artifact 提示词 · guard / watch / policy

> 读者：主 session（登记）与 subagent（写 policy）。设计依据：`docs/THREAT-REACTION.md`、`docs/NOTIFICATIONS.md`。

## 1. 先分清三件事

| 目的 | 用 | 夺控制权 | 时间尺度 |
| --- | --- | --- | --- |
| 秒级抢占：把角色从危险动作里切走 | **guard** | 是（切 behavior） | 250ms 采样 |
| 只告诉我发生了什么 | **watch** | 否 | 500ms 采样 |
| 动作级"不许发生"（计划中） | invariant / act preconditions | 否（veto） | 同一采样 |

**guard 不是通知工具；watch 不是保护工具。** 需要"既保护又通知"就各登记一个。

## 2. guard 的硬语义（登记前必须知道）

- 条件是"声明查询 + 纯 policy"，最多 4 个查询；或 `hpBelow` 语法糖。
- **单次消费**：触发一次后该 guard 的授权即被消费，不会自动重新武装；需要持续保护就重新 `set`。
- **边沿语义**：按 false→true 触发。**武装时条件已为真不会补触发**；先 `clear` 再 `set`，或等条件回落。
- 上限 8 个；按 priority 串行处理；trigger 后要等当前 run 停止并确认释放（约 300ms 量级），因此**只适合领先指标**。
- 目标必须是已激活 artifact；参数快照随 guard 固定。
- policy artifact 本身不能 `p2_activate`（它是依赖），在 guard/watch 里按 artifactId 引用即可。

## 3. 领先指标 vs 滞后指标

| 危险 | 用（领先） | 不要用（滞后） |
| --- | --- | --- |
| 苦力怕 | `entities{name:'creeper',maxDistance:8}` 距离 ≤6 | hp 阈值（爆炸一次 20+ 伤害，等于来不及） |
| 溺水 | `health.oxygen < 10 且 position.inWater` | hp 阈值（约 15s 归零） |
| 战斗劣势 | 敌对数 + 自身 hp 组合 | 只看 hp |
| 夜间 | `time.timeOfDay ≥ 13000` | 看天色（不可测） |

## 4. watch 的硬语义

- 边沿：`rising` / `falling` / `both`；冷却避免刷屏；`ttl ≤ 1h` 且**到期无事件提示**，巡检时必须检查 `watches` 数量并续期。
- watch 采样会写 trace；开了 watch 就不要把 `p2_trace` 当长窗口统计。
- 谓词是 policy artifact：入参 `{ samples: {'0': {status, value, meta}}, now }`，返回 `{fire, key, summary}`；必须自行检查 `meta.validUntil`。

## 5. policy 写法

```js
definePolicy({
  manifest: { id: 'low-oxygen', inputs: ['samples', 'now'], outputs: [] },
  run: (inputs) => {
    const s = inputs.samples['0']
    const h = s && s.status === 'ok' ? s.value : null
    const wet = h !== null && h.oxygen !== null && h.oxygen < 10
    return { fire: wet, key: wet ? 'low' : 'ok', summary: wet ? 'oxygen ' + h.oxygen : 'ok' }
  },
})
```

规则：

- 纯函数、无 I/O、无副作用、快速返回。
- **同一危险要同时判断上下文**：低氧必须与 `inWater` 同时成立（陆地也会读到低值）。
- 返回 `key` 要稳定（用于边沿比较），不要放时间戳/随机数。

## 6. 反例

| 反例 | 问题 |
| --- | --- |
| 只登记 `hpBelow 8` 当唯一保护 | 溺水/爆炸在 8 之前就致命 |
| `low-oxygen` 不判断 `inWater` | 陆地误触发 |
| 武装 guard 时条件已成立 | 不触发（边沿语义），误以为"保护在" |
| watch TTL 1h 后不复检 | 静默失效，错过夜间/危险通知 |
| 同一危险既写 guard 又写 behavior 分支 | 两套逻辑打架，行为不可预测 |
| policy 里返回带时间戳的 key | 每次都算"新边沿"，刷屏 |

## 7. 自检清单（登记前）

- [ ] 这是"抢占"（guard）还是"通知"（watch）？两者都登记了吗？
- [ ] 指标是领先的吗？是否与上下文（inWater/距离）联合判断？
- [ ] guard：目标已激活、优先级合理、TTL 合理、触发后被消费这一点是否纳入巡检？
- [ ] watch：边沿选对、冷却够长、TTL 会在巡检时续期。
- [ ] policy：纯函数、检查 `validUntil`、`key` 稳定。
- [ ] 触发后的接管行为本身是安全的（例如水下逃生链，而不是在水里 pillar）。

## 8. 交付格式

```
类型：guard / watch
条件（queries + policy 文件路径）：
边沿 / 冷却 / TTL / 优先级：
目标 behavior（artifactId 或路径）：
触发后的接管动作是否安全（依据）：
已知不确定点：
```

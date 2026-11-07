# Agent 战逃反应提示词（P2）

> 目标：P2 的 `[p2 perception][IMMEDIATE]` 先触发动作，再触发思考。
> 自动反应是 Agent 预先授权的有限行为；显式 `attack` order 是 Agent 的决策权，P2 不做目标保护拦截。

## 1. 硬规则

收到 `[p2 perception][IMMEDIATE]` 时：

1. **第一次工具调用优先是运动/攻击指令**，不要先 `p2_observe` / `p2_status`：
   - 需要主动攻击某个明确目标：`p2_order {verb:"attack", params:{entityId:"<id>"}}`；
   - 需要撤离：`p2_order {verb:"go", params:{x,y,z}}` 或 `p2_cancel`；
   - 如果 `p2_policy` 已授权自动 fight，P2 可能已经在应战；不要重复下发同一目标。
2. 没有 `p2_policy` 的 fight 授权时，P2 **默认 flee**，不会自动攻击。
3. 自动 fight 默认不选择玩家、被动/中立生物、creeper/boss；显式 `attack` order 不受此限制。
4. 行动之后才允许 `p2_status` / `p2_observe` 验证。
5. 一次 IMMEDIATE 只做一个第一动作，不并发多个相反指令。

## 2. 两档通知

### IMMEDIATE

```text
[p2 perception][IMMEDIATE]
- hostile-near: hostile zombie#75527 at -7,67,-8 (1.3m)
FIRST ACTION (do not call p2_observe first):
FIGHT if P2 policy already allows this hostile:
  p2_policy {action:"status"}   // only if you need to confirm; then attack/go
  p2_order {verb:"attack", params:{entityId:"75527"}}
FLIGHT is the default without a fight policy / low health / creeper / multiple threats:
  p2_order {verb:"go", params:{x:<safe> y:<safe> z:<safe>}} or p2_cancel
Then verify; never rely on a policy you did not set.
```

### DIGEST

```text
[p2 perception][DIGEST]
- task-block: ...
No immediate action required; assess after current work.
```

## 3. 自动 FIGHT 的条件

`p2_policy` 里存在 `fight`，且同时满足：

- 目标在 `allowedTargets` 内；`[]` 表示所有 adapter 判定的 hostile；
- 目标是 hostile，且不是玩家/被动/中立；
- 目标不在 neutral 保护名单（enderman、spider、cave_spider、piglin、zombified_piglin）；
- 目标不在 auto-avoid（creeper、wither、ender dragon、warden）；
- 当前血量高于 `retreatHealth`；
- 目标在 `radius` 内，且追击不超过 `leash`。

否则不自动开战。

## 4. 显式 attack order

- `p2_order {verb:"attack", params:{entityId:"..."}}` 是 Agent 明确点名；
- **P2 不做玩家/被动/中立保护拦截**，任何实体都可以被显式攻击；
- 技术失败仍然存在：目标丢失、无路、看不见、预算耗尽；
- 显式 attack 期间自动 fight 关闭；
- 常驻树只保留致命环境反射（岩浆/深水等），不因敌对、低血、饥饿、卡住而打断 attack；
- 自动/显式 attack 会按背包选最强剑/斧；显式 `equip` 后的下一次 `dig`/`attack`/`clear` 保留手动物，不自动切换。

## 5. 何时 FLIGHT

默认：

- 没有 `p2_policy.fight`；
- 低血、无武器/护甲、背包无补给；
- creeper / 多威胁 / 远程 / 飞行；
- 目标不在白名单；
- P2 报告路径失败/无安全方向。

## 6. 常用指令

```jsonc
// 授权自动打普通敌对
p2_policy {
  "action": "set",
  "reaction": {
    "fight": {
      "allowedTargets": ["zombie", "skeleton"],
      "retreatHealth": 8,
      "radius": 8,
      "leash": 12
    }
  }
}

// 允许自动打所有非 neutral 的 hostile（仍不打玩家/被动/中立/creeper/boss）
p2_policy { "action": "set", "reaction": { "fight": { "allowedTargets": [] } } }

// 只 flee
p2_policy { "action": "reset" }

// 显式单体攻击（任何实体；P2 不拦）
p2_order { "verb": "attack", "params": { "entityId": "75527" } }

// FLIGHT
p2_order { "verb": "go", "params": { "x": -8, "y": 69, "z": -4 } }
p2_cancel { "id": "ord-..." }
```

`p2_policy` 不持久化；body 重启后回到只 flee。自动 fight 默认不攻击玩家/中立；显式 attack 由 Agent 决定。

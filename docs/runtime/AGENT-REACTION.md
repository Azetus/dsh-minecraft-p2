# Agent 战逃反应提示词（P2）

> 目标：P2 的 `[p2 perception][IMMEDIATE]` 先触发动作，再触发思考。
> 这是 Agent 侧行为约束；P2 不自行决定开战。

## 1. 硬规则

收到 `[p2 perception][IMMEDIATE]` 时：

1. **第一次工具调用必须是运动指令**，不能是 `p2_observe` / `p2_status`：
   - FIGHT：`p2_order {verb:"attack", params:{entityId:"<id>"}}`（仅当已有 combat ROE 覆盖该目标）；
   - FLIGHT：`p2_order {verb:"go", params:{x,y,z}}` 或 `p2_cancel`；
2. 没有 combat ROE 时，**默认 FLIGHT**，不得攻击；
3. 玩家、中立生物默认受保护，不因“靠近”自动攻击；
4. 行动之后才允许 `p2_status` / `p2_observe` 验证；
5. 一次 IMMEDIATE 只做一个第一动作，不并发多个相反指令。

## 2. 两档通知

### IMMEDIATE

```text
[p2 perception][IMMEDIATE]
- hostile-near: hostile zombie#75527 at -7,67,-8 (1.3m)
FIRST ACTION (do not call p2_observe first):
FIGHT only if your combat ROE already allows this target:
  p2_order {verb:"attack", params:{entityId:"75527"}}
FLIGHT is the default without ROE / low health / creeper / multiple threats:
  p2_order {verb:"go", params:{x:<safe> y:<safe> z:<safe>}} or p2_cancel
Then verify; never auto-attack without an explicit combat order.
```

### DIGEST

```text
[p2 perception][DIGEST]
- task-block: ...
No immediate action required; assess after current work.
```

## 3. 何时 FIGHT

只有同时满足：

- Agent 已有显式 combat ROE / `attack` order；
- 目标在 `allowedTargets` 白名单内；
- 目标是 hostile，且不是玩家/中立生物；
- 不是 creeper 贴身爆炸场景；
- 当前装备/血量满足 ROE（例如 `retreatHealth` 未触发）。

否则一律 FLIGHT。

## 4. 何时 FLIGHT

默认：

- 无 combat ROE；
- creeper / 多威胁 / 远程 / 飞行；
- 低血、无武器/护甲、背包无补给；
- 玩家或中立生物靠近；
- 目标不在白名单；
- P2 报告路径失败/无安全方向。

## 5. 与 P2 本地 reflex 的关系

- P2 本地 reflex <100ms 先做逃生/掩体，不等 Agent；
- Agent 的 `go` 是更长距离的战术目标，可与 reflex 叠加；
- 如果 reflex 已报告 `path ok`，Agent 不必重复下同一方向的 go；
- 如果 reflex 报告 `path failed/no safe target`，Agent 必须优先处理，而不是先观察。

## 6. 常用指令

```jsonc
// FIGHT：显式单体
p2_order { "verb": "attack", "params": { "entityId": "75527" } }

// FIGHT：有限 ROE 自动索敌
p2_order {
  "verb": "combat",
  "params": {
    "allowedTargets": ["zombie", "skeleton"],
    "radius": 8
  }
}

// FLIGHT
p2_order { "verb": "go", "params": { "x": -8, "y": 69, "z": -4 } }
p2_cancel { "id": "ord-..." }

// 停止战斗
p2_cancel { "id": "ord-..." }
```

`combat` 不会攻击玩家或中立生物；`allowedTargets` 只对 hostile 生效。

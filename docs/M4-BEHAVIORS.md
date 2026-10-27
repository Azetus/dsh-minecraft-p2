# M4 行为：approach-target 与 hold-position

> 2026-10-27。M4 首个有限行为与持续行为；非破坏性，仅使用 `moveTo` / `stop`，不挖、不放、不攻击、不使用物品。

## 1. 新增 act：moveTo

`moveTo` 是平地上的水平接近控制器，不使用 pathfinder：

参数：

```json
{
  "x": 0,
  "z": 0,
  "tolerance": 0.6,
  "timeoutMs": 10000,
  "blockedMs": 1500
}
```

行为：

- 持续面向目标并前进；
- 距目标水平距离 ≤ `tolerance` 时成功并清除控制；
- 超过 `timeoutMs` 失败 `MOVE_TO_TIMEOUT`；
- 连续 `blockedMs` 没有有效进展失败 `MOVE_TO_BLOCKED`；
- stop/abort/暂停会清除控制；
- 不使用寻路，不处理障碍/水/岩浆。

## 2. 有限行为

文件：[behaviors/approach-target.mjs](../behaviors/approach-target.mjs)

```text
moveTo(x, z, tolerance)
→ stop
→ phase=done
```

参数 `x` / `z` / `tolerance` 均必填。完成规则是 `phase === 'done'`。

真实实测：

```json
{
  "before": { "x": -1912.4688, "y": -60, "z": -13.7406 },
  "target": { "x": -1909.4688, "z": -13.7406, "tolerance": 0.8 },
  "after": { "x": -1909.8426, "y": -60, "z": -13.7406 },
  "distance": 0.3739,
  "lastRun": { "runId": "run-1", "status": "succeeded" },
  "ok": true
}
```

P2 在目标 0.37 格内停止，所有控制释放；`lastRun` 明确为 succeeded，而不是仅凭 activeRun=null。

## 3. 持续行为

文件：[behaviors/hold-position.mjs](../behaviors/hold-position.mjs)

```text
repeat:
  moveTo(target)
  stop
  wait 500ms
```

该行为是 `mode=continuous`，没有 predicate completion；停止必须显式 `behavior.stop` / `p2_stop`。

真实实测（目标切换）：

```json
{
  "targetA": { "x": -1907.8426, "z": -13.7406 },
  "atA": { "x": -1908.3353, "z": -13.7406 },
  "distanceA": 0.4927,
  "switchB": { "accepted": true, "runId": "run-2", "status": "running" },
  "atB": { "x": -1911.3536, "z": -13.7406 },
  "distanceB": 0.4890,
  "stopped": { "accepted": true, "status": "cancelled" },
  "ok": true
}
```

说明：

- switch 到新目标会停止旧 run，创建 `run-2`；
- 新目标同样在容差内到达；
- 最终 stop accepted/cancelled，activeRun 清空；
- P2 不在运行结束后自动继续移动。

## 4. lastRun 与 p2_events

`StatusResult.lastRun` 保存最近一次 terminal run：

```json
{
  "runId": "run-1",
  "status": "succeeded | failed | cancelled",
  "error": { "code": "..." }
}
```

- activeRun=null 不再被当成成功；
- `p2_status` 直接返回 lastRun；
- `/p2 status` 文本显示 `last=...`；
- bridge status event signature 加入 lastRun 与 providerState.paused/serverAge；
- `p2_events` drain 能看到 run 开始、终态和暂停状态变化。

真实暂停终止：

```json
{
  "frozen": {
    "activeRun": null,
    "lastRun": {
      "runId": "run-1",
      "status": "failed",
      "error": { "code": "GAME_PAUSED" }
    },
    "providerState": { "paused": true, "serverAge": 165455, "idleMs": 2176 }
  },
  "resumed": {
    "activeRun": null,
    "lastRun": {
      "runId": "run-1",
      "status": "failed",
      "error": { "code": "GAME_PAUSED" }
    },
    "providerState": { "paused": false, "serverAge": 165468, "idleMs": 0 }
  }
}
```

## 5. 测试

```text
npm run check
  → 18 test files / 131 tests: pass
```

覆盖：

- `moveTo` 到达容差后停止；
- `moveTo` 无进展返回 `MOVE_TO_BLOCKED`；
- approach-target 的 checker + executor 顺序；
- hold-position 的 continuous 执行与 stop/cancel；
- 真实 body 的有限/持续行为与目标切换。

## 6. 边界

- 只在超平坦、无障碍、peaceful 世界验证；
- 没有 pathfinder，遇到障碍会 `MOVE_TO_BLOCKED` 或超时；
- 没有跳跃越障；
- 目标只是固定坐标，不是追踪玩家实体；
- 没有挖掘/放置/攻击/合成；
- 目标切换目前是显式 `switch` 新 run，不是模型实时改参；
- 运行结束/失败不会自动选择下一个目标。

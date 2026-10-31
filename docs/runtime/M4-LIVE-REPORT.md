# M4 实机与验证记录

分支 `P2MindTree`，构建 `B33E2674…45C82563`（0.3.3）。

## M4-01 游戏内对话 → Agent

- 玩家 chat 进入 body 队列；bridge 轮询、合并后通过 `Agent.followup/steer` 推送。
- `P2_Observer` 连发三条测试消息，Agent 收到**一条**合并 wake：

```text
[p2 chat]
P2_Observer: 测试一
P2_Observer: 测试二
P2_Observer: 测试三：你能收到吗
```

- `Human_Player: hi 我能看到Observer和Bot的回复` 也被合并推送；Agent 用 `p2_say` 回复成功。
- 单条防抖 1s；连续消息最多 3s 合并一次。
- 曾出现 `p2_body start` 未启动 chat poller，已修复；bot 自己的聊天回显在 provider 层忽略。

## M4-02 check Job

- `check` order verb 已接入 check giver / check driver；只有 check driver 打开容器界面。
- 结果三态写入 `job.terminal.observed` 和 `check.result`：`ok | failed | unknown`。
- 实机已定位并检查：
  - chest `(-14,67,-1)`：`ok`，`coal×64`、`raw_iron×64`；
  - furnace `(-16,67,-1)`：`ok`，空。
- Verifier 未增加任何开窗调用。

## M4-03 idle（已按职责边界重构）

- 默认无 order：hold，已实机确认 tracker idle、无自动移动/进食。
- Agent 显式 order：`hold` / `go` / `wander` / `eat` / `sleep`；P2 提供执行原语。
- 实机：`go` / `wander` 成功；`eat`/`sleep` 仅单测（实机无食物/床）。
- 夜间 30 分钟验收仍未跑；当前世界昼夜固定白天，需要可夜晚的测试世界。
- 旧自动回家/进食/游荡已移除，不再内建 Agent 策略。

## 额外执行原语：smelt / dig

- 新增 `containerTransfer`、`smelt` order/driver、`dig` order/driver。
- 实机 smelt：chest `(-14,67,-1)` + furnace `(-16,67,-1)`，
  `raw_iron + coal` → `iron_ingot`，成功放回 chest。
- 复核 chest：`coal×63`、`raw_iron×63`、`iron_ingot×1`。
- 取消修复：取消非 plan order 现在会 abort 当前 job。

## 战斗 ROE

- 新增 `attack`（显式 entityId）与 `combat`（allowedTargets 白名单 + 半径）执行路径。
- 玩家与中立生物始终受保护；`combat` 只索敌 hostile。
- 无 Agent 明确 attack/combat order 时，P2 不攻击。
- 新增 `docs/runtime/AGENT-REACTION.md`：IMMEDIATE 先动作后观察，
  FIGHT 仅已有 ROE 时使用，否则默认 FLIGHT。
- 实机未做战斗测试：可定位到的 hostile 最近约 48 格，未把 body 引过去；仅单测。

## 验证

- `npm run check`：282 passed / 1 skipped。
- 实机 chat：合并推送与 `p2_say` 双向成功。
- 实机 eat：food 从 0 升到 12（继续进食到阈值）。

## 感知切片

- body 已接 `damaged`/`died`/`task-block`/`hostile-near` 四类感知；task-block 只匹配 active plan 关注的坐标。
- hostile-near 由 body 每 500ms 采样 8 格 hostile，30s/实体去重；本地 escape giver 仍以 50ms 周期做安全反射。
- 普通 digest 在 Agent running 时本地挂起，idle 后合并 `followup`；critical 才 `steer`。
- hostile-near 与 task-block 目前只有单测，实机未遇到 hostile/目标方块被改的场景。

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
- 单测覆盖 ok / failed / unknown；当前加载区域没有箱子/熔炉，因此未做容器实机。
- Verifier 未增加任何开窗调用。

## M4-03 idle

- 实机：health 1 / food 0 启动后 `eat` 连续消耗 cookie，观测到
  `food 0→2→4→6→8→10→12`，身体仍在 active；证明 equip + 按住使用 + 食物值验证生效。
- 夜间回家半径 2、夜间禁止 wander、白天 wander 12s 冷却均为单测覆盖。
- 尚未跑满夜间 30 分钟零死亡/零方块变化验收。
- 已确认存档从旧 journal 迁移时身份 defVersion 会变化；旧 journal 已归档为
  `.p2/journal-pre-m4.jsonl`，新 journal 重新建立身份头。

## 验证

- `npm run check`：274 passed / 1 skipped。
- 实机 chat：合并推送与 `p2_say` 双向成功。
- 实机 eat：food 从 0 升到 12（继续进食到阈值）。

## 感知切片

- body 已接 `damaged`/`died`/`task-block`/`hostile-near` 四类感知；task-block 只匹配 active plan 关注的坐标。
- hostile-near 由 body 每 500ms 采样 8 格 hostile，30s/实体去重；本地 escape giver 仍以 50ms 周期做安全反射。
- 普通 digest 在 Agent running 时本地挂起，idle 后合并 `followup`；critical 才 `steer`。
- hostile-near 与 task-block 目前只有单测，实机未遇到 hostile/目标方块被改的场景。

# M2 软件核心验收记录

> 2026-10-27，dev 分支，包版本 `0.1.0`。本记录覆盖 DSH 人工 start、owner 局部工具、body 保留/关闭、事件缓冲和插件卸载；不把 fake body 测试当成真实 DSH/游戏验收。

## 1. 已实现

- **人工 start**：`/p2 start` 只由命令创建 body；工具注册发生在 start 成功后，加载/重载不创建 body。
- **owner 工具**：`p2_status`、`p2_check`、`p2_activate`、`p2_switch`、`p2_confirm`、`p2_stop`、`p2_events`、`p2_command`。每个工具校验 `exec.agent` 的 session/agent 与 owner 一致。
- **模型 stop**：`p2_stop` 调用 body `behavior.stop`，只结束 behavior run，body 保持 active；`/p2 stop` 才关闭 body。
- **可信来源**：body confirm 的 source 固定为 `agent`；工具不能自报玩家身份。存在独立的人类玩家入口前，只记录 agent 判断。
- **事件缓冲**：bridge 在 heartbeat 后轮询 status，按状态签名入有界 EventQueue；`p2_events` drain 返回事件、gap、dropped。JSONL 日志保留。
- **命令查询**：`p2_command` 调用 body `command.get`。
- **卸载清理**：插件 effect dispose 时先释放工具、再 stop body；测试确认 body 关闭且不销毁 agent。
- **状态展示**：`/p2 status` 显示 epoch/health/owner/run/confirmation。

## 2. 验证

```text
npm run check
  → 15 test files / 116 tests: pass
```

新增 M2 覆盖：

- start 前无工具、start 后注册 8 个 owner 工具；
- 错误 agent 执行工具被拒绝；
- 插件卸载关闭 body、agent 保留；
- 模型 stop 只结束 behavior，body 仍 ready；
- event drain 返回初始 status 事件；
- `behavior.stop` 与 `command.get` 协议路径。

## 3. 边界

- **自动会话事件投递未接**：事件目前由模型调用 `p2_events` drain，未通过 `agent.inject`/`followup` 自动推送；避免无限唤醒的 merge 策略和 session event 展示仍是下一轮。
- **确认来源只有 agent**：没有可信人类玩家入口；confirm 不能冒充玩家证明。
- **真实 DSH 重载/异常退出未测**：插件卸载用 fake ctx 验证；DSH 进程崩溃、runner 卡住、输出背压、进程树回收留到 M3/M6。
- **真实 Desktop profile 未重装**：目前是隔离 dev profile。
- **没有 provider/游戏连接**：M2 仍不宣称可玩游戏。

## 4. 结论

M2 的 DSH 软件闭环核心已落地：人工 start、owner 工具、body 保留/关闭、事件缓冲、命令查询和卸载清理均有测试。M2 不是完整 DSH 事件闭环，自动会话通知、真实重载/异常进程测试未完成；下一步进入 M3 游戏接入前，需要先决定测试服务器、游戏版本/加载器、账号身份和安全世界。

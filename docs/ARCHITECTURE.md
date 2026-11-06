# 架构

> 控制结构 = **P2Mind**（详见 [P2Mind 设计](runtime/P2MIND.md)）。

## 1. 进程与边界

```text
DSH session (bridge plugin)
  ├─ p2_* tools / /p2 command / owner wake
  └─ BodyManager ── JSON-lines stdio ──> body process
                                           ├─ P2Mind（树 / giver / job / tracker / driver）
                                           ├─ ClientPort（mineflayer 适配器）
                                           ├─ Verifier + 意图日志
                                           └─ provider（唯一游戏 I/O）
```

- **bridge**：工具、owner 校验、心跳/故障/重启、唤醒、汇总；不执行游戏动作。
- **body**：P2Mind 与 ClientPort 适配器所在的进程；所有游戏 I/O 走 ClientPort。
- **单写者**：只有持有写令牌的 Driver 能调用 ClientPort 的写操作。

## 2. 控制结构

```text
agent ──order──► OrderStore ──► Planner ──► PlanInstance
                                              │
      常驻树（紧急） / 主树（常规） / 对话管线 ──► WorkGiver ──► Job
                                              │
                                        JobTracker ──► Driver ──► ClientPort
                                              │
                                        Verifier ──► 证据/唤醒
```

| 层 | 负责 | 不负责 |
|---|---|---|
| Order / Plan | 目标、布局、材料政策、工作项 | 调度、执行 |
| 树 | 选哪个 giver | 选目标、执行 |
| WorkGiver | 选目标、可达性、前置工作转派 | 执行 |
| JobTracker | 续做/切换/停止确认/迟到围栏 | 选目标、执行 |
| Driver | 执行一个已定目标、读回、收尾 | 选目标、改计划 |
| Verifier | 三态验证（只读观测） | 抢交互、改世界 |

### 2.1 结果语义分层
`ClientPort`、driver、tracker/metrics 回答的是三个不同问题，不能混用同一个“成功”：

| 层 | 回答的问题 | “成功”的含义 |
|---|---|---|
| `ClientPort` / provider | 动作有没有被发出、有没有回执或效果观测 | `ActResult.state='ok'`：动作效果被观测到；**不是** order 目标完成 |
| Driver | 这个 verb 的可验证后置条件有没有成立 | `DriverResult.state='succeeded'`：后置条件已确认；`failed`：无法确认结果 |
| JobTracker / metrics | 这个 job/order 是否算完成 | 只把 driver 的 `succeeded` 计为完成 |

因此：

- driver 不得因为 provider 返回 `ok` 就直接 `succeeded`；必须完成该 verb 的读回/确认。
- `failed` **不等于**“什么都没发生”。动作可能已生效、只完成一部分，或效果未知；用 `observed.partial`、`dug`、`crafted`、`effect` 等证据区分。
- Verifier 的 `confirmed / refuted / insufficient` 是另一条只读验证轴，不与 driver 的 `succeeded / failed` 混用。
- 每个 driver 的成功定义见 [CONTRACTS.md §5](CONTRACTS.md#5-driver)。

### 2.2 Owner session 与 `.p2` 工作区

- body start 时 bridge 在 owner agent scope 注册：六个包内 skill（operator/persona/memory/wake/subagent/survival）、`.p2/skills` workspace provider、persona section、memory context、P2 工具 + `p2_memory`、auto-wake。stop 时全部 dispose；fault 只停 auto-wake，保留只读工具供检查。
- 工具和 skill 注册在 owner agent scope，子 agent/其他 session 看不到；`p2_body` 仍是全局开发工具并做 owner 检查。
- `.p2/` 是本机内部内容，由 `p2 start` 从 `content/templates/` 创建缺失文件，绝不覆盖已有用户编辑。persona、config、memory、workspace skills 都在这里；`.p2` 不入库。
- auto-wake 是 bridge 的调度能力，不进入 P2Mind：它只在 owner session 静默后注入一个 turn，不生成 order/duty，也不限制 Agent 的目标选择。默认 `skipActiveWork:false`；设为 `true` 才按 active order/plan/duty/armed goal 跳过唤醒，这是调度偏好，不是授权门。

## 3. 接入

```text
ClientPort（query / act / event / capabilities，纯数据）
  └─ MineflayerAdapter   现在：进程内调用；当前唯一投入的适配器
```

- 换接入不换 AI：树、giver、plan、driver 都只依赖 ClientPort。
- 能力是行为契约（`navigate / interact / observe.screen`），缺能力时 driver 声明 `requires` 并降级或报不支持。
- 一致性测试保留为 ClientPort 契约测试；当前只对 mineflayer 适配器执行。自研 mod 适配器不在当前计划内，保留 `ClientPort` 边界以便未来需要时重新评估。

## 4. 目录

```text
src/
  bridge/          DSH 插件、owner session、persona/memory/auto-wake、进程管理、唤醒
  body/            body 运行时（RPC、生命周期、装配）
  port/            ClientPort 契约 + 能力 + 一致性测试
  port/mineflayer/ mineflayer 适配器
  mind/            P2Mind：tree / trees / giver / job / tracker / driver / plan / order
  mind/verify/     验证器
  mind/journal/    意图日志与恢复
  contracts/       协议、framing、通用类型
skills/            owner-session 运行提示（p2-operator/persona/memory/wake/subagent/survival）
content/
  plans/           结构模板 JSON
  templates/       .p2 工作区模板（persona/config/skills/memory 说明）
```

## 5. 生命周期

1. `/p2 start <host>:<port>` 或 `p2_body start` → bridge 先确保 `.p2` 工作区（缺失文件从 `content/templates/` 复制，不覆盖），再启动 body 子进程并注入 MC target。
2. body 连接 provider → 加载 `content/`（树、模板）与注册表 → 读取意图日志恢复未完成 order。
3. body active 后 bridge 在 owner agent scope 注册 skill/persona/memory/tools/auto-wake。
4. body 进入 tick 循环（50ms）：观测 → 常驻树 → 主树（事件）→ tracker → driver。
5. 停止：`p2_body stop` 先冻结新 dispatch，请求当前 driver 停止并等待确认，落盘意图日志后退出；超时 SIGTERM，再 killTree；bridge 停止 auto-wake 并 dispose owner 注册。
6. body 重启：epoch 变化，P2Mind 状态从意图日志 + 世界重建；**不重放 pending 动作**；bridge 重新读取 auto-wake 配置并恢复 owner 注册。
7. 单 body：同一 MC target 由跨进程锁保护；owner/target/`lastDisconnect` 在 `p2_status` 可见。



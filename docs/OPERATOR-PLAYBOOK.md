# 操作员手册（接入游戏时）

> 状态：**设计已定，待使用模式试跑**（2026-10-30）。
> 适用范围：把 P2 接入真实游戏、由 DSH agent 现场协作时。
> **不适用范围**：本仓库自身的插件开发、fake 测试、构建与发布；开发迭代不受本手册约束。

## 1. 为什么要分层

游戏现场有两类工作，延迟要求完全不同：

- **热路径**：秒级。guard 触发、body fault、watch 边沿、玩家指令。必须立刻看见、立刻决定。
- **温路径**：分钟级。策略分析、behavior/act/op/policy 编写、方案比较。可以后台完成，但不能占住热路径。
- **冷路径**：人类定目标、改规则、批准高风险动作。

若让同一 session 既写代码又盯现场，长任务会把 owner 的唤醒延迟到 turn 结束。body 内的 guard 仍会执行，但 owner 的认知与升级会滞后。操作员模式把两类工作分开。

## 2. 角色

| 角色 | 职责 | 不做什么 |
| --- | --- | --- |
| body guard（已实现） | 在 body 内实时采样并切换目标 | 不依赖 owner 在线；不做策略判断 |
| operator（主 session） | 热路径：观测、停止/切换/撤退/救援、清 guard/watch、验收产物 | 不写大段代码、不跑构建、不做长分析 |
| subagent（planner/author） | 温路径：策略分析、behavior/act/op/policy 编写、离线检查 | 不操作 body、不提交 git、不冒充 owner |
| human | 目标、规则、危险动作批准 | 不进入秒级循环 |

首版一个 body、一个 owner session。operator 就是 body 的 owner。

## 3. Operator 规则

### 3.1 允许

- `p2_status`、`p2_card`、`p2_events`、`p2_observe`、`p2_trace`（dev）。
- `p2_stop`、`p2_switch`、`p2_guard`、`p2_watch`、`p2_rescue`、`p2_body`（dev）。
- `p2_check` / `p2_activate` / `p2_confirm`：验收子 agent 产出的 artifact。
- 短只读命令与文件读取，用于现场判断。

### 3.2 禁止

- body active 时在主 session 跑 `npm run check`、`npm run bundle`、大规模编辑、长分析。
- 让 subagent 直接调用 `p2_*` 控制工具（owner 校验会拒绝；不要绕过）。
- 把 `accepted`、`enabled`、`started` 当成任务完成。
- 用 `followup` 的延迟当作“事件没发生”；事实源是 `p2_events`。

### 3.3 Turn 纪律

- 每个 turn 只做一批现场动作，然后结束 turn。
- 需要等待时**结束 turn**，不要 sleep/轮询；唤醒与 completion notice 会在下一次 turn 到来。
- 长命令必须交给 background job 或 subagent；等待期间 operator 保持可唤醒。

## 4. 事件处理循环

收到 `[p2 guard]` / `[p2 watch]` / `[p2 runtime]` 唤醒后：

1. `p2_status` 看当前 epoch、run、cleanup/control 状态、guard/watch 列表。
2. `p2_events` 或 `p2_trace` 看事件顺序与证据；不要只信消息文本。
3. 判定：
   - guard 已切换且目标合适 → 记录，继续；
   - guard 切换失败 / STOP_UNCONFIRMED / faulted → 停止新动作，必要时 `p2_stop`、`p2_rescue`；
   - watch 只是观察 → 决定是否调整策略，不直接产生控制。
4. 需要新策略/新 artifact → 走第 5 节委派。
5. 结束 turn。

## 5. 委派给 subagent

### 5.1 何时委派

- 需要比较多个策略、读大量文档、写 behavior/act/op/policy、做离线检查。
- 预计超过一个短 turn（例如 >30s）的任何工作。

### 5.2 输入模板

```text
目标：<一句话>
现场摘要：<p2_snapshot/p2_card 的关键字段、guard/watch 状态、epoch>
约束：<安全边界、允许的工具、不要操作 body、不要提交 git>
产物：<文件路径或 artifact 源码；参数；依赖；验收方式>
失败时：<返回阻塞原因，不猜>
```

### 5.3 输出契约

- 返回文件路径、definitionId、参数 schema、依赖、预期验收步骤。
- 不在子 agent 内 `p2_activate`/`p2_switch`；由 operator 验收后执行。
- 不修改 `src/`（使用模式下只写内容产物；插件源码属于开发迭代）。
- 不提交 git。

### 5.4 等待

- 启动委派后 operator 结束 turn；完成通知到达再继续。
- 若现场在此期间变化，operator 仍优先处理热路径；子 agent 结果可延后验收。

## 6. 唤醒路由（F6）

| 事件 | owner running | owner idle |
| --- | --- | --- |
| guard fired / body fault / restart | `steer`：下一 step 可见 | `followup`：下一 turn |
| watch 事件 | 窗口合并为一条摘要，`inject` | 窗口合并为一条摘要，`followup` |

- 消息只是提醒；完整数据在 `p2_events`。
- watch 摘要包含 `watchId/key/count`，不逐条刷屏。
- `steer` 会进入当前任务上下文，只用于需要立即知晓的 guard/runtime；watch 不用 `steer`。

## 7. 降级

- guard 预检失败：保持当前 run，不启动 target；operator 记录并修正 artifact/目标。
- `STOP_UNCONFIRMED`：禁止新控制；operator 先确认游戏侧状态，必要时人工 stop/restart body。
- body fault：旧 run `faulted`、控制 `unknown`；等自动重启或人工 `/p2 start`，重新登记 guard/watch。
- 子 agent 超时/失败：operator 接管或换方案；不把子 agent 的“计划”当成已验证事实。

## 8. 使用模式试跑的验收

1. operator 在长任务期间仍能在事件后 ≤1 个 step 收到 `steer`（guard/runtime）。
2. watch 事件合并为一条摘要，owner 不被逐条唤醒。
3. operator 的每个 turn 不超过约定时长，且没有在主 session 跑构建。
4. 子 agent 产出的 artifact 能被 operator 正常 check/activate。
5. 子 agent 不能操作 body（owner 校验拒绝）。
6. 失败路径：guard 切换失败或 faulted 时，operator 能停止新动作并记录。

## 9. 边界

- 本手册只约束“接入游戏”的使用侧；插件开发、fake 测试、打包发布继续按 `AGENT.md` 与 TODO 执行。
- 不承诺硬实时；`steer` 仍要等当前工具调用结束。
- 不作为安全边界：真正的实时动作仍由 body guard 执行，操作员只负责认知与升级。

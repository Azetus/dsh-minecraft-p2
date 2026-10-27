# M1 软件核心验收记录

> 2026-10-27，dev 分支，包版本 `0.1.0`。本记录覆盖纯执行器、受控扩展、body 行为入口和库级 H1/H2 切换；不把 fake/provider-free 测试当成“可玩游戏”验收。

## 1. 已实现

- **IR/builder**：可序列化 BehaviorDefinition、控制结构节点、表达式、参数/局部声明；结构校验。
- **执行器**：tick 驱动、sequence/if/reactivePriority/repeat/subtree/assign/wait/query/act/recover；局部帧、子树输出发布、单轮转移上限、取消优先、finite predicate 与 continuous 结束规则。
- **query/act**：同步和 pending/poll 查询、零自动重查、act 输出仅在成功后发布、单活跃 act、停止失败转控制故障。
- **checker/registry**：sourceRoot 路径限制、sourceDigest、worker 隔离构建和 1s 超时、IR 校验、artifact manifest/digest/id、checker 凭据、按 binding 的 enable/retire/switch 和依赖闭包。
- **D3 核心**：每 run 待确认记录、confirm/deny、错误 run/owner/confirmationId/source、重复 commandId、取消竞争和晚到决定拒绝。
- **D6 核心**：异步 JSONL、缓冲上限/丢弃计数、单文件轮换、loggingUnavailable、内存命令去重和容量上限。
- **BehaviorHost**：check → activate → switch → tick → confirm/stop → retire 的库级闭环，切换时先停止旧 run，退休阻止新 switch。
- **body 行为入口**：body 协议新增 `check/activate/switch/confirm`；BodyRuntime 可接收 BehaviorHost 并在 status 中暴露 activeRun/pendingConfirmation，BodyServer 支持异步分发。
- **body 并发与日志**：同一 pending check 不重复构建；无限构建时 status 仍可响应；命令完成写 JSONL，日志故障通过 status 的 loggingUnavailable/droppedLogCount 可观察。
- **终态裁决**：pre-tick stop 优先；act stop 失败转控制故障；query predicate 需要第二次新鲜确认，第二次为 false 返回 GOAL_NOT_MET；act cleanup 期间保持 running，超时转 STOP_TIMEOUT；固定 ingress 批次中 stop 优先于确认。
- **D1 元数据**：LocalSlot 记录 source/scope/sampledAt/validUntil；query/act/子树输出复制元数据，assign 生成来源。
- **额度与生产入口**：WorkQuota 限制普通 check；body 入口创建 BehaviorHost 和 50ms ticker，check/activate/switch/confirm 在真实 body 进程中可用。
- **QueryOp 超时**：query 节点支持 timeoutMs；pending 超时返回 QUERY_TIMEOUT，且只请求一次。
- **证据过期**：guard 查询结果超过 validUntil 不被复用，会启动新的 evaluation。
- **H1/H2 运行切换**：MultiBindingHost 在显式 switch 时停止旧 binding 的 run，再切到新 binding；仅启用 H2 不改变运行中的 H1。
- **事件队列**：有界 EventQueue 支持 eventId 去重、容量淘汰、gap 与 dropped 计数。
- **H1/H2/闭包**：同一源码可生成不同 binding 的 artifact；两个 registry 隔离退休；缺失依赖闭包被拒绝。

## 2. 验证

```text
npm run check
  → build + typecheck + 113 tests: pass
```

测试分布：

```text
test/ir.test.ts           8
test/executor.test.ts    20
test/broker.test.ts      11
test/checker.test.ts      9
test/run.test.ts          6
test/logging.test.ts      5
test/host.test.ts         3
test/body-behavior.ts     6
test/multi-host.test.ts   2
test/events.test.ts       3
其余 M0/协议测试       40
```

当前测试覆盖了控制结构、同 tick 赋值可见、wait 跨 tick、子树输出、查询失败零重试、act 成功/失败/取消、停止失败、checker 超时、registry 退休、外部确认和日志上限。

## 3. M1 软件核心结论

M1 的纯执行器和受控扩展已落地：IR/builder、执行器状态机、query/act broker、checker/artifact registry、D3 确认、D6 日志/命令记录、body 行为入口、H1/H2 库级切换、有界事件队列均有测试。当前有 15 个测试文件、113 个测试通过。

**边界声明**：这不是“可玩游戏”的验收。RUNTIME §11 中依赖真实 provider 和进程树的场景（真实 H1/H2 provider 切换、宿主异常退出/runner 卡住/输出背压、真实 QueryOp 超时分布、body 事件投递）未在本阶段执行；它们进入 M2/M3/M6。M1 的 H1/H2 切换是库级 fake 验证，不冒充真实游戏连接。

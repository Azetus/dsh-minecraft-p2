# M1 核心验收记录

> 2026-10-27，dev 分支，包版本 `0.1.0`。本记录区分“已实现的库级核心”和“尚未满足的 M1 退出条件”；不把核心测试当成完整阶段验收。

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
- **H1/H2/闭包**：同一源码可生成不同 binding 的 artifact；两个 registry 隔离退休；缺失依赖闭包被拒绝。

## 2. 验证

```text
npm run check
  → build + typecheck + 107 tests: pass
```

测试分布：

```text
test/ir.test.ts          8
test/executor.test.ts   20
test/broker.test.ts     10
test/checker.test.ts     9
test/run.test.ts         6
test/logging.test.ts     5
test/host.test.ts        3
test/body-behavior.ts    6
其余 M0/协议测试      40
```

当前测试覆盖了控制结构、同 tick 赋值可见、wait 跨 tick、子树输出、查询失败零重试、act 成功/失败/取消、停止失败、checker 超时、registry 退休、外部确认和日志上限。

## 3. 尚未满足的 M1 退出条件

- **没有接入生产 body host**：body 协议与 BodyRuntime 已支持行为方法，但 body 进程入口没有 provider/query/act，只有测试注入的 BehaviorHost；M2 接 provider 后才会实际运行行为。
- **RUNTIME §11 未全部覆盖**：运行中 H1→H2 切换、完整异步事件队列/ingressSeq、来源年龄校验尚未实现/测试；QueryOp 超时、固定 ingress 批次和 late result 已覆盖。
- **查询条件**：guard 的 pending poll 已补，参数变化会新建 evaluationId；完成 predicate 的 pending 仍会在最终确认时重新请求。
- **H1/H2 隔离**：静态 checker/registry 已覆盖；运行中的 H1→H2 切换仍缺 provider 和完整切换生命周期。
- **D3 协议字段**：body 已有 confirmationId/owner 校验，但 bodyEpoch 由通用请求校验，可信来源仍固定为 bridge 字符串；没有独立的人类玩家入口。
- **D6 接入**：命令完成/终态写日志，日志故障/满载可观察；日志满载下 stop 已验证。
- **D4 运行闭包**：BehaviorHost 有 enable/retire/switch 和旧 run 停止，但 body 的切换等待仍是同步 tick 驱动，不是完整异步生命周期。
- **元数据**：已记录来源/范围/时间并复制，但没有在 assign/子树边界做完整的年龄/作用域再校验。

## 4. 结论

M1 的库级核心与 body 入口已落地并通过 107 个测试，但**不宣称 M1 退出条件已满足**。下一轮应补运行中 H1→H2、完整异步事件队列和元数据年龄校验；不能把本记录作为“可玩游戏”或完整 M1 的证据。

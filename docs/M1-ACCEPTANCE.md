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
- **裁决补强**：查询 guard 的 pending poll 只保留一次请求；目标 predicate 为 true 时可压过普通 environment 失败；pre-tick stop 优先于树成功。

## 2. 验证

```text
npm run check
  → build + typecheck + 90 tests: pass
```

测试分布：

```text
test/ir.test.ts          8
test/executor.test.ts   16
test/broker.test.ts      7
test/checker.test.ts     7
test/run.test.ts         4
test/logging.test.ts     5
test/host.test.ts        3
其余 M0 测试            40
```

当前测试覆盖了控制结构、同 tick 赋值可见、wait 跨 tick、子树输出、查询失败零重试、act 成功/失败/取消、停止失败、checker 超时、registry 退休、外部确认和日志上限。

## 3. 尚未满足的 M1 退出条件

- **没有接入 body stdio**：check/activate/switch/confirm 仍是库级 API；body 只支持 M0 管理方法，bridge 也没有行为命令。
- **RUNTIME §11 未全部覆盖**：目标完成与环境失败的统一裁决、最终新鲜确认、清理超时进入 faulted、同批取消/成功顺序、晚到结果、recover 完整预算、事件顺序等尚未实现/测试。
- **查询条件**：guard 的 pending poll 已补，但完成 predicate 的 pending 仍会在下一次 tick 重新请求；严格一次请求语义还需统一。
- **H1/H2 隔离**：checker 是 worker_threads + 超时，不是 OS 进程/H1 网络/文件权限隔离；M5 才要求更强隔离。
- **D3 协议字段**：确认已有 confirmationId/owner 校验，但还没有 bodyEpoch/传输层可信来源；owner/source 可信来源由未来 bridge 注入。
- **D6 接入**：日志没有与 body 的 accepted/终态路径绑定，也没有在日志故障下验证命令去重和停止推进。
- **D4 运行闭包**：BehaviorHost 有 enable/retire/switch 和旧 run 停止，但还没有 body 生命周期与“切换等待”异步确认。
- **body**：仍未接 check/activate/switch/confirm；BehaviorHost 是库级开发测试端。

## 4. 结论

M1 的库级核心已落地并通过 90 个测试，但**不宣称 M1 退出条件已满足**。下一轮应接 body 行为方法/运行宿主，并补 RUNTIME §11 的最终新鲜确认、清理超时、晚到结果和同批事件顺序；不能把本记录作为“可玩游戏”或完整 M1 的证据。

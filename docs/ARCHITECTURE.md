# 架构（Controller-only）

## 1. 进程与边界

```text
DSH session (bridge plugin)
  ├─ p2_* tools / /p2 command / owner wake
  └─ BodyManager ── stdio JSON-lines ──> body process
                                         ├─ ArtifactHost: registry + check/activate + watch
                                         ├─ P2Controller: S0–S3, lease, commitment, memory
                                         ├─ Runner (act/policy sandbox)
                                         ├─ Provider (Mineflayer)
                                         └─ ActPort / QueryPort / PolicyPort
```

- **bridge**：工具、owner 校验、心跳/故障/重启、唤醒、汇总；不执行游戏动作。
- **body**：`ArtifactHost` 负责 artifact 与观测；`P2Controller` 是**唯一自主控制模式**；`Runner` 只跑 act/policy；`Provider` 是唯一游戏 I/O。
- 消息帧：`src/contracts/framing.ts` / `transport.ts`；请求/响应类型见 `src/contracts/protocol.ts`。

## 2. 控制面

没有 behavior run、没有 switch、没有 guard、没有 confirm。

- `p2_controller action=enable|disable|status|install|commit|cancel|events`
- `disable` 先冻结评估/dispatch，再取消承诺、撤销租约、等待释放确认。
- 单 action slot：只有 Controller 的租约可以 dispatch act。
- S0 危险抢占：S0 策略先占槽；承诺 suspended；危险清除后重新核验再继续。
- S1 维护：`maintain` 策略在饥饿/受伤时吃食物或等待回血，和 S0/S2 共用同一租约。
- S0 同一 `holder|intent` 60s 内 3 次未清除 → `blocked(S0_RETRY_EXHAUSTED)`，承诺 `blocked: EMERGENCY_BLOCKED`。
- 每 tick 决策写入有界 `decisions[]`；`metrics` 记录空转/无进展、S0 四段时延、承诺与动作计数。
- 死亡点写入 `death` hazard（60 分钟）；非 S0 动作目标落在 hazard 内 → `blocked(HAZARD_TARGET)`。
- `shadow` 策略只评估、不取租约，用于新策略上线前观察。

## 3. 内容与沙箱

| 类型 | 运行位置 | 约束 |
| --- | --- | --- |
| `act` | runner vm | 单文件、同步 hook；只能声明 op；无网络/文件 |
| `policy` | runner vm | 单文件纯函数；watch 谓词 |
| `op` | body 进程 | 扩展 provider 原语；受 capability/ledger 约束 |
| `strategy` | body 进程 `node:vm` | 单文件、同步、纯 JSON 输入输出；无 timer/async/import/eval/process/fetch |

strategy vm **不是**安全边界：它可逃逸；只应运行可信/复核过的内容。

`src/controller/strategies/` 只保留测试/参考 fixture；body 能安装的**唯一生产策略来源**是 owner 项目里的 `strategies/*.js` artifact。新增战术应优先写 artifact，而不是改 Controller 核心。

## 4. 观测

- provider 只提供 query；`QueryPort` 返回 `ok/failed/pending`，带 `sampledAt/validUntil`。
- Controller 的 observation bus 记录 `known/unknown + sampledAt + validUntil + scope + evidenceId`，用于 `freshSince` 证据门。
- watch 是观察-only：声明 query + policy 谓词 + 边沿/冷却/TTL；不拥有控制。
- 事实源默认：position/health/inventory/nearbyBlocks/entities；策略只能读 manifest 声明的事实。

## 5. 生命周期

1. 人类 `/p2 start` → body 连接游戏。
2. owner `p2_check` → `p2_activate` act/policy/op/strategy。
3. `p2_controller enable` → `install` → `commit`。
4. 运行中 `p2_controller status/events`；危险由 S0 处理；结束由证据门判定。
5. 停止：`p2_controller cancel`（承诺）或 `disable`（自主行动）；`/p2 stop` 停 body。

## 6. 目录

- `src/bridge/`：DSH 插件、工具、进程管理、唤醒。
- `src/body/`：body runtime/server、controller host、provider/rescue/dev-ops。
- `src/controller/`：P2Controller 核心（lease/observation/commitment/slots/memory/strategies）。
- `src/core/`：artifact host、checkers、act/policy/op 端口、runner、broker、logging。
- `src/contracts/`：协议、类型、artifact 契约、framing/digest。
- `src/runner/`：act/policy 沙箱子进程。
- `src/provider/`：Mineflayer 适配（query/act 原语）。
- `strategies/`：实机/示例 strategy 内容；`acts/` 示例 act；`policies/` 示例 policy。

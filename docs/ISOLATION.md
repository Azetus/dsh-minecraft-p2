# 隔离威胁模型与引擎验证

> 本文规定 behavior／act／policy 代码隔离的威胁模型、必须验证的能力、资源上限与证据记录方式。**本文的实测记录尚未填写：隔离验证（S1—S7）未执行。** 在 §7 有实测证据前，不开放 agent 自定义 act／policy 的启用。
>
> 关联：[扩展生命周期 §4](BEHAVIOR-LIFECYCLE.md#4-构建act-与-policy-的代码隔离)、[运行时](RUNTIME.md)、[契约 §4](CONTRACTS.md#4-act-与-policy-作者接口)。

## 1. 保护对象

隔离保护的是 **P2 运行时与宿主环境**，不是「act 的行为是否合理」。

| 保护对象 | 为什么需要 |
| --- | --- |
| body 进程与调度器 | 生成代码不能占住执行栈、不能让 behavior 停止推进。 |
| 控制账本与 broker | act 只能提交请求，不能伪造成功、不能抢占第二个控制位。 |
| DSH 会话与凭据 | 生成代码不能读到宿主 token、会话对象或环境变量。 |
| 用户文件与网络 | 生成代码不能读写工作区之外的文件或发起连接。 |
| 游戏连接 | 只有 provider 持有连接；act 通过 broker 间接使用。 |

**不在保护范围**：act 用合法 op 做出的破坏性动作（可由效果预算限制，但不能由隔离阻止）、act 的逻辑正确性、第三方来源的意图。

## 2. 威胁模型

| 主体 | 假设 | 结论 |
| --- | --- | --- |
| 本地 agent | 有能力写代码，也可能写错；不假设它会主动攻击宿主（它本来就有文件工具） | 隔离防「失控」，不防「本地 agent 造反」 |
| behavior／act／policy 代码 | 可能死循环、爆内存、返回怪东西、误用模块 | 必须由机制兜住 |
| 第三方来源（下载的 act） | **不推荐、不背书**；默认不启用 | 同样的隔离门槛 + 人工启用；残余风险由用户承担 |

因此本项目**不承诺**「act 是安全的」，只承诺三条可验证性质：

1. **不能访问宿主能力**：没有 `process`、`fs`、网络、子进程、原生模块、DSH 对象或凭据。
2. **不能超出资源预算**：CPU、内存、输出大小与总时长有界；超限即终止并重建 runner。
3. **不能绕过控制账本**：只能提交已登记请求；成功、停止与对账由 broker 判定。

**不承诺**：语义安全（act 可以用合法 op 做蠢事）、来源可信（下载的代码意图未知）。

## 3. 桥设计

behavior 在隔离 runner 的 `behavior` 角色中执行：runner 进程内使用 `node:vm` 创建独立上下文，只注入冻结的 `ctx` 命令入口，不注入宿主能力。这是基线，不是完整安全隔离。act 与 policy 仍走既有隔离 runner。

| | act 桥 | policy 纯桥 |
| --- | --- | --- |
| 能力 | 提交 QueryOp／ControlOp、读取结果、progress | 无；只接收输入、返回一个 JSON 值 |
| 调用方式 | `start`／`update`／`stop`／`cleanup` | 由 behavior 的 `ctx.decide` 提交一次，异步等待 |
| 生命周期 | 跨多个 hook，需收尾 | 一次调用一次返回 |
| 失败 | 走 act 收尾与 broker 清理 | `ctx.decide` 抛出，不进入 act 清理 |
| 预算 | hook 软预算 50ms、无响应 500ms、总时长按产物 `limits` | 单次 20ms、无响应 200ms；等待不占 tick 的 10ms 预算 |
| 隔离 | 同一 runner，同一引擎 | 同一 runner，同一引擎 |

### 3.1 runner 模式

G1/G2 使用**共享 runner**：一个进程同时承载 act hook、policy 调用与 behavior 单步执行，通过 `role: act | policy | behavior | both` 参数声明；`behavior` 角色只承载 behavior 的模块加载与 step。这样只维护一套启动、崩溃、预算与日志路径。

共享模式的故障语义必须写清：**policy 调用超时导致 runner 重建时，如果当时存在活动 act 或 behavior 运行，该 act 视为被中断、behavior 按失败收尾**，走 broker 收尾并报告控制故障；不能笼统宣称「policy 失败不影响 act」。单步模型下 generator 等待 `ctx.decide` 时不会同时推进 act，但契约不能依赖「恰好不会发生」。

**独立 policy runner 不在 G1/G2 实现**，由 G3 结论决定。触发重估的条件：

- 允许 `ctx.decide` 在 act 运行期间求值；
- 观察到「policy 超时打断活动 act」的实际噪声；
- policy 的资源需求明显高于 act 的容忍范围。

拆分时只需启动两个进程并各自传入 `role`，桥消息与预算不变。

behavior 上下文、act 桥与 policy 桥共用 runner，但注入的宿主对象集合不同；runner 对它们都串行执行，不引入第二个执行者。

## 4. 必须验证的能力（准入门槛）

| 编号 | 能力 | 通过判据 |
| --- | --- | --- |
| S1 | 无宿主能力逃逸 | 见 §5 攻击清单；朴素组全部失败，已知逃逸组有明确结论（挡住的记「已挡」，未验证的记「未验证」，不得写成「已挡住」）。 |
| S2 | 内存上限 | 64MiB 上限下分配 512MiB 被中止；body RSS 增量 < 32MiB；随后能正常服务下一个 act。 |
| S3 | CPU 中断 | behavior step 或 hook 内 `while(true){}` 在 50ms 预算内被打断；不是靠杀进程；打断后 runner 重建、不复用上下文。 |
| S4 | 消息边界 | 只接受有界 JSON；函数、Promise、循环对象、>64KiB 被拒绝；不回传引擎内部对象。 |
| S5 | 崩溃隔离 | 引擎 abort／OOM 后 runner 退出码可观察；broker 完成已登记控制清理；body 继续服务。 |
| S6 | 冷启动开销 | 记录 spawn→首次 hook 的耗时，决定 runner 常驻或每次重建；不得把冷启动藏进停止预算。 |
| S7 | 调度边界 | 确认 behavior step 与 hook 内无定时器、无 `await`、无后台任务；`wait` 由 `ctx.wait` 与执行器承担，超时由 runner 与 broker 承担。 |

## 5. 攻击清单

**朴素组（必须全挡）**：`process`、`require`、`module`、`global`、`__dirname` 不可用；`require('node:fs'|'node:net'|'node:child_process')` 失败；动态 `import()` 失败；`fetch`／`WebSocket`／`Deno`／`Bun` 不存在；`globalThis.constructor.constructor('return process')()` 失败。

**已知逃逸组（记录结论）**：`this.constructor.constructor` 家族、`arguments.callee.caller` 链、`Error.prepareStackTrace`／`captureStackTrace` 取宿主栈帧、注入对象（时钟函数、结果 JSON）作为跳板。

## 6. 资源上限

与[运行时配置表](RUNTIME.md#10-首版配置起点)一致：behavior 单步 50ms、hook 50ms／无响应 500ms、policy 20ms／200ms、runner 64MiB、单 act 30s、单次输出 64KiB、收尾 1000ms。上限是工程预算，不是性能保证。

## 7. 引擎选型与 spike 记录（待填）

| 候选 | 状态 | S1 | S2 | S3 | S4 | S5 | S6 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Node 子进程 + `node:vm`（基线） | 未执行 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| QuickJS／WASM 变体 | 未执行 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |

基线预期：S2 只能靠进程堆上限、S3 依赖 `vm` 的 timeout 并须丢弃上下文、S1 在已知逃逸组大概率不达标。基线的作用是量化「进程边界能兑多少」，不是选型结论。

behavior 的 `behavior` 角色使用同一条 Node 子进程 + `node:vm` 基线：独立上下文只注入冻结的 `ctx`，不注入宿主能力；它不构成完整安全隔离，也不能据此承诺可安全运行第三方 behavior。

选型输出必须包含：引擎与版本、WASM 资产大小、离线加载方式、S1—S7 的逐项证据、未达标项的降级承诺。

## 8. 失败与降级

| 情况 | 处理 |
| --- | --- |
| hook／policy 超时 | 记录 `ACT_TIMEOUT`／`POLICY_TIMEOUT`；杀死并重建 runner；broker 清理已登记效果。 |
| behavior step 超时 | 记录 `BEHAVIOR_STEP_TIMEOUT`；结束 run 并按 act 收尾路径清理。 |
| runner 崩溃 | act 业务失败 `ACT_RUNTIME_ERROR`，behavior 失败 `BEHAVIOR_SCRIPT_ERROR`；清理失败升级为 executor fault，不伪装停止成功。 |
| 内存／输出超限 | `BUDGET_EXCEEDED`，走同一收尾路径。 |
| 提交未声明 op | `OP_NOT_DECLARED`，该 act 立即失败，控制权不转移。 |
| 引擎缺失／加载失败 | body 启动时明确报错；不静默回退到进程内 eval。 |

## 9. 阶段限制

在 §7 有通过记录之前：

- 只启用维护者提供的 act 与内置 behavior；
- 允许 agent 编写并检查 act／policy，但不自动启用；
- `imported` 来源一律不可启用；
- 对 agent 明示当前阶段限制（见[DSH 接入 §5](DSH-INTEGRATION.md#5-模型工具与界面反馈)）。

## 10. 证据记录要求

每条结论记录：引擎与版本、平台、命令、观察结果、失败模式、未覆盖项。文档中的「通过」必须有对应证据文件或 M5 验收条目，不能只凭一次手工试验。

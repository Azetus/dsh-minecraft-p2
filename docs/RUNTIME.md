# P2 执行器与运行状态详细设计

> 本文定义执行器的状态传播、非阻塞调度、单 act 控制权、查询、停止与故障恢复规则。配置参数是实现起点，不是实测性能保证。
>
> 关联：[主架构](ARCHITECTURE.md)、[接口契约](CONTRACTS.md)、[扩展生命周期](BEHAVIOR-LIFECYCLE.md)。

## 1. 执行责任与进程

每个 body 首版只绑定一个角色，由人工 start 后的 bridge 创建并持有，使用 stdio 通信；调度仍在独立 body 进程内执行，不等待模型。一个串行调度器推进当前 behavior 的 generator，至多一个 act 持有控制权。模型推理、文件编译、只读查询等待不占用该控制权。

body 中的可信执行器按 step 驱动 behavior：一次只把 generator 恢复到一个 `yield`，把该命令交给对应端口；它不执行作者提供的任意 Promise 或回调。behavior 在隔离 runner 的 `behavior` 角色中加载模块并单步执行；自定义 act 与 policy 在隔离 runner 中执行，act 通过消息请求 op，policy 只通过纯桥接收输入并返回一个值。单步推进、操作归属和错误处理仍由唯一 body 执行器决定。隔离进程并不引入并行 behavior 或两个控制 act。

operation broker 是可信基础库的一部分：校验调用、记录持续操作、向选定实现转发请求、执行清理与预算检查。act runner 不能直接持有游戏连接。停止时，即使 runner 挂起，broker 也知道需要撤销哪些操作，并拒绝未在 act manifest 中声明的 op 调用。具体游戏线程调度由 operation 实现完成。

首版使用一个可重建的 runner，串行接收当前 act 的生命周期调用、承载 policy 调用并运行 `behavior` 角色；同一时刻不执行两个 hook，也不并发推进两个 generator。policy 调用与 act hook 共享同一个串行通道，不引入第二个执行者。候选静态检查使用独立的一次性上下文；behavior 模块在 `behavior` 角色中加载。进程创建、加载与握手在授予动作控制权前完成，不将冷启动耗时藏入 act 的停止预算。

## 2. 三组独立状态

### 2.1 单步运行状态

`idle → running → waiting → running … → succeeded | failed`；取消则 `running | waiting → stopping → cancelled`。等待表示当前 step 停在 query、act、policy 或 wait 上，不是第二个执行者。

- 成功、失败、取消都是已收尾终态。正常结束但正在收尾时仍是 running，附内部阶段 `finishing` 和预期结果；取消时为 stopping。
- 同一次运行不能从终态回到 running。重试或重新启动创建新的 runId。
- 每次 step 只推进一个 `yield`；命令完成前 generator 不再运行，结果只能恢复当前运行的 generator。
- 晚到结果不能改变已结束的 run。持续效果的迟到确认只能交给 broker 对账，不能重新驱动 generator。

### 2.2 behavior 实例状态

| 状态 | 规则 |
| --- | --- |
| running | 单步推进 generator，等待 query/act/policy/wait，或执行收尾。 |
| blocked | 已完成动作收尾，无控制 act，等待明确外部输入。 |
| succeeded | 有限 behavior 已调用 `ctx.succeed` 并完成收尾（声明 externalConfirmation 时已获确认）。 |
| failed | 脚本错误、未捕获异常或 `ctx.fail` 结束，收尾完成。 |
| cancelled | 被停止或替换，收尾完成。 |

status 至少暴露 `currentStep`（如 `query:position`、`act:move-to`、`wait 500`、`decide:pick-ore`）、`activeAct`/`activeTarget`、`waiting`、`progress`、`lastFailure` 与 `lastRun`。`progress` 取最近一次 `ctx.progress` 的值；运行进度通过这些字段观察。

queued 是切换请求状态，不是已经运行的 behavior。blocked 默认不自行恢复、不轮询重试，不自动超时；允许查询、取消或替换，不占角色控制权。外部恢复创建新的运行实例并重新读取当前事实，首版不恢复任意 generator 栈。

`blocked/CONFIRMATION_REQUIRED` 是已完成执行后的外部验收：有效确认或否定直接结束原实例，不恢复原运行。它与普通 blocked 后重新启动执行不同，具体见[外部完成验收](#44-外部完成验收)。

有限 behavior 必须以 `return ctx.succeed(evidence)` 结束；`run` 自然返回而未调用 `succeed`/`fail` 时按脚本错误失败。持续 behavior 不自行报告成功，由 agent 停止或替换后进入 cancelled；需要继续努力必须由代码显式循环或等待。运行时只记录 `ctx.succeed`/`ctx.fail` 的结果并执行收尾。

### 2.3 执行器健康与连接状态

健康状态为 ready、stopping、faulted、recovering；连接状态单独记录 disconnected、connecting、connected。faulted 不伪装成普通 behavior failed/blocked，尚未确认停止的实例保持原运行/停止阶段并附故障。

一旦故障使控制权不确定，所有新的控制 act 都暂停。只读查询和诊断在实际连接允许时继续；“查询接口仍存在”不保证断开的游戏可被查询。

## 3. 每轮调度与资源上限

按单调时钟安排 tick；不把墙钟跳变用于超时或有效期判断。每轮顺序固定：

1. 在轮首固定已到达结果与命令的批次，依 ingressSeq 排序并校验归属；更新操作账本，暂存待处理结果。本轮推进期间到达的消息留到下一 tick。
2. 处理本批有效的人工停止、切换、失联撤销和故障；在推进业务结果或启动新动作之前应用取消请求。无效命令不能打断当前运行。
3. 推进已开始的清理，检查总期限。停止期间不启动普通控制操作。
4. 更新 query/act/policy/wait 的等待状态、取消与超时。
5. 每次恢复 generator 一个 step 并执行其 `yield` 命令，或推进当前 act；每次启动新 act 和提交终态前经过统一检查点，不等待外部 I/O。
6. 汇总并发布状态变化和必要事件；轮末不回滚本轮已经成功的命令结果。

D2 采用执行器内部顺序可见：同一 tick 内 generator 恢复后立即看到自己此前的普通 JS 赋值，符合 [D1 写入规则](#43-局部状态与结果写入)。单次 step 不是事务，后续命令失败不撤销此前成功的结果；不同命令的结果不承诺原子快照。尚未就绪的 query 或尚未成功收尾的 act 不能提前恢复 generator。

每轮最多推进 100 个 step，可信调度处理时间目标 10ms；预算耗尽则让出，不把 run 判为失败。单步 CPU 上限 50ms，超时按 `BEHAVIOR_STEP_TIMEOUT` 失败并走收尾；step 不跨 tick 补跑。错过 tick 后记录调度延迟并使用当前时间处理超时。

`yield ctx.decide(ref, inputs)` 提交一次 policy 请求，generator 进入 waiting；**等待不在 tick 内同步发生**，执行器照常处理取消、失联与清理。结果到达后校验为受限 JSON 并恢复 generator；失败、超时或结果不合法以异常抛回 behavior，由作者代码决定是否捕获。取消时丢弃等待中的请求，晚到结果不得恢复 generator。`ctx.fail` 立即以声明的业务码结束 run，且不得被“目标已达成”的证据掩盖。

事件监听器只能入队，不能在回调中推进 generator、改写运行状态或提交终态。本批有效取消优先于本轮尚未提交的终态，不以成功消息在批内排得更早为由抢先成功。批次固定后到达的取消在下一 tick 处理；若届时实例已终态，返回 alreadyTerminal。统一检查点使用本批已处理事实及当前单调时间检查 owner 授权、bridge 存活期限和数据有效性，不中途吸收下一批消息。

### 3.1 新动作与终态的统一检查点

启动新 act 前，确认无取消或故障、旧控制已释放。generator 停在 `yield ctx.act` 上，behavior 是否继续完全由恢复后的代码决定。externalConfirmation 不要求每个动作前取得外部确认。若 behavior 在启动 act 前使用旧观测，须自行 `ctx.fresh`；运行时不会自动重查或按 false 放行。

提交 behavior 终态前，统一检查其归属、已处理取消、错误与结束意图以及应有的收尾证明；`ctx.succeed` 的成功还须完成 act 与 broker 收尾。检查点不重新执行 behavior 代码；检查和命令分发计入本轮调度预算，预算耗尽则让出，不能跳过检查点。

## 4. 生成器执行语义

behavior 的控制结构（顺序、条件、循环、重试）由作者代码本身表达；运行时只认识 `yield` 命令，不提供其他调度原语。

| yield 命令 | 推进 | 终止与取消 |
| --- | --- | --- |
| `ctx.query(op, args)` | 提交一次 QueryOp；pending 时 waiting，完成后恢复 `{ value, meta }`。 | 失败抛出 `P2Error`；取消后不再恢复 generator。 |
| `ctx.act(ref, args)` | 启动 act 并等待；`currentStep` 为 `act:<ref>`，`activeAct`/`activeTarget` 进入 status。 | 成功收尾后恢复 output 并清空 active；失败抛出；取消时停止 act 并终止 generator。 |
| `ctx.decide(ref, inputs)` | 提交一次 policy 请求；pending 时 waiting，完成后恢复受限 JSON。 | 失败、超时或非法结果抛出；取消丢弃请求，晚到结果不恢复。 |
| `ctx.wait(ms)` | 可取消等待；`currentStep` 为 `wait <ms>`。 | 到期恢复；取消立即终止。 |
| `ctx.progress(obj)` | 更新 status 的 `progress`，随后立即恢复。 | 取消后拒绝新命令。 |
| `ctx.log(message, data?)` | 写入有界日志，随后立即恢复。 | 取消后拒绝新命令。 |
| `return ctx.succeed(evidence)` | 记录有界 evidence，进入成功收尾。 | 收尾未完成前不提交 succeeded；取消优先。 |
| `return ctx.fail(code, message)` | 记录业务失败，进入失败收尾。 | 不得被“目标已达成”的证据掩盖。 |
| generator 自然返回 | 未调用 `succeed`/`fail`，按脚本错误失败。 | — |

一次 step 从上次 `yield` 恢复到下一个 `yield` 或终止；一次只执行一个命令，恢复值只交给当前 generator。单步 CPU 上限 50ms，超时按 `BEHAVIOR_STEP_TIMEOUT` 失败；长时间无 `yield` 的循环会被该超时中断。

取消由执行器停止当前 act 并调用 `generator.return()`；之后拒绝任何新的 `ctx` 命令。取消不可被 `try/catch` 吞掉：driver 记录取消并忽略后续 `yield`，behavior 不能把取消变成成功。`finally` 只能清理纯状态，不能发游戏操作。

错误处理：未捕获的 `P2Error` 使 run 失败；未知异常按 `BEHAVIOR_SCRIPT_ERROR` 失败；两者都先走 act 收尾。

### 4.1 推进与等待

driver 只在 `yield` 边界恢复 behavior；命令未完成时 generator 保持 waiting，不会被并发推进。query、act、policy 由端口异步推进，act 不阻塞调度循环；等待期间仍处理取消、失联与清理。

没有独立的条件求值轮次。behavior 需要新事实时，必须在恢复后再次 `ctx.query`；act 运行期间不会重新求值其他条件，也不会自动切换策略。

一旦开始停止，不再恢复 generator 执行新命令；停止完成后也不会用旧授权启动新 act。未完成命令的晚到结果不得恢复已结束的 generator。

### 4.2 完成判定

有限 behavior 在代码路径上调用 `return ctx.succeed(evidence)` 才算成功；evidence 为有界 JSON，由运行时记录。运行时只在 `ctx.succeed` 被调用时记录成功证据，不替作者判断代码路径或目标是否达成。`ctx.fail(code, message)` 记录业务失败，不得被“目标已达成”或其他证据掩盖。

持续 behavior 持续运行到 agent 停止或替换；正常动作完成不代表整个 behavior 成功，停止后记录 cancelled。`run` 自然返回而未调用 `succeed`/`fail` 按脚本错误失败。

完成收尾后再确认 act 与 broker 已释放控制；声明 externalConfirmation 的 run 在收尾后进入 blocked/CONFIRMATION_REQUIRED，确认通过才提交 succeeded。收尾失败进入 faulted，不发布成功。人工取消、脚本失败与成功各有独立结束原因，不能把 stop 后的 cancelled 当成业务成功。

#### 同轮结束原因的裁决

控制健康与业务结果分开判断。控制权释放尚未确认时，保留结束意图和原始诊断，继续收尾而不提交终态；确认清理失败、期限耗尽或控制结果不确定时，按既有规则进入 faulted。不能将故障直接折算成 succeeded、failed 或 cancelled。以下顺序用于尚未锁定结束意图时，对本批已接受事实进行裁决：

| 优先顺序 | 情况 | 处理 |
| --- | --- | --- |
| 1 | 实例此前已提交终态 | 终态不变；晚到停止返回 alreadyTerminal，旧结果不再恢复 generator。 |
| 2 | 有效 stop、switch、shutdown 或 owner 授权撤销 | 取消意图优先；完成收尾后 cancelled，同时保留已发现的失败诊断。 |
| 3 | 未被捕获的脚本或契约错误 | 失败意图优先，不能用 `ctx.succeed` 掩盖脚本异常、act 运行异常或结果 schema 不合法。 |
| 4 | `ctx.succeed` 已返回、收尾确认通过；声明 externalConfirmation 时还须有效确认 | 提交 succeeded，记录 evidence；控制故障仍阻止提交。 |
| 5 | `ctx.fail`、未知异常或自然返回 | 提交 failed 并记录原因；不把 pending/取消当作完成证据。 |
| 6 | 无需结束 | 继续运行或等待。 |

有效取消优先于同批尚未提交的成功或失败；已提交终态不被晚到消息改写。锁定成功或失败意图后，不再恢复 generator 执行新命令。外部验收的确认、否定及去重遵循 [D3 外部完成验收](#44-外部完成验收)，同样不能绕过有效取消和控制故障。

### 4.3 局部状态与结果写入

数据契约见[数据归属与寿命](CONTRACTS.md#31-数据归属与寿命)和[显式赋值与成功输出](CONTRACTS.md#32-写入与成功输出)。`ctx.params` 是启动参数的只读快照；behavior 的其他状态是作者 generator 内的普通 JS 变量，随 run 结束消失。运行时不维护 local 帧，也不提供跨 yield 的隐式状态槽。

`ctx.query` 恢复为 `{ value, meta }`，`ctx.act` 成功恢复为 output；失败以异常抛出。act 结果只在成功收尾确认后恢复，失败或取消不返回成功输出；broker 仍按控制契约处理已经发生的动作效果。

同一 step 内普通赋值立即可见，一个 tick 不是事务；后续命令失败不回滚此前已经完成的赋值。跨 yield 复用旧快照前必须 `ctx.fresh(snapshot)`，时效不会自动传播。

运行时只保存 status、progress、evidence 与诊断，不向 behavior 暴露可变的宿主对象或局部变量引用。重复、取消或旧 epoch 的晚到结果不得恢复 generator。

### 4.4 外部完成验收

D3 将 externalConfirmation 定义为一次执行后的外部验收。仅适用于显式声明该方式的有限 behavior：behavior 成功结束、act 与 broker 均已收尾、无遗留控制操作时，由 body 创建待确认记录并进入 blocked/CONFIRMATION_REQUIRED。每个 run 最多创建一条完成确认请求。behavior 失败仍按失败处理，不能用外部验收覆盖未处理的执行错误；普通 blocked 不能被 confirm 当作完成验收。

待确认记录固定目标说明及运行参数引用，关联 bodyEpoch、runId、confirmationId 和 owner，并提供执行结果摘要；契约见 [CONTRACTS §7.1](CONTRACTS.md#71-外部完成验收契约)。确认只结束这个原实例，不重新执行 behavior，不修改其运行状态，也不发起游戏控制。

| 输入 | 原实例与请求的处理 |
| --- | --- |
| 有效确认满足目标 | blocked → succeeded；关闭请求，记录外部确认来源和依据，不标为游戏自动验证。 |
| 有效否定目标达成 | blocked → failed/EXTERNAL_GOAL_REJECTED；关闭请求，保留否定原因。 |
| 暂时无法判断 | 不提交决定，保持 blocked；第一版不增加第三种决定或自动重询。 |
| 有效 stop、switch、shutdown 或 owner 授权撤销 | 按取消规则结束原实例并关闭请求；有控制故障时仍不得越过终态检查点。 |
| 身份、归属、请求标识或载荷不合法 | 拒绝命令，保持实例原状态；命令被拒绝不等于外部否定目标。 |

否定后需要补做工作时，重新查询当前环境并启动新实例，不恢复旧 generator 栈。确认和否定结束原实例，均不属于 blocked 后恢复执行。

等待确认没有额外倒计时，不自动成功、失败或定期催问；首版仍受 bridge 存活期限和 owner 授权约束。运行被取消或替换、授权撤销或 body 重启后，旧请求不再接受新决定，不能迁移到新 run/epoch。管道有效且原 body/run 仍存活时，可通过 status 取得同一请求；stdio 断开进入清理退出，不重连到旧 run。确认请求及决定只在内存管理，历史日志仅供人工调试，不用来恢复决定。WS 的 lease 内重连规则保留在[后续方案](WS-FUTURE.md)。

命令去重先校验调用者权限：同 commandId 同内容返回已有命令结果，同 id 不同内容拒绝。不同 commandId 对同一请求重复提交相同决定时，返回已处理结果，不重复发布终态事件，也不覆盖首次决定的来源和依据；相反决定返回冲突。请求已因取消、替换或 epoch 变化失效时，不接受新决定，返回关闭/失效结果；对已提交终态的历史查询不改变运行状态。

同批出现确认和否定时，按 ingressSeq 接受第一条有效决定；同批有效取消优先于两者，已提交的终态不被下一批消息改写。决定提交须通过 D2 终态检查点，控制故障不能被外部确认解除；未提交终态不得对外报告验收已成功处理。accepted 仅代表命令已受理，最终结果仍按命令状态和 run 状态查询。首版消息与方法见 [CONTRACTS §8](CONTRACTS.md#8-bridgebody-消息协议)；D6 只保留调试日志与内存记录，持久化恢复及崩溃对账见[后续恢复边界](FEEDBACK-AND-RECOVERY.md#7-异常退出与后续恢复功能)。

## 5. act 与操作控制权

broker 为每次 act 发放 actEpoch，所有控制请求携带 bodyEpoch、connectionEpoch、runId 和 actEpoch。一个角色至多一个有效控制授权。正常结束和取消首先关闭普通调用入口，保留限定的清理通道。

act 只能提交 manifest 中声明的 op；未声明调用返回 `OP_NOT_DECLARED` 并使该 act 失败，不改变控制权归属。broker 按 op 契约与运行配置执行效果预算（破坏方块数、放置数、攻击次数、消耗物品数、移动距离等），超限返回 `BUDGET_EXCEEDED` 并走同一收尾路径。预算是操作账本的副产品，不引入第二个控制者；act 内的只读查询不占控制权，至多一个持续控制效果同时生效。

清理通道只接受该 act 已登记持续操作的 stop/release；不能借收尾移动到新目标、开新攻击或执行新的策略。通用取消不能撤销已发生的放置、消耗、破坏。

持续 op 必须在发送给游戏前登记，避免“已发出但未记账”。即使启动确认丢失也视为可能活动；broker 必须查询/撤销该请求或保持故障。act hook 抛异常、返回失败或进程退出，均走相同收尾路径。

act 自称完成不等于控制权释放：只有 broker 确认持续操作已停止、回调已隔离、无未决控制请求，才进入终态。终态后拒绝旧 runner 的普通请求；迟到结果只对账。

## 6. 停止、重试与未知结果

沿用主文档共识：首次停止或正常收尾开始建立总 deadline。每个明确可重试的清理操作最多追加一次，所有操作共享总期限；不重发整个 act，不重置计时，不在 broker/runner/driver 各叠加次数。

可重试条件：契约允许重复安全执行、上次明确结束、错误明确 retryable、尚有次数和剩余期限。超时或连接丢失且结果未知时，不等同于 failed；不启动第二个同类操作。

查询清理状态也是 QueryOp，每次只请求一次；若要再次检查，必须是清理流程中显式的有界轮询，不能由 QueryOp 内部隐藏重试。不支持可靠撤销的操作应在能力声明中明确，不能假装“立即取消”。

无法收尾或预算耗尽进入 faulted，保留归属。恢复只接受旧操作停止的有效确认，或可信驱动给出的整体撤销确认；单纯杀死 runner/body 不能证明游戏已停止。底层确实撤销之后才建立新 epoch。

## 7. 切换命令与版本一致性

切换请求明确指定 artifactId、参数和 commandId；先验证 owner、产物及闭包摘要、适用凭据、启用资格、当前加载 binding 和实际连接能力，再停止旧 behavior。候选或依赖已退休、缺失、摘要不符、环境不符或能力缺失时拒绝请求，无效候选不能打断现有行为。切换响应只代表 accepted，最终通过 commandId 查询或事件得到 activated/rejected/superseded。

首版 pending 切换槽只有一个：同一 owner 的后到有效请求覆盖尚未激活的候选，旧请求记为 superseded；人工 stop 清空 pending。停止一旦发起不可撤回。故障期间可以记住候选，但不能自动跨故障启动，恢复后须重验 owner、binding 与候选有效性。

当前 run 固定 behavior artifactId、确切 act 产物及传递依赖闭包、环境 binding 和参数，不能热改。源码 revision 不足以选择产物，同源码采用不同依赖或环境可生成不同 artifactId；默认启用映射须在请求进入执行器前解析，不能运行中重新查 latest。

新增或启用 H2 不改变仍锁定 H1 的旧 run，也不重新加载 provider。H1 退休后，依赖它的新 run 被拒绝，旧 run 的后续 yield 仍使用原闭包直到按约定结束；需要立即停止须另发停止命令。候选切换等待收尾期间若其依赖被退休，授予新控制权前复核应拒绝新启动；旧 run 已停止时保持无主动行为，不自动替换成同名新产物或恢复旧动作。

可被动检查并按目标 binding 启用另一环境的候选，但当前 body 仍只加载一个 provider，普通 switch 不执行环境升级。更换 provider/执行环境仍走人类管理流程：先停止并确认清理，再加载/握手新环境，显式启动匹配产物。详见[环境与依赖范围](OPERATIONS-AND-RELEASE.md#31-环境产物依赖与运行实例)。

## 8. QueryOp 的具体执行

每次调用有 requestId、consumerRunId、connectionEpoch、deadline。请求在 body 单调时钟上计时；取消/超时后从等待集合移除，晚到结果不得恢复 generator。

观测新鲜度采用保守年龄上界：同进程可记录 monotonic sample time；跨进程驱动若无可信时钟映射，则保证采样发生在接收本请求之后，以 body 发出时间作为保守起点。若返回驱动缓存，必须附缓存年龄上界，不能只给回复时间。无法建立年龄界且调用要求新鲜度时返回 FRESHNESS_UNPROVABLE。

每次消费都检查年龄，而非只在收到回复时检查。多个 QueryOp 的结果不承诺原子快照；有此需要时由一个明确的复合 QueryOp 保证。结果限本次运行使用，不进入持久世界缓存；实体引用必须带连接/世界作用域，跨重连无效。

结果为空可以是成功；partial 必须注明范围，调用方明确允许才接受，否则 QUERY_INCOMPLETE。对过期/不完整结果的拒绝不自动查询第二次。对同一条件的失败不能靠下一 tick 自动重发掩盖；重试须由 behavior 代码显式安排。成功后的周期刷新是新的正常查询。

## 9. 托管生命周期、断连与重启

- **正常关闭/插件释放**：bridge 拒绝新业务，通过 shutdown 停止 run、清空 pending，待 act/broker 收尾确认后关闭游戏连接和辅助进程，再退出 body。模型 stop 只停止行为，人工 /p2 stop 关闭整个托管 body。
- **stdio 关闭或失效**：stdin EOF、输出管道失效、不可恢复协议错误均撤销 owner 授权，主动清理退出；不保留服务等待重连，也不自动启动新 body。
- **bridge 卡住**：管道尚开但 heartbeat 超过存活期限时撤销授权并清理退出。heartbeat 由 bridge 独立于模型回合维护，模型推理慢本身不代表 bridge 失活。
- **热重载/再次启动**：插件释放旧 body 及其 runner/检查进程，重载后保持未启动。人工 start 创建新 bodyEpoch；旧进程树未回收或控制未决时，不启动新的控制者。换 owner session 也采用先关闭旧 body 再人工启动新 body。
- **游戏连接断开**：立刻禁止新控制调用，连接 epoch 作废；不能假定游戏输入已解除，按驱动停止证明处理 fault。
- **body 崩溃**：底层驱动的控制释放/watchdog 能力仍须验证；新 body 生成新 epoch，从空运行开始，只做当前启动与连接核验，不从日志重建旧控制账本或自动对账。未知游戏效果由开发者/人类核查，不将重新启动当成停止证明。
- **runner 崩溃**：body 仍负责清理；act 业务失败为 ACT_RUNTIME_ERROR，behavior 失败为 BEHAVIOR_SCRIPT_ERROR；清理失败另报 executor fault。
- **机器重启**：保留已正常保存的源码、artifact、显式目标及可用调试日志，不保证有上次运行终态；不恢复 generator 栈、命令或通知，不自动归档未完成运行。新的执行需人工启动，不能伪造上次已取消或成功。

退出和进程树回收必须有界，并在 Windows 上验证；正常路径不能先强杀再宣布收尾成功。强制结束时由存活的一方尽力显示 interrupted/结果未知，不承诺记录可靠保存。平台回收不保证游戏控制已释放，插件 dispose 回调也不保证可完整等待；EOF/存活检测、内存 broker 清理与进程回收分别验证。首版不实施崩溃恢复；独立常驻服务及断线后保留 body 的设计仅属于[后续 WS 方案](WS-FUTURE.md)。

驱动 watchdog 只撤销控制，不决定战斗/逃跑等游戏策略，因此不构成第二套并行 behavior 或未经讨论的反射 AI。若接入方案无法提供这一保证，必须作为接入验收限制披露，不能宣称崩溃安全。

日志只是异步调试输出。命令受理和运行终态均不等待日志落盘；loggingUnavailable 或丢日志不改变 executor health，也不触发业务停止。正常退出仅有界尽力刷新日志，停止和控制清理不能等待日志恢复。普通请求、输出与检查队列仍须有界，停止/心跳/清理预留通道按[首版队列规则](FEEDBACK-AND-RECOVERY.md#33-有界队列与停止优先)执行。

## 10. 首版配置起点

以下默认值为本轮设计取值，可由开发者/人类配置覆盖，需在两套游戏候选环境实测；不是模型可任意放大的预算。

| 配置 | 初值 | 责任 |
| --- | --- | --- |
| behavior tick | 100ms | body 调度器 |
| 每轮 step 上限／处理目标 | 100／10ms | 超限让出并计量 |
| behavior 单步 CPU 预算 | 50ms | 超时按 `BEHAVIOR_STEP_TIMEOUT` 失败并走收尾 |
| 默认 QueryOp deadline | 1000ms | 单次查询，0 自动重试 |
| 控制条件数据最大年龄 | 500ms | 调用可声明更严要求；可显式配置其他值 |
| 面向 agent 的摘要数据最大年龄 | 2000ms | 仍标示时间和范围 |
| 停止／正常收尾总期限 | 2000ms | 每个失败清理 op 最多追加 1 次 |
| act hook 软预算／无响应上限 | 50ms／500ms | runner 超限后撤销普通调用并清理 |
| policy 单次调用预算／无响应上限 | 20ms／200ms | 纯桥调用；超限使调用失败并抛回 behavior，不进入 act 清理流程 |
| runner 内存上限 | 64MiB | 引擎级限制优先，进程级兜底；命中后杀死并重建 runner |
| act 单次运行总时长默认上限 | 30s | 可由产物 `limits` 收紧，不得超过宿主上限 |
| 单次 behavior step／hook／policy 输出上限 | 64KiB | 超限拒绝该结果，不截断后当成功 |
| 效果预算（每个 run／act） | 按 op 类别配置 | 破坏、放置、攻击、消耗等破坏性效果计数；超限走同一收尾路径 |
| bridge heartbeat／存活期限 | 2000ms／10000ms | 管道尚开时检测 bridge 失活；超期清理退出，已知 EOF 立即进入关闭流程 |
| 驱动控制续租／失联释放目标 | 100ms／1000ms | 必须由具体接入验证支持 |
| 进度停滞提醒 | 30s | 默认仅产生进度诊断，不自动结束长动作 |

runner 无响应检测依赖 body 正常调度；硬件、GC、进程调度会影响实际时间，不能据此承诺硬实时。有限 act 的最长业务执行时间由其契约/参数声明，不能统一用停止期限代替。

## 11. 验收场景

1. 连续两次 `yield ctx.act('goto')` 只启动一个 act；不存在并行 act 控制。
2. 采集过程中收到取消或切换：确认停止前攻击 act 从未取得控制权。
3. act 等待期间 generator 不推进；完成后必须重新 query 才能使用新事实，不能沿用旧判定。
4. 取消与成功同批到达：已接受取消者归 cancelled；此前已终态者返回 alreadyTerminal。
5. 旧请求晚到、旧 runner 发送 op、重连前实体引用均不能控制新运行。
6. 正常失败收尾超时与主动取消超时进入同一种控制故障，不误报 failed/cancelled。
7. QueryOp 超时只有一次请求；清理 retryable failure 最多两次尝试且共用 deadline。
8. 单个 behavior step／act／policy 无限循环不阻塞 body；broker 仍能撤销操作，不能仅靠杀进程宣布停止。
9. stdio EOF/写端失效立即进入清理退出；管道尚开但 heartbeat 超期也退出。模型慢但心跳正常不触发停止；游戏重连不重放旧动作。
10. behavior step 抛错时本次命令不产生部分结果；不能写只读参数或绕过 `ctx` 改运行状态；取消后拒绝新命令。
11. query/act 的新调用不会拿到上一轮成功结果；失败、取消和未就绪的结果不转换为空值或旧值。
12. act 报告 complete 后清理尚未确认时不发布成功输出；清理失败不发布候选结果，重复确认不重复累计，旧运行晚到结果不恢复新 generator。
13. 同一 behavior 的多次调用及取消后重启拥有独立参数快照与 generator 状态；`ctx.params` 只读，跨 yield 的累计状态由作者变量保存。
14. 观测经过 behavior 内计算和跨 yield 传递后，来源、年龄及作用域仍可校验，复制不刷新时间；普通策略计数不会仅因经过观测有效期而失效。
15. 成功采集次数与实际背包数量分别处理；失败或取消前已发生的游戏变化不因缺少成功输出而被当作未发生。
16. 同一 step 内普通赋值立即可见；后续 yield 失败不回滚这次赋值。等待和预算耗尽可跨 tick，但不改变可见性规则。
17. behavior 重新查询后使用新结果；旧快照不会自动刷新，复用前须 `ctx.fresh`；查询失败不由运行时自动重试。
18. 同批成功与有效取消无论消息先后均按取消收尾；批次固定后到达的消息留待下一轮，终态一旦提交不被晚到取消改写。
19. behavior 代码在捕获普通环境失败后仍可选择 `ctx.succeed`；未处理的脚本错误或非法结果不得成功。
20. `ctx.succeed` 后清理超时进入 faulted，不发布成功；收尾期间收到有效取消则按取消意图处理。
21. 检查点不重新执行 behavior 代码；act 等待期间 generator 不推进，也不启动依赖旧条件的新 act。
22. 仅 externalConfirmation 的有限 behavior 在成功终态且双重收尾确认后创建一次待确认请求；清理未完成、失败/取消、持续 behavior 或其他 blocked 原因均不能被 confirm 判为成功。
23. 有效确认使原 run 成功，有效否定使原 run 失败并保留原因；两者都不恢复原运行。否定后补做工作使用新 run，无法判断时不提交决定、不自动催问或超时结束。
24. 错误 owner、runId、confirmationId、bodyEpoch 或非法载荷只导致命令被拒绝，不使待确认 run 失败；模型填写“玩家同意”不能改变可信来源。
25. 同命令重发、不同命令重复同一决定不重复发终态事件；相反决定冲突。同批相反决定按 ingressSeq 接受首个有效者，同批有效取消优先，终态不被晚到决定改写。
26. 同一有效管道可取回待确认请求；管道关闭、授权撤销、有效切换及 body 重启使旧请求不可再决定。控制故障下确认不能绕过终态检查，accepted 不被报告为 succeeded。
27. 当前 run 使用 H1 时检查/启用 H2 不改变 binding 或运行依赖；只有显式切换到引用 H2 的 artifact 才使用 H2，默认映射变化不影响 pending 或当前 run 的确切引用。
28. H1 退休阻止依赖它的新 run，旧 run 的后续 yield 仍用 H1；候选在停止等待期间出现退休/缺失依赖时不得接管，不自动换版本或恢复旧动作。
29. 同一 revision 的多个产物按 artifactId 区分；其他 binding 的候选虽可静态检查/启用，环境不匹配或实际能力缺失时 switch 被拒绝，当前行为不被打断。
30. 插件安装/加载/热重载不创建 body；人工 start 只创建一个 body 且不自动启动 behavior。模型 stop 保留 body，人工 stop/插件释放关闭进程树而不销毁用户 agent。
31. shutdown、宿主异常退出、runner 卡住及输出背压下，控制清理与进程回收分别验证；强制结束由存活一方尽力报告结果未知，不伪装停止成功；新 epoch 不恢复或重放旧命令。
32. 日志不可写、磁盘满、缓冲满和轮换删除不影响当前内存去重、业务结果及停止；丢弃计数/日志不可用状态可观察，终态响应不等待落盘。
33. 普通请求、查询、检查或输出达到额度时拒绝新增普通工作，停止/心跳/清理仍有独立处理额度；日志和 stderr 背压不阻塞执行器。重启不从日志修复、恢复索引或补投递事件。
34. behavior 通过 `ctx` 直接提交 ControlOp 时在静态检查阶段被拒绝；控制只能经 act 产物进入，查询仍可经 `ctx.query` 直接发起。
35. act 提交未声明的 op 立即失败且不转移控制权；把控制 op 写进 `queryOps`（或相反）在检查阶段返回 OP_KIND_MISMATCH。
36. `ctx.decide` 只提交一次 policy 请求；等待期间取消仍可推进，晚到结果不恢复 generator；失败以异常抛回 behavior。
37. `ctx.fail` 以声明的业务码结束 run；不能被 `try/catch` 转换为成功，不得被“目标已达成”的证据掩盖。
38. policy 超时、抛错或返回非法值时 `ctx.decide` 抛出；不进入 act 清理流程、不改变控制权；policy 拿不到宿主对象或 op 桥。
39. 同一 act 内多个只读 query 可并发，第二个持续控制效果被拒绝；效果预算耗尽后走与失败相同的收尾路径。
40. 旧 run 的 act／policy 结果晚到不恢复新 generator；runner 重建后不恢复旧上下文，新 act 从冷启动状态开始。
41. 取消期间旧 act 未确认收尾就不得启动新 act；清理失败保持故障，不接管控制权。
42. behavior 代码在 `yield ctx.act` 前可以选择不启动该 act；运行时不会替代码求值完成条件。
43. 查询输出在消费时校验年龄；证据仍新鲜且参数未变时可复用，不逐 tick 重发；过期或参数变化才新建请求。

这些是未来运行时测试验收，未在本次文档工作中实现或执行；不属于用户 behavior 检测器的模拟测试。

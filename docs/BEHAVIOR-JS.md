# behavior JS 架构（实验草案）

> 状态：**实验分支草案，未采纳**。当前主线仍是 behavior IR（[IR.md](IR.md)）。
> 本文定义“受限 JS 协程”作为 behavior 层另一种表示方式的初版方案，用于 IR vs JS 的对照实验。
> 若实验结论选择 JS，需要显式修订 [ARCHITECTURE.md](ARCHITECTURE.md) §5.1 与相关 decision，而不是把本文当作已生效契约。

## 1. 目标与边界

保持三级控制不变：

```text
behavior（本文：JS 协程） → act → ControlOp → 游戏
behavior → QueryOp（只读）
```

- behavior 只能通过 `ctx` 调 act/query/decide；**不能访问 ControlOp**，不能持有游戏连接。
- act、policy、op、broker、body、bridge 的契约不变；只替换 behavior 的表示与执行方式。
- behavior 仍然无智能：它是一段策略程序，不承担 agent 的规划与决策。
- 不是“任意异步程序”：I/O 只能通过 `yield` 命令，运行时不执行作者提供的任意 Promise/回调。

## 2. 形态

```js
export default {
  id: 'gather-ore',
  mode: 'finite', // finite | continuous
  parameters: {
    item: { type: 'string', required: true },
    want: { type: 'number', required: true },
  },
  *run(ctx) {
    let mined = 0
    while (true) {
      const inv = yield ctx.query('inventory', {})
      const pos = yield ctx.query('position', {})
      const pick = yield ctx.decide('pick-ore', {
        inv: inv.value,
        pos: pos.value,
        item: ctx.params.item,
      })
      if (pick.kind === 'none') return ctx.fail('NO_CANDIDATE', 'no ore visible')
      yield ctx.act('move-to', { x: pick.x, z: pick.z })
      yield ctx.act('mine-one', { pos: pick.pos })
      mined += 1
      yield ctx.progress({ mined, want: ctx.params.want })
      if (mined >= ctx.params.want) return ctx.succeed({ mined })
    }
  },
}
```

为什么是 generator 而不是 `async/await`：

- 每个 `yield` 是明确的调度、取消、计时边界；运行时可以在 `yield` 处注入结果、检查取消、实施单步超时。
- `async` 程序无法可靠抢占 CPU 循环，也无法保证取消时没有未清理的异步链。
- generator 仍是普通 JS，subagent 编写成本低；但 I/O 被限制为显式命令。

## 3. ctx API（初版）

| API | 语义 |
| --- | --- |
| `yield ctx.query(op, args)` | 执行一次 QueryOp，恢复为 `{ value, meta }`；失败抛出 `P2Error`。 |
| `yield ctx.act(ref, args)` | 执行一次 act，成功恢复为 output；失败抛出；取消不可被吞掉。 |
| `yield ctx.decide(ref, inputs)` | 调用一次 policy，返回受限 JSON；失败抛出。 |
| `yield ctx.wait(ms)` | 可取消等待。 |
| `yield ctx.progress(obj)` | 上报进度，进入 status。 |
| `yield ctx.log(message, data?)` | 有界日志。 |
| `ctx.params` | 启动参数，只读快照。 |
| `ctx.runId` / `ctx.now()` | 当前运行标识与单调时间。 |
| `return ctx.succeed(evidence)` | 有限 behavior 成功，记录证据。 |
| `return ctx.fail(code, message)` | 业务失败，记录原因。 |

约束：

- `ctx.query` 返回的 `meta` 必须参与时效判断；直接使用旧快照前必须 `ctx.fresh(snapshot)`，否则按作者责任处理。JS 模式不自动传播时效，这是相对 IR 的真实损失。
- `ctx.decide` 是唯一跨进程纯计算入口；允许 behavior 内联纯计算，但跨 behavior 复用的决策应做成 policy 产物。
- `ctx.act` 的 ref 解析与 IR 相同：definitionId + 启用映射，产物可带 artifactId。

## 4. 执行模型

```text
Host / Run
  └─ JsBehaviorRun（驱动、状态、取消、完成）
       └─ runner(role=behavior)
            └─ 加载模块、创建 generator、单步执行
                 └─ 返回 yield 命令 / done / error
```

一次 step 的协议（示意）：

```text
driver → runner: { step: "start", runId, params }
runner → driver: { kind: "yield", command: { type: "query", op: "position", args } }
driver 执行命令 → runner: { step: "resume", value/meta } 或 { step: "throw", error }
runner → driver: 下一个 yield / { kind: "done", result } / { kind: "error" }
```

- 单线程、单步：一次只推进一个 yield；不等待长 act 完成，act 由端口异步驱动并回传结果。
- 每个 step 有 CPU 时间上限（初值 50ms，可调）；超时按 `BEHAVIOR_STEP_TIMEOUT` 失败并走收尾。
- 长时间无 yield 的循环会被 step 超时中断；作者必须让策略周期性让出。
- 取消：driver 停止当前 act，调用 runner 的 `stop`；runner 执行 `generator.return()`，之后拒绝任何 ctx 命令；行为里的 `finally` 只能清理纯状态，不能发游戏操作。
- 取消不可被 `try/catch` 吞掉：driver 记录取消并忽略后续 yield；行为不能把取消变成成功。
- 错误：未捕获的 `P2Error` → run 失败；未知异常 → `BEHAVIOR_SCRIPT_ERROR`；都先走 act 收尾。

## 5. 数据、完成与恢复

- **数据**：query 返回 `{ value, meta }`；meta 含 source/scope/sampledAt/validUntil。`ctx.fresh(snapshot, maxAgeMs?)` 在过期或无法证明时抛出 `STALE_OBSERVATION` / `FRESHNESS_UNPROVABLE`。与 IR 不同，**时效不会自动传播**，作者必须显式检查。
- **完成**：`mode: finite` 必须最终 `return ctx.succeed(evidence)`；`mode: continuous` 由 agent 停止。运行时记录 evidence，但**不能像 IR completion 那样静态检查**；这是 JS 的代价，也是实验要观察的可审计性差异。
- **恢复**：行为可用 `try/catch` 对 act/query 错误做局部恢复；重试预算、错误分类由作者决定，运行时只记录。IR 的 `recover` 是声明式的，JS 的是代码式的，两者语义不等价。
- **业务失败**：`ctx.fail(code, message)` 不被“目标已达成”掩盖；agent 通过 lastRun 读取。

## 6. 状态与可观测性

status 至少包含：

- `currentStep`：如 `query:position`、`act:move-to`、`wait 500`、`decide:pick-ore`；
- `activeAct` / `activeTarget`；
- `waiting`（query/act/policy/wait）；
- `progress`（最近一次 `ctx.progress`）；
- `lastFailure` / `lastRun`（成功证据或失败原因）。

JS 行为没有节点树，agent 无法像 IR 那样看到“计划结构”；可读性依赖代码本身与这些运行字段。实验会用同一个“四问”复核：当前阶段、当前目标、下一步、失败出口。

## 7. 隔离与安全

- behavior 代码在现有隔离 runner 中执行（新增 `behavior` 角色），不在 body 进程内。
- 禁止 `import` / `require` / `process` / `eval` / `Function` / `WebAssembly` / `fetch`；不注入 `setTimeout`/`setInterval`/文件/网络；禁止 `async`/`await`（保持单步语义）。
- ctx 是冻结对象，只暴露第 3 节 API；不暴露 ControlOp、broker、provider、locals 引用。
- 输出大小、日志条数、单步 CPU 时间、总运行时长都受预算限制；超限按失败处理并走 act 收尾。
- 这是 `node:vm` 基线，不是完整安全隔离；实验期 act/policy/behavior 都是本会话编写，不涉及 `imported` 产物。

## 8. 长跑策略

- `continuous` 行为可以无限运行（escort、区域采集）；必须周期性 `yield`，否则被 step 超时终止。
- 建议每个循环至少一次 `ctx.progress`，让 agent 能看到进度；进度对象应小且有界。
- 卡住检测：act 超时/失败 + 行为自己的重试/放弃逻辑；运行时不会替作者判断“卡住”。
- 内存：避免在闭包里无限累积列表；需要长期状态时优先重新查询世界或写回行为状态（有界）。

## 9. policy 与 act 的关系

- `ctx.decide` 与 IR 的 `decide` 同义：一次异步纯计算，结果写入 behavior 局部状态；policy 不能调 act/op。
- 允许 behavior 内联纯计算（距离、比较、格式化参数）；跨 behavior 复用的决策应提取为 policy 产物。
- act 契约不变：单目标、边界明确、必须声明 ops、必须可停止/收尾；behavior 不能把长期策略塞进 act。

## 10. 已决定的初值

以下为实验期初值，**不是最终契约**。若实验后采用 JS，允许继续优化（例如 evidence schema、freshness 的书写便利性、step 超时的默认值）。

| 问题 | 初值 |
| --- | --- |
| artifact 形态 | `kind: behavior` + `format: ir` / `format: js`；启用、检查、工具面与 IR 保持一致，避免形成第二套工具流程。 |
| 完成证据 | `return ctx.succeed(evidence)`；evidence 为有界 JSON，运行期记录；检查期只校验非空，不校验 schema。 |
| 时效 | `query` 返回 `{ value, meta }`；跨 yield 复用旧快照前必须 `ctx.fresh(snapshot)`，过期/无法证明时抛出 `STALE_OBSERVATION` / `FRESHNESS_UNPROVABLE`。 |
| policy 内联 | 允许 behavior 内联纯计算；跨 behavior 复用的决策仍应做成 policy 产物；实验日志记录“内联替代 policy”的次数。 |
| 取消 | driver 调 `generator.return()`；取消后 ctx 命令全部拒绝；`finally` 只能清理纯状态，不能发游戏操作；取消不可被吞掉。 |
| step 超时 | 初值 50ms（可配置）；超时按 `BEHAVIOR_STEP_TIMEOUT` 失败并走收尾。 |
| 状态粒度 | `currentStep` 为结构体 `{ type, ref/op, summary }`；另带 `activeTarget`、`waiting`、`progress`、`lastFailure`、`lastRun`。 |

这些决定只约束实验实现；IR 分支不因此改变现有契约。

## 11. 初版实现顺序（JS 实验分支）

1. 契约：`BehaviorJsArtifact`（模块 + manifest：id/mode/parameters），检查器（导出形状、禁用 token、参数定义）。
2. runner：`behavior` 角色、模块加载、generator 单步协议、step 超时、取消。
3. core：`JsBehaviorRun` 驱动（query/act/decide/wait/progress/terminal），复用现有 Host/Run 表面与 status。
4. body/bridge：artifact kind、check/activate/switch、status 透出 `currentStep`。
5. 测试：generator 驱动、取消/晚到结果、act 失败、长跑、时效 helper。
6. 与 IR 分支跑同一套 smoke（S1—S4 等价 + 长跑 + 取消 + 失败）。

## 12. 风险

- **可审计性下降**：没有节点树，完成条件与时效靠代码；agent 与人类都更难静态检查。
- **生命周期 bug**：行为代码可能吞取消、漏清理、无限循环；运行时要强制边界。
- **策略泄漏**：作者可能把规划写进 behavior 或 act；实验必须记录这种泄漏，因为它决定“JS 是否只是把复杂度藏起来”。
- **隔离基线**：vm 不是完整安全边界；实验结论不能外推为“可安全运行第三方 behavior”。

## 13. 分支实现状态（2026-10-28）

- 已实现：`kind: behavior` + `format: 'js'`、`checkBehaviorJs`、`JsBehaviorRun`、status 当前步骤/act/目标/等待原因、取消与 act 失败传播。
- 形态：`defineBehavior({ manifest, run })` 全局函数（不是 `export default`），`run` 是生成器；这是初版实现细节，若采纳 JS 可改为模块导出。
- **原型偏差**：behavior 代码在 body 进程内的 `node:vm` 中执行，尚未搬到隔离 runner；原因是先验证作者体验与执行语义。进入实验前若要求同等隔离，需要把 `JsBehaviorRun` 的 step 协议搬进 runner。
- 已支持命令：query / act / decide / wait / succeed / fail / progress / log；`ctx.fresh(snapshot)` 显式校验时效。
- smoke：与 IR 分支同一套 19 项，JS 分支 PASS 19/19；`npm run check` 178 tests pass。
- 已知限制：`progress` 只记录在运行内部、尚未进入 status；没有 external confirmation；`vm` 不是完整安全边界；没有对 `ctx` 宿主对象泄漏做对抗性验证。
- 证据：`.m5-runs/baseline-smoke-2026-10-28T08-23-23-959Z.json`。
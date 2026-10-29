# P2 数据与模块接口契约

> 本文规定 P2 的模块职责、数据结构、调用语义和消息协议。接口属于设计草案，省略辅助类型的 TypeScript 片段不能直接作为完整 SDK；Minecraft 专属数据模型另行确定。
>
> 关联：[主架构](ARCHITECTURE.md)、[执行语义](RUNTIME.md)、[DSH 接入](DSH-INTEGRATION.md)。

## 1. 模块与依赖方向

| 模块 | 对外提供 | 不负责 |
| --- | --- | --- |
| contracts | behavior 契约、消息、错误、版本及运行状态类型/运行时解析器 | 加载 DSH 或游戏 |
| op-contracts | QueryOp／ControlOp 的声明：名称、类别、参数/结果契约、持续效果、停止语义与能力标记 | 某版 MC 实现 |
| checker | 请求式语法/类型/构建检查，覆盖 behavior、act 与 policy，产出 artifact 与报告 | 游戏行为测试、自动调用模型 |
| registry | 不可变 artifact、源码 revision、校验凭据、按目标 binding 区分的启用记录与精确依赖 | 在游戏中验证策略正确性 |
| body | 树调度、act 生命周期、控制权、操作 broker、状态/执行事件 | LLM 会话和自然语言策略 |
| observation | QueryOp 调用门面及纯摘要函数 | 世界副本、历史差分、环境变化事件 |
| bridge | DSH 命令/工具、session 归属、事件合并和模型唤醒 | 直接发送游戏控制 |
| operation provider | 落实查询/控制/取消/对账契约 | 自动更换 behavior |

这是模块责任划分，不要求每行成为一个 npm 包；初版为单包交付，authoring 是同一包的子路径，body/provider 是包内资产，模块边界仍按本表。

## 2. 标识、时间与边界校验

所有对外 ID 为不透明字符串，在 TypeScript 内使用不同品牌类型防混用。至少区分 definitionId、revision、artifactId、runId、nodeRunId、actEpoch、requestId、commandId、confirmationId、bodyEpoch、connectionEpoch、bindingId、eventSeq、ownerSessionId。revision 是定义的源码版本，首版采用 sourceDigest；artifactId 才标识确切可执行产物，同一 revision 可以有不同依赖或 binding 的多个 artifact。产物类型（behavior／act／policy）计入摘要，三种类型之间不能互相替代。

- 跨进程值只能是受限 JSON：禁止函数、原型对象、NaN、Infinity、循环对象和游戏内部对象。
- schema 最小子集：有限数值、字符串/枚举、布尔、nullable、受限数组、封闭对象和判别联合。拒绝未知必需字段，扩展字段必须声明。
- 文件、模型工具输入、IPC 和协议消息都进行运行时解析；同模块已校验类型不反复序列化验证。
- 单调时间只在本进程内比较。消息中的墙钟用于展示；远端单调值不能直接与 body 时钟相减。查询采用 [运行时的保守年龄规则](RUNTIME.md#8-queryop-的具体执行)。
- 单条普通桥消息初始限制 1MiB，源代码/构建产物通过工作区文件及内容摘要引用，不塞入事件。参数限制为配置值并在两端一致验证。

## 3. behavior 模块与构建产物

behavior 产物是一个可加载的 ESM 模块，在顶层调用注入的 `defineBehavior` 声明 manifest 与生成器函数：

```js
defineBehavior({
  manifest: {
    id: 'gather-ore',
    description: '在可见矿脉中采集指定数量的矿石',
    mode: 'finite', // finite | continuous
    parameters: {
      item: { type: 'string', required: true },
      want: { type: 'number', required: true, min: 1 },
    },
  },
  *run(ctx) {
    let mined = 0
    while (true) {
      const inv = yield ctx.query('inventory', {})
      ctx.fresh(inv) // 消费当前快照前显式校验时效
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
})
```

`defineBehavior` 由 runner 在加载模块时注入，源码不 `import` 它；它只声明并校验模块形状，不执行游戏 I/O。模块顶层只能做 manifest、`run` 与纯计算的定义；加载阶段不得查询、控制、启动定时器或发起异步任务。`run` 必须是 `function* (ctx)` 形式的生成器函数，不能是 `async` 函数，I/O 只能发生在 `yield` 命令处。

```ts
type BehaviorManifest = {
  id: string;
  description?: string;
  mode: "finite" | "continuous";
  parameters: Schema;              // 启动参数 schema，实例内只读
};

type BehaviorModule = {
  manifest: BehaviorManifest;
  run(ctx: BehaviorContext): Generator<BehaviorCommand, BehaviorResult, CommandResult>;
};
```

`parameters` 是启动参数的 schema；实例启动时按 schema 校验并冻结为只读快照。`mode: "finite"` 的行为必须以 `return ctx.succeed(evidence)` 结束；普通返回或其他结束方式按失败处理。`mode: "continuous"` 不要求成功终态，由 agent 停止。业务终态只能由 `ctx.succeed` 或 `ctx.fail` 产生，取消由执行器结束 run；run 结束后 ctx 拒绝任何新命令。

| 写法 | 语义与恢复值 |
| --- | --- |
| `yield ctx.query(op, args)` | 执行一次 QueryOp，恢复为 `{ value, meta }`；失败抛出 `P2Error`。 |
| `yield ctx.act(ref, args)` | 执行一次 act，成功恢复为 output；失败抛出；取消不可被吞掉。 |
| `yield ctx.decide(ref, inputs)` | 调用一次 policy，恢复为受限 JSON；失败抛出。 |
| `yield ctx.wait(ms)` | 可取消等待，恢复值为空。 |
| `yield ctx.progress(obj)` | 上报有界进度，进入 run status，恢复值为空。 |
| `yield ctx.log(message, data?)` | 有界诊断日志，恢复值为空。 |
| `ctx.params` | 启动参数的只读快照。 |
| `ctx.runId` / `ctx.now()` | 当前 run 标识与进程内单调时间。 |
| `ctx.fresh(snapshot, maxAgeMs?)` | 校验观测快照的时效；过期或无法证明时抛出。 |
| `return ctx.succeed(evidence)` | finite 行为成功终态，记录有界证据。 |
| `return ctx.fail(code, message)` | 业务失败终态，记录业务码与原因。 |

- 唯一 I/O 通道是上述命令。运行时不执行作者提供的 Promise、回调或定时器；`import`、`require`、`process`、`eval`、`Function`、`WebAssembly`、`fetch`、文件与网络均不可用，`async`/`await` 也不被接受。
- ctx 是冻结对象，只暴露本节 API；不暴露 ControlOp、act 或 policy 的内部句柄、broker、provider、注册表、游戏连接或宿主对象。
- ctx 不提供控制 op 入口，控制只能通过 act 产物进入；behavior 可以直接使用 QueryOp 读取当前数据。
- 每个 `yield` 是调度、取消与计时边界；两次 `yield` 之间的 CPU 时间有上限，超时按 `BEHAVIOR_STEP_TIMEOUT` 失败并进入收尾。取消通过停止当前 act 并结束 generator 落实。
- 取消不能被 `try/catch` 转成成功；`finally` 只能清理局部状态，不能发游戏操作。未捕获的 `P2Error` 使 run 失败，其他未捕获异常按 `BEHAVIOR_SCRIPT_ERROR` 处理。

构建产物是只读的内容单元：

```ts
type BehaviorArtifact = {
  kind: "behavior";
  format: "js";
  definitionId: string;
  revision: string;                 // 源码版本
  sourceDigest: string;
  artifactDigest: string;
  artifactId: string;
  bindingId: string;
  manifest: BehaviorManifest;
  entry: string;                    // 模块入口，相对源根目录
  code: string;                     // 入口模块源码快照
  dependencies: DependencyClosure;  // 锁定的确切依赖闭包
};
```

产物保存模块源码、manifest 与依赖清单，不保存作者运行期闭包、局部变量或中间执行状态。`definitionId` 标识行为定义，与 manifest 的 `id` 一致。`sourceDigest` 是入口相对路径与模块源码字节的摘要；`revision` 标识源码版本，`artifactId` 才标识确切可执行产物；同一 revision 在不同依赖或 binding 下构建可得到不同 artifactId。artifactId 由 artifactDigest 形成；摘要覆盖产物类型、definitionId、源码摘要、模块字节、manifest、精确依赖清单、构建工具版本与目标 binding，排除 artifactId 自身、检查时间等元数据。

依赖闭包锁定本行为引用的 act 产物、policy 产物及其传递依赖的内容摘要，不包含无关的注册表条目。源码中的便捷名称在检查阶段按目标 binding 的启用映射解析为确切 artifactId；写入产物的引用必须携带确切 artifactId：

```ts
type ActRef = { definitionId: string; artifactId: string };
type PolicyRef = { definitionId: string; artifactId: string };
```

运行期只使用产物内的确切引用，不按 definitionId 执行 latest 查找，也不因注册表默认映射变化而替换依赖。检查时无法解析、存在歧义、缺少启用资格（act）或已退休的引用使候选被拒绝；policy 只要求已检查并锁定内容摘要。已启动的 run 使用启动时锁定的闭包继续结束。

behavior 可以直接使用 QueryOp；改变游戏状态的控制必须通过 act 产物进入。`ctx.query` 只接受 QueryOp 名称，控制 op 名称按 `OP_KIND_MISMATCH` 拒绝。behavior 不得引用 ControlOp，不得持有游戏连接、act 运行实例或 broker 句柄；policy 只能由 `ctx.decide` 调用，不能调用 act 或 op，也不能读写 behavior 状态。检查阶段验证模块导出形状、manifest、参数 schema、禁用语法、引用解析与依赖闭包；运行期 ctx 不提供绕过这些约束的通道。

### 3.1 数据归属与寿命

behavior 的状态是普通 JS 变量，不是执行器维护的槽位或局部帧。运行器只负责启动、注入命令结果、超时与取消，不解释、不持久化作者的局部状态。

| 数据 | 归属与寿命 |
| --- | --- |
| behavior 参数 | 实例启动时按 schema 校验，形成只读快照；整个 run 使用同一份值。修改参数须创建新实例。 |
| 运行内状态 | 作者在 `run` 内声明的局部变量、闭包与对象；随本次 generator 实例存在，run 结束或取消后丢弃。运行器、agent、status 与其他 behavior 均不可见，也不跨 run 恢复。 |
| 查询快照 | `yield ctx.query` 恢复的 `{ value, meta }`，由作者保存在局部变量中；它是采样时的事实，不随游戏变化自动更新。 |
| act 内部状态 | 属于本次 act 运行，由 act 自己维护；behavior 只能取得 act 成功恢复的 output，不能读取或修改其内部变量。 |
| policy 输入与输出 | 每次 `decide` 独立：输入是按值传入的只读 JSON 快照，输出是受限 JSON；policy 不保留跨调用状态，不读写 behavior 状态，不产生副作用。 |

- 局部变量可以保存任意 JS 值，但只有受限 JSON 才能跨越 ctx 边界（启动参数、query/act 参数、decide 输入与输出、progress、日志数据、evidence）。函数、Promise、循环对象、类实例与游戏对象在边界处被拒绝，不能借闭包把宿主对象带入后续命令。
- 运行期闭包不会被序列化、持久化或恢复；取消后重新启动会从模块开头重新执行，不续接旧局部状态。跨 run 保留的信息必须由外部显式保存。模块顶层的可变对象不属于运行实例状态，行为状态应放在 `run` 内。
- act、policy 与查询实现都不能直接访问 behavior 的局部变量；它们只看到调用时按值传入的输入。

### 3.2 写入与成功输出

behavior 的写入就是 JS 赋值；执行器不维护局部槽、输出槽或待产出标记，也不会把赋值转换为命令、状态发布或观测元数据。外部可观察的结果只有命令恢复值、run 终态与事件。

| 通道 | 成功 | 失败或取消 |
| --- | --- | --- |
| `yield ctx.query(op, args)` | 恢复 `{ value, meta }` | 抛出 `P2Error`；没有恢复值 |
| `yield ctx.act(ref, args)` | 恢复 act 的 output | 抛出；act 可能已产生游戏副作用 |
| `yield ctx.decide(ref, inputs)` | 恢复受限 JSON | 抛出；不进入 act 清理流程 |
| `yield ctx.wait(ms)` | 恢复值为空 | 随取消或预算耗尽结束 |
| `yield ctx.progress(obj)` / `yield ctx.log(...)` | 恢复值为空 | 不改变业务结果 |
| `return ctx.succeed(evidence)` | 终结 run 并记录成功证据 | — |
| `return ctx.fail(code, message)` | 终结 run 并记录业务失败 | — |

- **局部写入**：`mined += 1`、`state.phase = 'return'` 等赋值立即生效，只影响本 generator 的局部状态。执行器不校验赋值类型，不生成观测元数据，也不因赋值使外部缓存失效。
- **query**：`value` 是查询结果，`meta` 是该次观测的来源与时效信息，应一起保存。失败、超时或取消没有恢复值，也不能把上一轮局部变量当作本次结果。
- **act**：成功恢复为 output，失败抛出。output 只表示该 act 按契约成功完成，不自动成为当前观测；act 失败不等于游戏世界未改变，需要新的查询或执行证据确认实际状态。
- **decide**：成功恢复 policy 的返回值，失败抛出。返回值不会自动写入任何变量，作者需要显式赋值。
- **终态**：`ctx.succeed(evidence)` 与 `ctx.fail(code, message)` 是作者可产生的一对互斥终态；终态产生后 ctx 拒绝新命令。业务失败不被其他成功信号覆盖，成功终态也不追认此前的 act 结果为当前事实。
- **时效**：`meta` 不会因为被保存到局部变量、复制对象、传给 `decide` 或作为 act 参数而更新。跨 `yield` 复用旧快照前，作者必须用 `ctx.fresh(snapshot, maxAgeMs?)` 证明其仍有效；只保留 `value` 而丢弃 `meta` 会使时效无法证明。
- **恢复**：作者可以用 `try/catch` 对 act/query/decide 错误做局部恢复；重试预算、错误分类与放弃条件由作者代码决定，运行时只记录。未捕获的 `P2Error` 使 run 失败，未知异常按 `BEHAVIOR_SCRIPT_ERROR` 处理。
- **迟到结果**：每次 `yield` 只有一个待恢复点。超时、取消或已结束 run 的晚到结果不会恢复进 generator，也不会被写成新的成功输出。

### 3.3 具体到 JS 的输入/输出边界

下列边界都发生在 `yield` 或 `return` 处，按值传递；跨越边界的值必须是受限 JSON，不携带可调用对象或宿主引用。

| 边界 | 方向与形态 | 规则 |
| --- | --- | --- |
| `ctx.params` | 启动 → run | 按 `parameters` schema 校验后的只读快照；run 内修改不构成受支持的写入，也不影响其他实例。 |
| `yield ctx.query(op, args)` | run → QueryOp → run | `args` 为受限 JSON；恢复 `{ value, meta }`；QueryOp 不做隐藏重试。 |
| `yield ctx.act(ref, args)` | run → act → run | `args` 为受限 JSON；`ref` 在产物中为确切 artifactId；成功恢复 output，失败抛出。 |
| `yield ctx.decide(ref, inputs)` | run → policy → run | `inputs` 为按值传入的只读 JSON；返回值必须是受限 JSON；每次调用独立。 |
| `yield ctx.progress(obj)` | run → status | 有界小对象，进入 status 的进度字段；不是查询结果，也不能作为当前事实或完成证据。 |
| `yield ctx.log(message, data?)` | run → 日志 | 有界诊断信息；日志缺失、丢弃或不可用不改变业务结果。 |
| `return ctx.succeed(evidence)` | run → run 结果 | `evidence` 为有界 JSON；表示 behavior 声明的成功证据，不替代当前查询。 |
| `return ctx.fail(code, message)` | run → run 结果 | 业务失败码与文本；不被其他成功信号覆盖。 |

- **参数**：只从 `ctx.params` 读取启动参数。运行时在启动前完成 schema 校验，缺参或类型不符由启动校验按 schema 拒绝，不在 `run` 内静默补值。参数是只读快照，不能作为跨 run 的持久存储。
- **decide 输入**：字段按 policy manifest 的输入声明组织，按值复制；policy 修改输入不影响 behavior，policy 的输出也不会自动写回任何变量。
- **act 参数**：act 只接收已经确定的参数，不在 act 内替 behavior 选择长期目标。参数与输出都以受限 JSON 跨越边界，act 内部状态不随 output 返回。
- **进度与日志**：`progress` 应小且有界，并周期性上报；`log` 用于诊断。两者都不是控制通道，不证明动作完成，也不会自动进入证据或观测。
- **evidence**：只记录本次 run 的成功声明；必须有界、可序列化，不能代替对背包、位置等当前事实的查询。
- **时间**：`ctx.now()` 是进程内单调时间，只用于超时、预算与间隔判断；它不是观测采样时间，不能用来刷新 `meta.sampledAt`。
- **非法值**：跨边界值不合法时按对应契约失败，不把函数、Promise、循环对象或未声明字段强制转换成合法值。

### 3.4 策略状态、当前观测与执行证据

behavior 的局部变量可能同时保存三类含义不同的数据；运行时不会替作者区分，作者必须按下表使用。

| 数据含义 | 处理规则 |
| --- | --- |
| 策略状态 | 尝试次数、阶段、计划目标等实例状态；由 `run` 的局部变量或闭包保存，不因时间经过统一失效，但不能冒充当前世界事实，run 结束后不保留。 |
| 当前观测 | 背包数量、目标位置、可见对象等；来自 `yield ctx.query` 的 `{ value, meta }`，保留来源、观测年龄与世界/连接作用域，消费时按要求校验。 |
| 执行证据 | 某次动作已经确认完成了什么；来自 act 成功 output 或 `ctx.succeed(evidence)`，用于有明确含义的历史累计，不自动说明当前仍持有这些物品或目标仍处于原状态。 |

`meta` 是观测的一部分，至少包含：

| 字段 | 语义 |
| --- | --- |
| source | 产生该观测的通道或操作，例如 QueryOp 或带观测语义的 act 输出。 |
| scope | 观测适用的世界与连接作用域（worldScope、connectionEpoch 等）；作用域不符即不能当作当前事实。 |
| sampledAt | 采样时刻，使用进程内单调时间；复制、计算、保存或跨 `yield` 传递都不会改变它。 |
| validUntil | 可证明有效的截止时刻；缺失或无法计算表示时效无法证明。 |

- `ctx.fresh(snapshot, maxAgeMs?)` 检查快照的 `scope`、`sampledAt`、`validUntil` 与可选 `maxAgeMs`。已过期抛 `STALE_OBSERVATION`；缺少可证明的元数据、作用域不符或无法比较抛 `FRESHNESS_UNPROVABLE`。它不会自动重新查询，也不会修改快照。
- 当前观测经过局部变量保存、对象复制、纯计算、`decide` 输入/输出或 act 参数传递后，仍沿用输入中最保守的年龄与作用域；不能以赋值时间、计算时间或 `ctx.now()` 重置 `sampledAt`。多个输入合成时，取最旧或最早失效的时效。
- 纯计算（距离、比较、格式化、评分）只派生值，不产生新观测。若派生结果仍被当作当前事实消费，必须携带并校验原观测的 `meta`。
- 参数只读、查询值被保存为局部变量或经 policy 返回，都不免除其作为当前事实被消费时的校验。`ctx.params` 是启动输入，不是当前世界观测。
- act 的普通 output 按 act 契约解释，不自动获得观测可信度。若 output 表示当前观测，必须保留受控查询通道的来源与时效；只返回数值或自行填写时间不能证明当前事实。
- 执行证据不因时间经过自动失效，但不能替代查询。例如成功完成一次采集后将计数加一，只表示“成功完成的采集次数”；“背包拥有 32 个原木”仍须查询背包，累计交付量也须有对应动作契约与确认依据。
- 失败或取消不写成功 output，也不意味着此前的执行没有改变游戏世界；实际变化应按当前查询及已确认执行证据处理。
- 局部变量可以保存查询快照，但只是保存而非同步；它不是 P2 的世界副本，不建立全量缓存或历史观测库，需要当前事实时必须重新查询。

## 4. act 与 policy 作者接口

act 是代码，允许基于当前查询和已登记的控制结果进行局部调整；它不能调用 behavior 切换、安装包、触发 LLM 或直接打开游戏连接。

```ts
type ActModule = {
  manifest: ActManifest;
  create(args: JsonValue): ActInstance;
};
type ActInstance = {
  start(ctx: ActContext): HookResult;
  update(ctx: ActContext, input: ActInputs): HookResult;
  stop(ctx: CleanupContext, reason: StopReason): HookResult;
  cleanup?(ctx: CleanupContext, input: ActInputs): HookResult;
};
type HookResult =
  | { kind: "running"; progress?: JsonValue }
  | { kind: "complete"; result: JsonValue }
  | { kind: "failed"; error: P2Error };

type ActManifest = {
  id: string;
  description?: string;
  queryOps: string[];        // 必须逐项列出，裸名字
  controlOps: string[];      // 必须逐项列出；stop 隐式授予，可不列
  limits?: { totalMs?: number; hookMs?: number };
};
```

act 声明规则：

- `queryOps`／`controlOps` 强制声明，**默认拒绝**：运行期提交未声明的 op 立即失败（`OP_NOT_DECLARED`）；把控制 op 写进 `queryOps`（或相反）在检查阶段返回 `OP_KIND_MISMATCH`。
- `stop` 是撤回原语，隐式授予；它只能撤销已登记效果，不能发起新动作。
- 声明列表进入产物摘要：修改声明即产生新 artifactId，不会静默扩大已启用产物的能力。
- 检查阶段用目标 binding 的静态 op 声明校验每个名字；连接后再核验实际能力，缺失返回 `CAPABILITY_MISSING`。
- 首版 act 源为**单文件、无 `import`／`require`／`eval`／`Function`／`WebAssembly`**，由注入的 `defineAct` 装配；运行时不从工作区或 `node_modules` 加载任何模块。

hook 的一次执行必须有界并返回；异步 op 使用 handle 发起，后续 update 从输入读取结果，不让一个 await 挂住生命周期。正常结束、失败或取消都调用一次stop发起收尾，reason分别携带completed、failed或cancelled及原始结果。stop返回running时后续仅调用cleanup，不再调用具有普通控制权限的update；未提供cleanup时作者stop必须同步结束自身工作，其余持续op仍由broker收敛。反复停止请求不重复调用stop，所有hook仍受同一个收尾期限约束。

cleanup返回complete只确认作者侧清理完成，不替代broker确认；cleanup返回failed或超时导致控制故障。业务预期结果与清理结果分开保存，不能用一次成功清理把业务失败改成成功。

start/update 的 complete.result 是业务候选结果，由执行器校验为受限 JSON，并按[成功输出规则](#32-写入与成功输出)在成功收尾后写入 act 输出；首版不做完整结果 schema 校验，声明仅用于诊断，后续补全。stop/cleanup 的 complete 只表示作者侧收尾完成，其 result 不替换业务结果。running.progress 用于进度诊断，不隐式写入 behavior locals；act 内部变量也不能绕过输出绑定写回。

ActContext 暴露当前 run 信息、受限时钟/随机源、query.submit/result、control.submit/result、progress；不提供 Node 全局、任意导入、文件、网络或 DSH 对象。manifest 声明 op、业务超时与能力说明；参数/结果 schema 在后续版本补全，首版仅作诊断性声明。仅声明不保证逻辑正确。

CleanupContext 只暴露本 act 已登记操作的状态、stop/release 和必要只读查询。broker 也执行已登记的标准清理；作者 stop 成功后仍须等待 broker 确认。若作者无响应，broker 继续执行可信清理。runner 内部状态是临时的，崩溃不做代码栈恢复。

### 4.1 policy 作者接口

policy 是 behavior 的附属纯决策单元，不是第四级控制层：它不持有控制权、不提交 op、不进入 act 的生命周期。

```ts
type PolicyModule = {
  manifest: PolicyManifest;
  run(inputs: JsonValue): JsonValue;
};
type PolicyManifest = {
  id: string;
  description?: string;
  inputs: string[];          // 声明的输入字段名
  outputs: string[];         // 返回值中承诺提供的字段名（可为空，表示单值）
  limits?: { callMs?: number };
};
```

约定：

| 项 | 规则 |
| --- | --- |
| 能力 | 无。不提供 op 桥、文件、网络、宿主对象；只注入数学与纯辅助函数。 |
| 调用方式 | 只能由 `ctx.decide` 调用：一次提交、异步等待，结果按值返回给 behavior；不能作为其他命令的参数，也不能跨调用缓存。 |
| 生命周期 | 一次调用一次返回，无 start/update/stop/cleanup，不保存跨调用状态；等待期间不阻塞 tick，取消可立即推进。 |
| 失败语义 | 抛错、超时或返回值不合法使本次 `ctx.decide` 失败；不进入 act 清理流程，也不记为控制故障。 |
| 结果校验 | 只接受受限 JSON；函数、Promise、循环对象、超限尺寸一律拒绝（`POLICY_RESULT_INVALID`）。 |
| 复用 | 作为内容产物锁定 digest，可被多个 behavior 引用并进入依赖闭包；不单独 enable。 |
| 禁止 | 不能调用 policy／act／op，不能读写 behavior 的运行内状态，不能修改 query 结果或观测元数据。 |

policy 的引入不改变「执行器只负责调度与执行 ctx 命令」这一约束：执行器仍是唯一调度者，policy 只是取值来源之一。运行期预算、失败分类与调用时机见[运行时 §3](RUNTIME.md#3-每轮调度与资源上限)。

## 5. operation provider 契约

每个 provider 暴露描述、连接、查询、控制提交、结果读取、停止/对账、关闭等能力；具体方法名可调整，但职责不能省略。连接/断连是管理面，不伪装成 agent 自由调用的游戏 op。

每个 op 描述最终应含：标识、契约版本、query/control 类型、参数/结果 schema、允许的世界作用域、部分结果政策、成功语义、失败码、持续效果、停止方式、幂等性与可重试错误范围。

首版实现最小集（C 档）：**标识、类别（query/control）、持续效果、停止方式、能力标记**；参数/结果 schema、部分结果政策、幂等性与可重试范围在后续补齐。最小集已足以支撑三件事：检查期校验 act 声明的 op 是否存在且类别正确、启用前判定能力是否满足、运行期拒绝未声明调用。

op 声明以静态文件随 provider 包发布，检查阶段只读它、不加载 provider、不连接游戏；连接握手时核验实际实现与静态声明一致，不一致返回 `CAPABILITY_MISMATCH`。声明摘要进入 bindingId，实现升级产生新 binding。

> 现状：op 声明的**能力标记**已进入 `src/operation/index.ts` 并由 `DeclaredOpBroker` 在运行期校验（缺失返回 `CAPABILITY_MISSING`）；provider 通过 `PROVIDER_CAPABILITIES` 声明实际实现，`describe`/`hello`/`status` 会回报。但 `bindingId` 仍由 body manifest 计算，**尚未纳入 provider 能力摘要**——这是已知缺口。

```ts
type QueryReply<T> =
  | { kind: "ok"; value: T; observation: ObservationMeta }
  | { kind: "error"; error: P2Error };

type ControlStatus<T> =
  | { kind: "pending"; operationId: string }
  | { kind: "completed"; result: T; effects: "none" | "active" }
  | { kind: "failed"; error: P2Error; effects: "none" | "active" }
  | { kind: "unknown"; reason: string };
```

completed 可表示输入成功设置，但 active 表示控制效果仍需释放；不能据此让 act 终态。失败也可能留下已发生或持续效果。unknown 是控制操作结果不确定，不是普通业务失败。stop 确认必须涵盖该请求及其子操作，不只是“已收到停止请求”。

### 5.1 控制释放与 provider 职责边界

provider 只负责“每个控制操作能否停止、控制效果是否已释放”，不承担 behavior run 的生命周期；run 的归属、撤权与接管规则属于核心运行时，provider 不需要认识 runId。

```ts
type ControlRelease =
  | { kind: "stopping" }
  | { kind: "released" }
  | { kind: "unconfirmed"; reason: "no-ack" | "unobservable" | "disconnected" };

type ProviderControlState = {
  state: "idle" | "active" | "unknown";
  activeOps?: string[];
};
```

- `stop()` 返回只是“请求已收到”，不是释放证明；释放结论由 `controlState()` 给出（或等价接口）。
- `released` 必须同时满足：该 run 已登记的控制句柄都不再 running，且 `controlState() === 'idle'`，并经过一个短暂 settle 窗口（初值 200–500ms）。
- `unknown` 持续到总期限仍未转成 `idle` → `unconfirmed`；核心报 `stop-unconfirmed` 并禁止新 run 接管，保留账目等待迟到确认。
- 核心只消费这个粗粒度结论，不推断 provider 内部实现（不区分物理 tick、在途包等细节）。

游戏底层可能需要协议缓存或游戏自有状态；它们属于 provider 实现，P2 不另行复制维护一份世界模型。跨版本 entity/block 引用使用带 worldScope、connectionEpoch 的不透明值。

## 6. 统一错误与处理归属

```ts
type P2Error = {
  code: string;
  category: "validation" | "capability" | "environment" | "timeout"
    | "transport" | "runtime" | "control";
  message: string;
  source: { module: string; nodePath?: string; opId?: string };
  retry: "never" | "explicit-policy" | "cleanup-once";
  details?: JsonValue;
};
```

错误文本供人阅读，code 和结构字段供恢复策略使用；不要让模型通过字符串猜测。operation 错误映射由库实现，不能透传异常堆栈为游戏对象。

| 类别／示例 | 默认处理 |
| --- | --- |
| SCHEMA_INVALID、UNKNOWN_ACT、BINDING_MISMATCH | 检查/启用阶段拒绝；候选不能打断当前运行。 |
| UNKNOWN_OP、OP_KIND_MISMATCH、OP_NOT_DECLARED、CAPABILITY_MISSING、CAPABILITY_MISMATCH | 检查/启用阶段拒绝候选；运行期未声明调用使该 act 失败（失败关闭），不转移控制权。 |
| FORBIDDEN_SYNTAX、INVALID_ACT_MANIFEST、POLICY_RESULT_INVALID、SOURCE_CHANGED | 检查阶段拒绝；不生成凭据，不影响已启用产物与当前运行。 |
| ACT_TIMEOUT、POLICY_TIMEOUT、BUDGET_EXCEEDED | 结束相关运行并完成收尾；属于执行预算耗尽，不按普通环境失败处理。 |
| QUERY_TIMEOUT、QUERY_INCOMPLETE、STALE_OBSERVATION | 查询命令失败；不自动重试。 |
| PATH_UNREACHABLE、MATERIAL_MISSING 等游戏错误 | act 解释，默认失败传播或显式恢复；若同时已有有效目标达成证据，按运行时结束裁决准备成功，不改写 act 的失败事实。 |
| GOAL_NOT_MET、NO_BRANCH、RECOVERY_EXHAUSTED | 业务失败，结构化上报。 |
| CONFIRMATION_REQUIRED、EXTERNAL_INPUT_REQUIRED | 先清理，再 blocked，等待明确外部决定。 |
| EXTERNAL_GOAL_REJECTED | 有效外部否定结束原待验收 run，记录 failed 及原因；不同于非法确认命令被拒绝。 |
| ACT_RUNTIME_ERROR、EXPRESSION_ERROR | 结束相关运行并收尾；记录位置和revision。 |
| STOP_TIMEOUT、CONTROL_OUTCOME_UNKNOWN、STALE_CONTROLLER | 保留控制账本/故障，禁止新动作接管。 |

error.retry 是允许范围，不自动触发 retry。调用者不得把 never 升格为 cleanup-once；QueryOp 始终零自动重试。

同轮的取消、程序/契约错误、目标达成与普通环境失败按 [RUNTIME §4.2](RUNTIME.md#42-完成判定)裁决；category 不单独决定优先级。控制故障阻止终态提交并保留业务结束意图，不能被目标成功覆盖；无效候选仍只拒绝候选，不打断当前运行。

## 7. body 公共控制面

| 操作 | 返回及行为 |
| --- | --- |
| describe | 协议、body、绑定版本和能力，不执行游戏。 |
| hello / heartbeat / shutdown | 首版专用管道上的 owner 绑定、存活与退出管理；不是模型工具。attach/renew/detach 保留在后续 WS 方案。 |
| observe | 一次 QueryOp 或有限查询组；返回结构化事实及可选纯摘要。 |
| status | 当前运行、控制权/健康、阶段与当前 act、等待原因、最近失败、待确认记录、pending命令及最近结果。 |
| check | 检测候选（behavior／act／policy），返回报告/artifact，不启用、不试运行。 |
| activate | 指定 artifactId，复核凭据与依赖后在其目标 binding 下启用；不加载 provider、不立即启动。 |
| switch | 指定 artifactId、params 和 commandId；核验当前环境、依赖及实际能力后接受串行切换，不能用 revision/latest 隐式选择产物。 |
| stop | 请求停止并返回 commandId；响应不是停止完成证明。 |
| confirm | 对指定 bodyEpoch、runId、confirmationId 提交确认或否定及依据；来源由可信 bridge 通道确定。 |
| command.get / events.subscribe | 查询当前 epoch 的内存命令结果和有界事件；首版不实现持久接收 ack。 |

具体工具是否合并由 bridge 调整，身体协议保持清晰。编写代码通过工作区普通文件能力，不增加直接执行任意JS的 p2 工具。operation 安装/升级不暴露给游戏运行中的 agent。

### 7.1 外部完成验收契约

externalConfirmation 是有限 behavior 在 run 成功且 act/broker 收尾完成后的一次外部验收，不是执行错误的豁免入口或通用恢复命令。body 每个 run 最多创建一条待确认记录；状态转换、竞争及失效规则见 [RUNTIME §4.4](RUNTIME.md#44-外部完成验收)。

| 数据 | 必需语义 |
| --- | --- |
| bodyEpoch、runId、confirmationId | 分别标识 body 实例、执行实例和待确认请求。confirmationId 由 body 生成；不能隐式指向“当前任务”。 |
| owner 归属 | 绑定该 run 的 owner session；命令须通过当前有效授权校验，客户端自报 session 名称不构成授权。 |
| 固定目标说明与运行参数引用 | 对应本次运行的定义/版本和参数，明确验收对象；提交决定不能顺带修改目标。 |
| 执行结果摘要 | 说明本次执行做过什么、哪些结论仍待外部判断；不伪造游戏验证证据。 |
| 提交决定 | 携带目标三元标识、commandId、确认或否定，以及简短判断依据；否定说明未满足目标的原因。无法判断时不提交决定。 |
| 来源与处理结果 | 记录 agent 判断或玩家确认、可信通道确定的身份关联、首次有效决定及依据、对应命令和运行结果；重复请求不覆盖首次记录。 |

commandId 标识一次命令，confirmationId 标识被处理的验收请求；不同命令可能针对同一个请求。重复同一决定返回已有处理结果，相反决定冲突；同 commandId 不同载荷仍按协议拒绝。标识/身份/载荷错误只拒绝命令，不能被解释成 EXTERNAL_GOAL_REJECTED。请求关闭后不能重开或转移到新运行。

来源由 bridge 根据实际调用通道填写，body 校验桥连接授权、owner 和请求归属。模型工具调用始终记录为 agent 判断；模型传入的 source 字段、行为源码或游戏文本不能自行声明玩家身份。只有可核验的人类交互入口才能记录玩家确认；第一版没有这种入口时，仅支持 agent 判断。外部判断可以引用查询或执行证据，但完成依据仍记录为 externalConfirmation，不冒充 predicate 的游戏自动验证。

确认不执行游戏操作或恢复执行。有效确认使原 run succeeded；有效否定使原 run failed/EXTERNAL_GOAL_REJECTED；需要继续工作时新建 run。对 pending 请求的查询、受理和重复返回不代表业务终态，必须区分 accepted 与已提交的决定。D3 在此固定语义和信息要求，首版消息和方法见[协议 §8](#8-bridgebody-消息协议)，可信来源接入见 [DSH 设计](DSH-INTEGRATION.md#5-模型工具与界面反馈)；D6 首版仅提供调试日志和内存队列，可靠提交与崩溃恢复延期。

## 8. bridge—body 消息协议

首版采用 bridge 人工启动并持有的 body 子进程，通过专用 stdin/stdout 传输 JSON 请求、响应和事件。协议处理与传输解耦，不监听端口、不要求配对令牌或多连接竞争。WebSocket、独立 launcher、鉴权与 lease 重连设计保留在[后续 WS 方案](WS-FUTURE.md)，不属于首版验收门槛。

### 8.1 消息与传输边界

协议层管理方法、请求关联、命令去重、owner 归属和运行标识；传输层只收发消息并报告关闭/错误，不解释 behavior、artifact 或控制权。body 分发器通过消息接口工作，不直接依赖 stdin/stdout、WebSocket 或 DSH 对象。bridge 的进程生命周期模块负责创建和关闭子进程，不把 spawn/kill 放进通用传输接口。

首版只实现 stdio 适配器和开发测试用内存传输。stdio 使用 UTF-8 JSON Lines，每行一条完整 JSON 消息；stdin 接收请求，stdout 只输出响应和事件，日志走 stderr。bridge 持续消费 stdout/stderr，依赖库和 runner 日志不得污染协议 stdout。分帧器处理拆包、合包、截断、非法 JSON 和超限输入；普通消息沿用 1MiB 上限，未完成帧和输出队列有界，容量与背压按 [D6 队列规则](FEEDBACK-AND-RECOVERY.md#33-有界队列与停止优先)执行。低价值进度可合并，输出等待不能阻塞控制收尾。

bootstrap hello 不要求预先知道 epoch，其余请求均匹配当前 bodyEpoch。设计级信封如下，辅助类型按方法定义：

```ts
type HelloRequest = {
  requestId: string; method: "hello";
  params: { protocols: number[]; owner: OwnerContext };
};
type Request = {
  protocol: 1; requestId: string; method: string;
  bodyEpoch: string; commandId?: string; params: JsonValue;
};
type Response = {
  protocol: 1; requestId: string; bodyEpoch: string;
  result?: JsonValue;
  error?: P2Error; // 与 result 恰有其一
};
type Event = {
  protocol: 1; bodyEpoch: string; seq: number;
  eventId: string; kind: string; runId?: string;
  commandId?: string; data: JsonValue;
};
```

hello 在专用父子管道上协商协议，绑定 bridge 从实际 DSH 上下文取得的 session/agent/项目，返回 bodyEpoch、角色身份、当前 bindingId 和服务能力。该进程生命周期内 owner 固定，模型不能填写或更换 OwnerContext；重复 hello 不变更 owner、不恢复旧运行。hello 完成前不接受普通请求，旧 epoch 请求拒绝。专用管道是首版来源边界，不声称足以用于网络部署；WS 需要单独鉴权。

### 8.2 首版方法与命令结果

| 方法 | 核心输入 | 返回及限制 |
| --- | --- | --- |
| hello | 协议集合、可信 OwnerContext | 协议、epoch、角色、binding、能力；不启动 behavior。 |
| heartbeat | 递增 heartbeatSeq | 存活应答；同序号重发不重复延长存活期限。 |
| describe | 可选目标 bindingId | 本地静态声明及限制，不加载 provider。 |
| status | 无业务参数 | owner、health、connection、activeRun、阶段（progress 或 currentStep）、当前 act、当前步骤与目标坐标（activeNode/activeTarget，act 求值后的参数）、等待原因（query/policy/act/confirmation）、最近失败、pending switch、待确认记录、最近命令及对应快照的事件游标；另列 loggingUnavailable、droppedLogCount，不改变控制健康状态。 |
| observe | 查询声明、参数、时效要求 | 值及来源/年龄/作用域，或错误；零隐藏重试。 |
| check | commandId、源路径、artifactKind、预期 sourceDigest、目标 binding、精确依赖 | 报告及通过时的 artifactId；源摘要不符返回 SOURCE_CHANGED；重复命令不重复构建。 |
| activate | commandId、artifactId | 目标 binding 下的启用结果。 |
| switch | commandId、artifactId、params | 受理及最终 started/rejected/superseded；不等于 behavior 成功。 |
| stop | commandId、runId | 仅停止该 behavior；当前 run 的有效 stop 清空 pending switch，旧终态返回 alreadyTerminal 且不影响新 run；body 保留。 |
| confirm | commandId、runId、confirmationId、决定、依据 | D3 的结果或拒绝；真实来源由 bridge 注入。 |
| shutdown | commandId | 人工管理/插件释放通道：拒绝新业务、停止并确认收尾、关闭游戏连接及辅助进程后退出；不暴露为模型工具。 |
| command.get | commandId | 命令阶段及结果；无记录返回未知，不推断从未执行。 |
| events.subscribe | bodyEpoch 与游标 | 当前进程有界内存事件及 EVENT_GAP；首版不实现 events.ack 或跨崩溃投递。 |

requestId 对应一次往返，commandId 对应一次业务操作。check、activate、switch、stop、confirm、shutdown 使用可查询记录，区分 accepted、pending、completed、rejected、superseded；completed 附方法结果。停止清理故障时仍 pending 并附 faulted，不能把退出或 accepted 当作停止成功。shutdown 正常完成须先交付最终结果再关闭输出；响应丢失时不得仅凭退出码断言游戏收尾成功。

同 commandId 同业务内容返回当前 epoch 的内存结果，不同内容拒绝；比较方法、目标与参数，不含 requestId。先校验 epoch 和可信来源，再登记进行中的命令，防止并发重复执行。accepted 和终态响应均不等待日志落盘，不承诺重启后可查。日志轮换不影响内存去重；内存额度满时拒绝新普通业务并保留停止能力，不能静默忘记 ID 后重执行。等待超时先用 command.get 查询，未知不等于从未执行；人工重启使用新 epoch，不恢复或重放旧请求。

### 8.3 存活、关闭与事件

heartbeat 由 bridge 独立于模型回合维护，body 用单调时钟检查。管道打开但 bridge 超过存活期限时，也撤销授权并进入清理退出；不提供跨连接续租、owner 转移或令牌恢复。stdin EOF、输出管道失效和不可恢复协议错误触发关闭，不等待可重连的 bridge。异常退出/强制结束由仍存活的一方尽力显示 interrupted/结果未知，日志也可能丢失；不承诺跨崩溃恢复这些记录，不能伪造清理证明。

事件按 bodyEpoch+seq 排序，按 eventId 在内存去重；status 快照与游标对应，仍在缓冲范围内时可订阅后续事件。缓冲淘汰产生 EVENT_GAP，重新查询当前 status，不补造历史。首版没有持久 pending 队列和 events.ack，也不承诺模型一定读到或跨崩溃至少一次投递。stdio 关闭后不恢复旧连接；新 body 不复活旧 run、通知或确认请求。可靠接收确认及 WS 重连为后续能力。

## 9. 设计级交互示例

```text
agent 写候选 behavior／act／policy 文件
  → check(artifactKind, sourceDigest, bindingId, exactDependencies)
  ← report + artifactId
  → activate(artifactId)            // 仅 behavior 与 act；policy 作为依赖随 behavior 检查
  ← enabledArtifactId + targetBindingId
  → switch(artifactId, params, commandId)
  ← accepted（当前行为可能仍在停止）
  ← event: oldRun.cancelled
  ← event: newRun.started
  ← event: newRun.blocked / failed / succeeded
```

依靠 `call` 组合时，被引用的 behavior 先通过检查；依靠 act 或 policy 时，依赖产物必须已在同一目标 binding 下通过检查，act 还需已启用。

accepted、activated和started是不同事实。模型会话不能因为工具返回 accepted 就向玩家宣布任务已完成。

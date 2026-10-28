# P2 数据与模块接口契约

> 本文规定 P2 的模块职责、数据结构、调用语义和消息协议。接口属于设计草案，省略辅助类型的 TypeScript 片段不能直接作为完整 SDK；Minecraft 专属数据模型另行确定。
>
> 关联：[主架构](ARCHITECTURE.md)、[执行语义](RUNTIME.md)、[DSH 接入](DSH-INTEGRATION.md)。

## 1. 模块与依赖方向

| 模块 | 对外提供 | 不负责 |
| --- | --- | --- |
| contracts | behavior IR、消息、错误、版本及运行状态类型/运行时解析器 | 加载 DSH 或游戏 |
| op-contracts | QueryOp／ControlOp 的声明：名称、类别、参数/结果契约、持续效果、停止语义与能力标记 | 某版 MC 实现 |
| builder-sdk | 带类型的构建函数，输出可序列化 behavior IR | 游戏 I/O、执行树 |
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

## 3. behavior 定义与构建产物

定义是作者源码；执行产物是数据图。构建期间可用宿主语言循环、函数和计算展开节点，运行期间不保存作者任意闭包。

```ts
type BehaviorDefinition = {
  id: string;
  description: string;
  mode: "finite" | "continuous";
  parameters: Schema;
  locals: Record<string, { schema: Schema; initial?: JsonValue }>;
  root: Node;
  completion?: CompletionRule; // finite 必须；continuous 禁止成功完成声明
  progress?: Record<string, ValueExpr>;
};

type Node =
  | { kind: "sequence"; id: string; children: Node[] }
  | { kind: "if"; id: string; when: Condition; then: Node; else?: Node }
  | { kind: "reactivePriority"; id: string; branches: GuardedBranch[] }
  | { kind: "repeat"; id: string; child: Node; count?: number }
  | { kind: "assign"; id: string; target: LocalRef; value: ValueExpr }
  | { kind: "query"; id: string; op: OpRef; args: ValueExpr;
      output: LocalRef; freshness: FreshnessPolicy }
  | { kind: "act"; id: string; act: ActRef; args: ValueExpr;
      output?: LocalRef }
  | { kind: "decide"; id: string; policy: PolicyRef;
      inputs: Record<string, ValueExpr>; output: LocalRef;
      timeoutMs?: number }
  | { kind: "fail"; id: string; code: string; message: string;
      category?: P2ErrorCategory }
  | { kind: "wait"; id: string; durationMs: number }
  | { kind: "recover"; id: string; child: Node; rules: RecoveryRule[] };
```

subtree 是 builder 复用形式，构建后展开成独立节点路径，并保留局部帧声明及输入/输出映射；展开不消除数据作用域。`decide` 每次运行只提交一次 policy 请求，结果写入声明的 local；它不占控制权，也不进入 act 生命周期。`fail` 以给定业务码结束节点，`recover` 可按码捕获。禁止递归引用环、重复节点 id、共享可变节点对象。runtime repeat 是有限图中的循环节点，不等于图结构含引用环。节点数初值上限 10000、深度 64，超限返回构建错误，不执行游戏。

`forEach`、`call` 以及表达式内的集合算子不属于 v1 契约，作为候选记录在 [IR §9](IR.md#9-推迟的候选能力不属于-v1)；启用前需由验证结论支撑，不能因“可能有用”预先加入。

v1 的 ValueExpr 只允许：`literal`、`param`、`local`、`member`、`record`、`array`、`not`、`length`，以及 `binary` 的比较、四则与逻辑运算（`eq/neq/lt/lte/gt/gte/and/or/add/sub/mul/div`）。动态游戏读取必须声明为 query/Condition 的 QueryOp 依赖，不能藏在表达式里。除数为零、空引用或类型不符返回 `EXPRESSION_ERROR`，不转换成 false。

集合筛选、排序、评分、距离与资源分配交给 policy（经 `decide` 调用一次），不翻译成新的表达式节点。`select`、`aggregate`、`length`、`unary` 数学与 policy 表达式都属于推迟的候选能力，见 [IR §9](IR.md#9-推迟的候选能力不属于-v1)。

Condition 由查询声明和布尔表达式组成，运行时求值为 true、false、pending 或 error。query 输出提交到对应局部帧；guard 查询只放入当前 evaluation 帧。未写入 local 的读取可被类型/构建约束发现；无法静态排除的情况运行时返回 UNINITIALIZED_VALUE。

查询结果槽同时保存值与观测元数据，不能只复制value后把旧事实变成新鲜数据。纯表达式派生的当前事实沿用输入中最保守的年龄；需要当前事实的条件/act入参在消费时校验其声明的新鲜度。累计进展等历史执行证据另有明确含义，不被当作当前世界查询结果。body只约束这些数据通道，不声称静态证明自定义act内部所有判断都正确。

CompletionRule 为 predicate 或 externalConfirmation。predicate 必须声明 QueryOp 依赖、检查周期和布尔表达式；externalConfirmation 描述外部可核实的目标，不直接注入游戏控制。条件和进度表达式不能产生副作用。

构建产物包含 irVersion、definitionId、revision、sourceDigest、artifactDigest、节点到源位置映射、参数 schema、局部帧声明与子树输入/输出映射、依赖闭包及 bindingId。保留这些信息才能定位错误；源位置映射不改变运行逻辑。

D4 将环境 binding 与产物依赖分开。ActRef 至少携带用于定位的 definitionId 和确切 artifactId，并与产物依赖清单一致；revision 可用于源码诊断，不能单独选择运行内容。依赖清单锁定所用 act 产物、policy 产物、纯辅助库与构建依赖的内容摘要及传递闭包，不包含无关注册表条目。源码中的便捷名称必须在构建前解析并锁定，IR 内不保留运行时 latest 查找。

分层约束在 IR 上也要能检查：behavior 可以出现 `query` 节点、QueryOp 条件与表达式，但**不得直接引用 ControlOp**；控制只能通过 `act` 节点引用 act 产物进入。`ActRef` 与 `PolicyRef` 都是确切产物引用。源码可只写 definitionId，检查阶段按启用映射解析；写入产物的 IR 必须包含确切 artifactId，不允许写成裸名字。

artifactId 由 artifactDigest 形成；产物摘要覆盖源码、依赖、构建工具、产物内容及目标 binding，排除自己的摘要字段与运行/检查元数据。完整输入、规范化和排除规则见[身份与摘要规则](OPERATIONS-AND-RELEASE.md#32-身份与摘要规则)。checker 凭据独立关联该产物与环境；启用及启动以 artifactId 为对象，不以源码 revision 代替。

### 3.1 数据归属与寿命

| 数据 | 写入方与寿命 |
| --- | --- |
| behavior 参数 | 实例启动时求值并校验，实例内只读；修改参数创建新实例。 |
| behavior locals | 执行器维护，每个实例独有；按声明初始化，跨 repeat 轮次和树内分支切换保留，显式写入或输出槽更新除外。新实例重新初始化。 |
| 子树参数与 locals | 每次进入子树创建独立局部帧；输入在进入时求值并成为只读参数，locals 按声明初始化。等待及推进期间保留，结束后不供下一次调用复用。 |
| act 内部状态 | 属于本次 act 运行，由 act 自己维护；对 behavior 只提供声明的结果，不直接持有或修改 behavior 的 LocalRef。 |
| policy 输入与返回值 | 每次调用独立：输入是按值传入的只读 JSON 快照，返回的决策值由 `decide` 写入声明的 local；不保留跨调用状态，不写 locals，不产生副作用。 |

LocalRef 标识所属局部帧和槽位。普通 assign、query/act 输出绑定只能写入当前帧声明的可写 local，不能写参数或越过子树作用域修改调用者状态；子树结果由执行器按显式映射写回。值按受限 JSON 的值语义传递，不暴露跨帧共享的可变对象。

未声明初值的 local 初始为未就绪，不隐式填入 0、空集合或 null。合法的 null 与未就绪不同；读取未就绪值返回 UNINITIALIZED_VALUE，或在类型/构建检查能够确定时提前拒绝。普通策略计数可显式初始化为 0。

### 3.2 显式赋值与成功输出

除初始化外，业务值的写入只有三种入口：assign、query/act 的声明输出、子树的声明输出。写入由执行器落实，表达式和 act 不能直接修改局部帧。

- **assign**：完整求值并校验目标 schema 后才替换目标值；求值或校验失败时保留原值，不产生部分更新，不调用游戏或占用动作控制权。
- **输出槽准备**：每次 query、act 或子树调用进入时，先固定所需输入，再将本次绑定的输出槽标记为待产出。上一轮值不能冒充本次结果；需要保留旧结果时，作者必须事先显式保存，且不能丢弃其观测元数据。
- **query 输出**：仅在结果通过请求归属、schema、完整性政策与新鲜度校验后写入。合法空结果仍可写入；失败、超时或取消不发布成功输出。
- **act 输出**：output 可省略。业务 complete 先形成候选结果，只有业务成功、结果合法且 act 与 broker 收尾均已确认，才发布成功输出。清理失败或取消不发布该候选结果；诊断可以保留已发生的事实，但不伪装为成功输出。
- **子树输出**：成功结束后求值并校验声明的返回结果，再由执行器写入调用者绑定的输出槽；失败或取消不发布成功输出。
- **运行归属**：结果关联生产者的运行标识和目标局部帧。同一次运行的结果只接受一次；重复或迟到响应不重复写入、不再次推进后续累计节点，也不能写入已结束或重建的帧。

输出失败后不会恢复上一轮值作为本次结果，后续使用须经显式恢复流程取得新结果。节点运行的写入状态与普通 local 的业务含义分开；新一轮 repeat/recover 创建新运行标识，可以合法再次执行 assign。

合格写入按执行器顺序立即生效，同一 tick 的后续节点读取新值；轮末只汇总发布状态与事件。单次赋值原子替换，整个 tick 不提供回滚事务。槽位写入及就绪状态变化更新其版本，使依赖旧版本的条件判定失效；新 act 启动和终态提交经过[统一检查点](RUNTIME.md#31-新动作与终态的统一检查点)。这不提前发布待产出的输出，也不免除观测时效校验。

### 3.3 子树输入与输出

builder 的子树定义声明输入 schema、内部 locals、根节点，以及可选的结果 schema 和返回表达式；调用点声明输入表达式及可选输出绑定。无返回值的子树仅传播节点结果。构建展开后保留这些帧与映射信息，不增加独立的行为调度者。

进入时捕获输入并初始化本次局部帧，成功结束时计算返回值。两个调用点及同一调用点的不同次运行都不共享可变 locals。取消后重新进入或重试子树会创建新帧；需要跨次累计的值放在外层 behavior locals，通过显式输入与成功输出传递，不能依赖被取消子树的内部状态继续存在。

子树输出绑定与 query/act 使用相同的未就绪、类型校验、来源和成功发布规则；返回表达式仍是受限纯表达式，不执行游戏动作。

### 3.4 策略状态、当前观测与执行证据

locals 是 behavior 执行实例用于记住和传递值的局部存储，不是持续同步的游戏世界副本。第一版沿用允许将查询快照保存为 local 的方案；这一选择保留后续评估空间，不能理解为已经消除了对快照存储方式的设计疑虑。快照不会自动随游戏变化更新，也不由此建立全量世界缓存或历史观测库。

| 数据含义 | 处理规则 |
| --- | --- |
| 策略状态 | 尝试次数、阶段、计划目标等实例状态；不因时间经过统一失效，但不能冒充当前世界事实。 |
| 当前观测 | 背包数量、目标位置、可见对象等；保留来源、观测年龄与世界/连接作用域，消费时按要求校验。 |
| 执行证据 | 某次动作已经确认完成了什么；用于明确含义的历史累计，不自动说明当前仍持有这些物品或目标仍处于原状态。 |

当前观测经过选择、计算、assign 或子树传递时，仍沿用输入中最保守的年龄和适用作用域，不能以赋值、返回或复制时间重置观测时间。参数只读或数据被保存为 local，也不免除其作为当前事实被消费时的校验。

act 的普通结果按其声明契约解释，不自动获得当前观测的可信含义。若结果表示当前观测，必须保留受控查询通道的来源和时效信息；单纯返回一个数值或自行填写时间不能证明当前事实。body 管理这些数据通道，不声称静态证明自定义 act 内部判断正确。

例如，成功完成一次采集 act 后将计数加一，只表示“成功完成的采集次数”。“背包拥有 32 个原木”仍须查询背包；累计实际交付量也须有对应动作契约和确认依据。失败或取消不写成功输出，不意味着此前没有改变游戏世界；实际变化应按当前查询及已确认执行证据处理。

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

start/update 的 complete.result 是业务候选结果，由执行器校验为受限 JSON，并按[成功输出规则](#32-显式赋值与成功输出)在成功收尾后写入节点绑定的 output；首版不做完整结果 schema 校验，声明仅用于诊断，后续补全。stop/cleanup 的 complete 只表示作者侧收尾完成，其 result 不替换业务结果。running.progress 用于进度诊断，不隐式写入 behavior locals；act 内部变量也不能绕过输出绑定写回。

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
| 调用方式 | 只能由 `decide` 节点调用：一次提交、异步等待、结果写入 local；不能出现在 guard、assign、act 参数等表达式位置。 |
| 生命周期 | 一次调用一次返回，无 start/update/stop/cleanup，不保存跨调用状态；等待期间不阻塞 tick，取消可立即推进。 |
| 失败语义 | 抛错、超时或返回值不合法使 `decide` 节点失败；不进入 act 清理流程，也不记为控制故障。 |
| 结果校验 | 只接受受限 JSON；函数、Promise、循环对象、超限尺寸一律拒绝（`POLICY_RESULT_INVALID`）。 |
| 复用 | 作为内容产物锁定 digest，可被多个 behavior 引用并进入依赖闭包；不单独 enable。 |
| 禁止 | 不能调用 policy／act／op，不能读写 locals，不能修改 query 结果或观测元数据。 |

policy 的引入不改变「执行器只运行内建控制结构与受限表达式」这一约束：执行器仍是唯一调度者，policy 只是取值来源之一。运行期预算、失败分类与调用时机见[运行时 §3](RUNTIME.md#3-每轮调度与资源上限)。

## 5. operation provider 契约

每个 provider 暴露描述、连接、查询、控制提交、结果读取、停止/对账、关闭等能力；具体方法名可调整，但职责不能省略。连接/断连是管理面，不伪装成 agent 自由调用的游戏 op。

每个 op 描述最终应含：标识、契约版本、query/control 类型、参数/结果 schema、允许的世界作用域、部分结果政策、成功语义、失败码、持续效果、停止方式、幂等性与可重试错误范围。

首版实现最小集（C 档）：**标识、类别（query/control）、持续效果、停止方式、能力标记**；参数/结果 schema、部分结果政策、幂等性与可重试范围在后续补齐。最小集已足以支撑三件事：检查期校验 act 声明的 op 是否存在且类别正确、启用前判定能力是否满足、运行期拒绝未声明调用。

op 声明以静态文件随 provider 包发布，检查阶段只读它、不加载 provider、不连接游戏；连接握手时核验实际实现与静态声明一致，不一致返回 `CAPABILITY_MISMATCH`。声明摘要进入 bindingId，实现升级产生新 binding。

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
| QUERY_TIMEOUT、QUERY_INCOMPLETE、STALE_OBSERVATION | 查询节点失败；不自动重试。 |
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

externalConfirmation 是有限 behavior 在树根成功且 act/broker 收尾完成后的一次外部验收，不是执行错误的豁免入口或通用恢复命令。body 每个 run 最多创建一条待确认记录；状态转换、竞争及失效规则见 [RUNTIME §4.4](RUNTIME.md#44-外部完成验收)。

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

确认不执行游戏操作或恢复节点栈。有效确认使原 run succeeded；有效否定使原 run failed/EXTERNAL_GOAL_REJECTED；需要继续工作时新建 run。对 pending 请求的查询、受理和重复返回不代表业务终态，必须区分 accepted 与已提交的决定。D3 在此固定语义和信息要求，首版消息和方法见[协议 §8](#8-bridgebody-消息协议)，可信来源接入见 [DSH 设计](DSH-INTEGRATION.md#5-模型工具与界面反馈)；D6 首版仅提供调试日志和内存队列，可靠提交与崩溃恢复延期。

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
| status | 无业务参数 | owner、health、connection、activeRun、阶段（declared progress 或当前节点名）、当前 act、当前节点 id 与目标坐标（activeNode/activeTarget，act 求值后的参数）、等待原因（query/policy/act/confirmation）、最近失败、pending switch、待确认记录、最近命令及对应快照的事件游标；另列 loggingUnavailable、droppedLogCount，不改变控制健康状态。 |
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

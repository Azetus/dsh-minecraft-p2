# behavior／act／policy 编写、检查、启用与迭代

> 本文规定 behavior／act／policy 的编写、检查、代码隔离、产物启用与反馈迭代流程。检查器保持被动，不依赖真实游戏，也不承担游戏模拟测试。
>
> 关联：[主架构](ARCHITECTURE.md)、[契约](CONTRACTS.md)、[运行时](RUNTIME.md)、[隔离设计](ISOLATION.md)。

## 1. 三种可编写内容与一条维护路径

| 内容 | 作者 | 启用路径 |
| --- | --- | --- |
| behavior | 人类或 agent | 源码 → 加载模块并静态检查（含依赖闭包）→ 不可变 artifact（`format="js"`）→ 注册 → 显式启动。 |
| act | 人类或 agent | 源码及 op 声明 → 检查（封闭模块、op 存在性与类别）→ 隔离运行包 → 注册 → behavior 引用。 |
| policy | 人类或 agent | 纯函数源码及输入/输出声明 → 检查（无 op、无副作用）→ 不可变 artifact → 作为 behavior 依赖引用。 |
| operation | 人类或 agent（开发阶段） | 源码及 op manifest → 检查（语法与 manifest 形状）→ 不可变 artifact（`kind="op"`）→ 在 binding 激活 → 供 act 使用；在 body 进程内执行。 |

表内 checker、runner 等是模块职责；初版它们同包交付，authoring 是同一包的项目入口，不代表独立发行物。

behavior 不承担 op 实现，act 只用已激活 op。缺能力时返回缺失能力信息，agent 可以改变目标，或在开发阶段现场编写 op 产物（[契约 §5.2](CONTRACTS.md#52-op-产物开发阶段开放编写)）；op 仍通过 broker 提交效果，不得绕过账本冒充已释放。

policy 是 behavior 层内部的纯决策单元，不是第四级：它没有 op 能力、没有生命周期、不能决定控制流。behavior 的分层与边界见[主架构 §3.6](ARCHITECTURE.md#36-policybehavior-内部的决策单元)。

四类内容产物的检查都不连接游戏：behavior 加载模块并检查导出形态、禁用 token 与引用，act 检查代码形态与声明的 op，policy 检查纯函数形态与声明，op 只检查语法与 manifest 形状；四者的通过都只说明产物在契约下可接受。

## 2. 候选及产物生命周期

```text
draft → checking → checked → enabled
             └─→ rejected
enabled → retired（不再允许新运行，已有运行按约定结束）
```

运行实例、源码版本和产物状态分开。编辑文件产生新的源码 revision；相同源码改用其他依赖或 binding 可以产生不同 artifactId。checked/enabled/retired 跟随确切产物及目标 binding，不将同一 revision 的所有检查混为一体。检查通过不是自动启用，启用也不是开始游戏动作。

behavior 与 act 有独立的 checked/enabled 状态；policy 是纯计算依赖，只按内容摘要进入依赖闭包，不单独 enable，也不能被 switch 启动。依赖图允许 behavior→act、behavior→policy，禁止 act→behavior、policy→任何内容、provider→内容产物。

**来源分级**：产物记录 `session-authored`（本会话 agent 编写）、`human-authored`（用户自己编写）、`imported`（外部来源）。三者使用同一检查与隔离门槛，但 `imported` 默认不启用，且必须由人工显式启用；本项目不为其安全性背书，也不鼓励从他人处获取 act/policy。启用记录保存来源与摘要，便于事后审查。

默认允许绑定 owner 的 agent 请求检查、注册 behavior／act 并切换行为，前提是已有的人类启动授权及受限运行环境均成立；不为每次可逆扩展强加人工确认。插件安装、body 管理、operation 升级仍走人类管理面。

## 3. 检查请求

请求给出工作区内源路径、预期 sourceDigest、目标 bindingId、artifactKind（behavior／act／policy）和确切依赖选择。先读取不可变源快照并计算摘要，摘要不符返回 SOURCE_CHANGED；之后的检查与打包只使用这份字节，不再从磁盘重新读取。路径须解析符号链接后仍位于允许的源码目录，相对路径与链接都不能越界。检查前固定本次依赖清单，只使用本地已锁定的模块和环境静态声明，不能现场联网安装或在检查中追随 latest。act／policy 依赖选择属于内容清单，不再放进环境 binding。

可在当前 run 继续使用旧 act 时检查新 act／policy／behavior，也可被动检查另一个 binding 的候选；检查不切换加载环境。未通过检查的候选依赖不能提供可复用的通过凭据，所需检查必须覆盖候选及其闭包；无关的旧产物不因此重查。

| 阶段 | 检查范围 | 不执行的工作 |
| --- | --- | --- |
| 解析 | JS 语法与允许的模块格式；behavior／act／policy 必须是单文件、无 `import`／`require` | 不推断玩家意图。 |
| 类型 | behavior 导出／`defineBehavior` 形状与参数定义、act hook、policy 输入/输出、声明的 op 与依赖 | 不证明算法终止或行为有效。 |
| 检查 | 加载 behavior 模块并做静态检查，产出 `format="js"` 的不可变产物；act／policy 生成封闭运行包与声明 | 不执行 behavior 的 `run`、不启动 act hook、不调用 policy、不调用 QueryOp/ControlOp。 |
| 产物接受 | 必需声明、模块形态、引用、op 声明、依赖闭包、体积限制 | 不模拟环境，不向游戏试请求。 |

类型与产物接受检查覆盖 behavior 模块导出／`defineBehavior` 形状、`run` 是否为生成器函数、参数定义，以及 `ctx.query`／`ctx.act`／`ctx.decide`／`ctx.wait` 的调用形态、`fail` 业务码和 `succeed` 证据的有界性。静态检查按 [behavior 契约 §7](BEHAVIOR.md#7-隔离与安全) 禁止 `import`／`require`／`eval`／`Function`／`async`／`await`／`setTimeout`／`setInterval`／`WebAssembly`／`fetch` 及宿主对象访问。act 的 `queryOps`／`controlOps` 必须存在、类别正确且不重复；policy 只能声明标量输入与 JSON 输出，出现 op 桥、文件、网络、宿主对象或顶层副作用即拒绝。检查不证明作者的累计指标符合玩家目标；结果归属、成功收尾及观测时效仍由运行时验证，见[数据流契约](CONTRACTS.md#32-写入与成功输出)。

静态检查不是“执行任意源码看是否报错”。检查器只加载模块并分析导出与命令调用，不执行 `run`、不创建 generator；只开放 `defineBehavior` 与可审核的纯辅助代码，禁止实际游戏/DSH 连接。模块顶层仍可能计算，因此加载在隔离检查环境中完成。

检查超时、内存预算耗尽、无法加载或不能产生合法 `format="js"` 产物均为检查失败。报告包含阶段、code、源码位置、依赖信息和修复提示，不直接改源码或触发模型会话。

首版起点：检查总时间 10s、受限引擎内存 128MiB、检查进程外部上限按运行平台配置；模块与依赖闭包大小有界。这些是防止检查器被无限循环拖住的工程预算，不是行为正确性测试。

## 4. 构建、act 与 policy 的代码隔离

body 的可信调度器不能与生成代码共用一个可被无限循环占住的 JavaScript 执行栈。behavior 在隔离 runner 的 `behavior` 角色中执行，act／policy 仍走既有隔离 runner；设计要求为“独立进程 + 受限 JS 执行上下文 + 显式能力桥”：

- 检查上下文只注入模块加载与纯函数；behavior 运行上下文只注入冻结的 `ctx` 命令入口；act 运行上下文仅注入 query/control 桥、时钟及必要数学操作；policy 上下文只注入数学与纯辅助函数，没有 op 桥。
- 没有 Node process、fs、网络、子进程、原生模块或 DSH 对象，不继承用户会话凭据。
- module loader 仅加载产物中的已锁定模块，禁止任意路径、动态包获取及逃出产物目录；首版 behavior／act／policy 为单文件，运行期不加载外部模块。
- 每次 behavior step、hook 或 policy 调用有执行预算和独立的外部无响应监测；进程可终止，但终止后依然由 broker 完成控制清理。
- 单个 runner 串行执行 behavior step、act hook 与 policy 调用，辅助函数复用不引入第二个控制者。

具体嵌入式 JS 引擎作为实现技术选型保留验证门槛：必须支持中断/内存限制、明确宿主绑定及异步任务调度，QuickJS/WASM 类实现可调查。未验证前不得把“子进程”或普通 JS context 宣称为完整安全隔离，也不得直接在 body 中 eval 生成代码作为替代。威胁模型与实测证据见[隔离设计](ISOLATION.md)。

这是运行环境的验收要求，不扩大被动检查器职责。首个实现阶段先用维护者内置 act 与内置 behavior 完成闭环；只有满足上述门槛后才开放 agent 自定义 act／policy 的启用，且来源限于本会话或用户本人，`imported` 必须人工启用。最终系统仍保留自定义能力，阶段限制必须对 agent 明示。

## 5. artifact 与检查凭据

behavior 产物使用 `format="js"`，保存模块源码、manifest 与确切依赖闭包。revision 标识源码，artifactId 标识确切可执行产物；sourceDigest、bindingId、artifactDigest 的输入与排除项统一按 [D4 摘要规则](OPERATIONS-AND-RELEASE.md#32-身份与摘要规则)处理。artifactId 直接由 artifactDigest 形成，检查凭据另外绑定 artifactDigest、bindingId 和 checker 版本。产物摘要已覆盖精确依赖闭包；检查时间作为凭据元数据，不参与产物身份，也不能仅按文件名或 revision 缓存“通过”。

产物目录只读保存，启用时复核摘要、目标 binding 与依赖凭据。目标 binding 可以不同于当前加载环境，但须有本地静态声明，不能因启用而加载 provider。失败返回详细差异，不悄悄降级旧依赖。源码变化、依赖选择变化、契约/环境变化要求重新检查采用这些变化的候选及闭包；首版可完整重查待启用包，不将新增 act 扩大成全库重查。

注册表按目标 binding 保存各 artifactId 的 checked/enabled/retired 状态，并可维护 `(bindingId, definitionId)` 到默认 enabled artifactId 的发现映射；多个旧/新产物可同时 enabled。默认映射只用于选择，请求进入执行器前须解析为确切 artifactId；运行期间不再读取 latest。behavior 的 act、policy 引用及其传递依赖也锁定确切内容，不能把同名或同 revision 的不同产物互换。policy 只记录 checked 与内容摘要，不参与 enabled 映射。

某 act 产物退休后，依赖它的 behavior 即使仍显示 enabled，也不得新启动；注册表应显示阻断原因。policy 退休时，依赖者同样被阻断新启动。已有 run 保留原依赖闭包继续按约定结束，包括该 run 后续 yield 对原 act 的使用；退休本身不发出停止请求。依赖产物保留供当前 run、诊断及受控回滚使用；回滚需重新满足检查与启用要求，不通过默认版本回退偷偷替换引用。

## 6. 启用与切换的事务边界

1. activate 明确指定 artifactId；校验 owner、产物及目标 binding 下的检查凭据。
2. 验证本地不可变依赖闭包及其启用资格；所引用的 act 产物须在同一目标 binding 下已检查并启用，退休依赖不能通过。policy 只核验 checked 与内容摘要，不要求 enabled。act 声明的 `queryOps`／`controlOps` 必须被目标 binding 的静态能力覆盖，缺失返回 CAPABILITY_MISSING；纯辅助库核验锁定内容及允许模块规则。检查不连接游戏，不为其他目标 binding 加载 provider。
3. 原子提交该目标 binding 下的 enabled 记录及所需默认映射，记录启用事件。
4. 用户/agent 显式请求 switch(artifactId, params, commandId)；复核参数、摘要、闭包启用状态、凭据、当前加载 binding 与实际能力，并准备 runner 所需不可变模块。此时不得有游戏动作，目标环境不符或候选无效均不能停止旧行为。
5. 执行器先停止旧行为并确认收尾，再启动新运行；授予新控制权前再次核验候选及依赖资格，失败不假称新行为已接管，也不改选其他版本。

启用失败保留旧enabled映射。切换期间旧行为已经停止而新行为启动失败时，保持无主动行为并报告；默认不自动恢复旧行为，因为它可能不再适合世界状态。

撤销启用不会自动停止当前实例；管理接口必须明确是“禁止新运行”还是“同时请求停止”。operation升级更严格：先结束所有依赖该provider的运行并确认清理，再切换binding，首版无热更新。

## 7. 默认恢复与上报

缺省行为为：失败传播、零运行时行为重试、不自动换目标。作者在 `run` 中用 `try/catch` 做局部恢复；运行时不做行为重试，结束时清理仍遵循独立的最多一次追加重试规则。

外部输入不足时，行为可以保持可取消等待或结束失败，并让事件标明 needsDecision=true；不能把任何未知错误都归 blocked 无限等待。body 的 blocked 状态用于明确的外部输入，模型不在线时保持，body 不现场生成策略。

配置文件只有参数不含任意运行脚本。agent改参数先经过schema校验；修改运行中的参数采用新实例切换，不直接改变当前act正在使用的参数对象。

## 8. 游戏内反馈迭代循环

真实反馈循环独立于检测器：

```text
运行结果／玩家意见
   → agent读取当前事实与关联revision
   → 判断是环境阻碍、目标变化、能力缺失还是实现错误
   → 选择现有behavior、改参数或写新revision
   → 被动检查 → 显式启用/切换 → 新的实际反馈
```

同一次普通环境失败不自动将artifact判为坏代码或停用。代码异常可使本次run失败并留下诊断；是否修复/退休由agent或维护者决定，不启动隐藏代码自进化循环。

一次决策回合最多提交一个待启用候选；连续3次检查失败默认停止自动修复链，汇总原因给当前session。behavior、act、policy 的检查失败都计入同一计数，成功检查或人类新指令归零。这个上限属于bridge/agent调度配置，不是检测器内部调用模型的次数。行为失败也受会话唤醒预算控制，避免游戏tick驱动无限模型回合。

## 9. 三类验证的明确分工

| 验证 | 拥有者 | 需要游戏吗 |
| --- | --- | --- |
| 用户behavior／act／policy语法、类型、静态加载检查 | checker | 不需要，也不模拟。 |
| runtime状态机、消息去重、预算、停机等软件测试 | P2开发者 | 用人工构造的接口结果验证核心，不属于用户checker。 |
| operation契约与游戏兼容测试、行为体验试验 | 库维护者/游戏内反馈流程 | 需要对应游戏候选环境，单独执行。 |

检查通过仅保证产物在绑定契约下可被执行器接受；不保证每一条代码路径不会异常、查询一定成功、游戏目标可达或自动生成代码可信。隔离只提供三项保证（宿主能力、资源、账本），语义安全与来源可信不在其中。

D4 软件验收覆盖：A 锁定 H1 运行时检查/启用 H2 不影响 A；B 显式引用 H2 后得到独立 artifact；同源码换依赖或 binding 保留源码 revision 但改变 artifactId；重复检查不改变产物身份；退休 H1 阻止依赖它的新 run，却不替换 A 的后续 yield；另一 binding 的候选可静态检查/启用，但环境不符时 switch 拒绝且不停止当前行为。

# operation 能力绑定、版本与发布设计

> 本文规定 operation 的能力声明、版本绑定、安装升级与发行验收。初版全部合并为一个 npm 包（bridge、body、内置 provider、authoring 子路径）；本地用 `npm run bundle` 输出 tarball 到 `bundles/` 供 DSH 安装，不发布 registry。完整发行和游戏驱动尚需实测。
>
> 关联：[DSH 核验](DSH-INTEGRATION.md)、[Minecraft 接入决策](MINECRAFT-INTEGRATION-OPTIONS.md)。

## 1. 版本维度不能混用

| 维度 | 示例含义 | 不代表 |
| --- | --- | --- |
| P2协议/IR版本 | body消息和行为图语义 | Minecraft版本。 |
| op契约版本 | 参数、返回、效果与停止保证 | 某个实现包发布次数。 |
| 实现包版本及digest | 可复现的具体代码 | 支持所有同主版本游戏。 |
| 游戏/加载器兼容清单 | 经过声明与验证的组合 | 策略一定有效。 |
| DSH兼容范围 | bridge可加载的宿主范围 | body自动继承宿主依赖。 |

首版优先固定确切版本和摘要；语义版本范围用来声明可接受性，实际执行binding必须解析为精确集合。0.x契约不假定同major即可兼容，按受测清单检查。错误语义、停止能力或可见范围改变也可能是契约变更，不只看类型是否一样。初版只有一个实现包；bridge、body、provider、authoring 的组件版本与摘要仍分别记录，不因同包而混用版本维度。

## 2. provider manifest

一个provider manifest描述packageId、packageVersion、artifactDigest、opContractVersion、bodyProtocolRange、运行时要求、gameCompatibility、operations、驱动要求和停止/重连能力。

每个operation有独立id及契约引用。operation清单是构建时可读的静态能力声明；连接时握手得到当前配置实际启用的能力子集。连接后能力收缩会使新运行拒绝或当前运行进入明确失败/清理，不能在检查器中偷偷查询游戏探测。

**op 的声明归 P2 核心，实现归 provider**：核心维护名称、类别（query/control）、持续效果、停止语义与能力标记，provider 按契约实现并随包发布同一份静态声明。检查阶段只读声明；连接握手核验实现与声明一致，不一致返回 `CAPABILITY_MISMATCH`，不静默降级。初版 provider 与核心同包但分目录，后续把 provider 整包拆出时，这份声明仍是两侧共享的唯一契约。

具体游戏版本、模组存在性和配置条件的验证由provider负责。body只消费“满足/不满足/未知”与声明，不内置Java/基岩版策略分支。未知兼容不当作已支持；允许开发实验时必须显式标注实验binding，不能混入受测发布清单。初版内置 provider 仍生成同一 manifest；同包交付不等于省略 provider 身份。

## 3. 不可变 binding

binding 只固定执行环境：body 运行时与运行契约版本、选定 provider 包及内容摘要、operation 契约与静态能力清单（含 op 声明摘要）、驱动版本，以及影响执行语义的配置。运行环境中的引擎/核心实现按确切版本和内容锁定；构建工具版本另外进入 artifact。act／policy 的 revision、注册表内容和默认启用版本不属于环境 binding，新增 act 或 policy 不改变 bindingId。初版 provider 随包交付，binding 仍记录其 manifest 摘要；外层包版本不自动进入 binding。仅 bridge 或 authoring 包版本变化、而 body/provider/behavior/op contract 摘要不变时，不改变环境 binding。

bindingId取规范化清单摘要。checker接收该binding的静态声明，不连接游戏；启动前body核验真实加载包和运行握手与binding一致。检查通过但实际能力缺失时返回CAPABILITY_MISSING，不改写“检查通过”等于游戏可用的含义。

一个角色一次运行只用一个provider，不混合两个实现的查询和控制。provider可内部组合模块，但所有控制归同一broker。行为/act依赖的op必须全部包含在绑定集合中，类型和停止语义必须匹配。

### 3.1 环境、产物依赖与运行实例

| 对象 | 固定内容 | 变化边界 |
| --- | --- | --- |
| bindingId | 确切执行环境及静态能力声明 | provider、契约或执行语义配置变化时生成新 binding。 |
| artifact 依赖清单 | 实际使用的确切 act artifactId、policy artifactId、被 `call` 引用的 behavior artifactId、纯辅助库及其他构建依赖；包含内容摘要和传递依赖闭包 | 重新选择依赖后生成并检查新 artifact，不修改旧产物。 |
| run | behavior artifactId、其确切依赖闭包、bindingId 和本次参数 | 显式启动新实例；运行中不追随注册表默认版本。 |

候选与当前运行可以使用不同的 act／policy 集合。静态检查可面向另一个 binding，但依赖及环境声明须已在本地可用，不加载新 provider、不连接游戏、不联网安装。启用记录按目标 binding 区分；启用其他环境的产物不切换当前环境，只有与当前加载 binding 一致且实际能力满足要求的产物才能启动。

依赖是单向的：binding 不引用 act；act 产物不引用调用它的 behavior；behavior 锁定确切 act 产物。拒绝产物依赖环，不能用跨产物相互摘要构造循环身份。纯辅助库复用不引入新的 act 调度者。

同一 behavior 的运行时 act 产物必须面向同一目标 binding；其他环境构建的 act 不能仅凭源码 revision 相同直接混用，需为目标环境重新构建检查。纯辅助库按确切内容和允许的模块规则校验，其摘要进入闭包，不要求把每个辅助库变成可启用的行为产物。

### 3.2 身份与摘要规则

| 标识 | 定义与计算输入 |
| --- | --- |
| sourceDigest | 源快照清单的摘要：入口相对路径、排序后的源码/本地构建输入相对路径及各文件原始字节摘要。外部包的精确选择由依赖清单锁定。 |
| revision | 定义的源码版本；首版在 definitionId 内采用 sourceDigest，不代表某个环境中的唯一可执行产物。 |
| bindingId | 环境清单的摘要：版本、包内容摘要、operation 契约和静态能力、驱动与有效配置；不包含 behavior／act／policy 集合。 |
| artifactDigest | 规范化产物清单的摘要：类型（behavior／act／policy）、definitionId、源码摘要、模块或打包代码/文件摘要、manifest、相对源位置映射、精确依赖清单、构建工具版本及 bindingId。依赖闭包的确切内容均须由摘要覆盖。 |
| artifactId | 由 artifactDigest 加类型化标识前缀形成，不另外计算一套不同的内容摘要。 |

所有摘要采用 SHA-256；待摘要清单带格式版本和对象种类，以规范化 JSON 的 UTF-8 字节计算。对象键按固定顺序排序，字符串转义和有限数值表示由同一版本的规范化器统一处理；有序数组（如参数顺序）保留顺序，文件/依赖等集合按声明的唯一键排序并拒绝重复。M0 必须用固定样例验证规范化结果，不能依赖调用方字段插入顺序或各自序列化。

文件内容按实际字节计算，不静默改换行或源码。清单路径使用相对根目录的规范化路径和 `/` 分隔符，拒绝越界及规范化后重名，不纳入本机绝对目录。源文件换行改变会改变 sourceDigest；相同内容搬到另一工作区不应仅因绝对路径而改变身份。

摘要输入排除自身的 ID/digest 字段、检查凭据、检查时间、日志、owner、runId、connection/body epoch、注册表默认映射和 enabled/retired 状态；这些是独立元数据，不得回填到内容清单后再次参与自身摘要。配置只纳入影响绑定的有效项；秘密明文及其直接内容摘要不写入 artifact/session，影响绑定的秘密引用使用非秘密标识和明确版本。即时连接状态和世界引用不属于静态 binding，仍须在运行时独立核验。

同一源码在不同依赖或 binding 下构建可以保留同一 revision，但得到不同 artifactId。检查凭据独立绑定 artifactDigest、bindingId 和 checker 版本；检查时间可用于审计，不改变产物身份。相同输入若产生不同代码，则是不同产物，不能仅凭 sourceDigest 复用检查结论。

### 3.3 变更影响范围

| 变更 | 检查与运行处理 |
| --- | --- |
| 新增旧行为未引用的 act | 检查新 act 及引用它的新候选；旧产物与 binding 不变。 |
| 新增或修改 policy | 生成新 policy 产物并检查；引用它的候选重新检查，旧产物与其已有 run 不变，policy 不单独启用。 |
| act 源码或依赖改变 | 生成新产物；采用它的候选重新检查，锁定旧产物的行为不自动升级。 |
| behavior 源码或依赖选择改变 | 重新构建并检查该候选及所需依赖闭包。 |
| provider、契约或执行语义配置改变 | 生成新 binding；要在新环境启用的内容重新检查，旧环境凭据不直接复用。 |
| 新增 op（provider 版本升级） | 生成新 binding；旧产物保持原 binding 继续运行，需在新 binding 下重新检查才能启用新能力。 |
| 内容产物退休 | 禁止其本身及依赖它的行为新启动；已有 run 按固定闭包继续结束，不自动替换同名产物。 |

首版可完整重查一个候选包，暂不优化增量算法；范围仍是候选及其依赖，不因新增 act 而重查全库。精确产物启用、切换及退休规则见[扩展生命周期](BEHAVIOR-LIFECYCLE.md#5-artifact-与检查凭据)。

## 4. 安装、选择、启用、启动

以下流程用于单包安装/升级。相同 binding 下新增 behavior／act／policy 走内容检查与启用流程，不重新安装 provider。

```text
安装单包 tarball → 解析内置 provider manifest → 解析binding
    → 检查受影响behavior／act／policy → 停止旧运行并清理
    → 加载/握手内置 provider → 显式开始新运行
```

初版只有一个包，provider 随包内置；安装/升级该包等同于更新 body/provider 环境。初版不追求多版本并存；同一 body 同时只加载一个游戏 provider。安装不执行角色动作，不意味着启用。首版不做 provider 热替换，也不因发现新版本自动下载或切换。后续拆分 provider 时流程不变，只把“安装单包”换成“安装 provider/环境包”。

升级失败保持旧包和配置可回退；若旧控制已停止，新 provider 加载失败，body 保持无主动行为并显示原因，不自动恢复旧动作。回退旧包同样重新验证 binding 与当前 behavior 依赖，不撤销游戏世界变化。

operation 运行时升级只由人类管理命令发起；agent 可以提出缺失能力和候选代码，库维护者走开发、测试、发布。初版中 provider 随包交付，因此这项升级表现为安装新的单包 tarball；QueryOp 和 ControlOp 同样遵守此边界。

## 5. 源码与交付组织

初版采用单包交付：一个 npm 包包含 bridge、body、内置 Mineflayer provider、operation 声明、authoring 子路径、共享 contracts、预设 behavior／act／policy。包内按目录分层（operation 声明与 provider 实现不在同一目录，provider 不反向依赖核心或内容产物），依赖方向仍按[接口文档](CONTRACTS.md)；bridge 不 import core/body/provider，core 不 import Mineflayer，authoring 只依赖 contracts/op-contracts。后续验证可行后再拆 bridge/body/provider/authoring。

Mineflayer 及其插件依赖归 provider 模块管理；初版随包构建，不成为 core、观测层、公共契约或 behavior／act 的直接依赖；对外数据、错误与控制生命周期统一映射到 operation 契约。后续真实客户端 provider 按自身驱动要求交付，各实现可有不同能力集合，不承诺无条件迁移行为或运行中热替换。

本地使用 npm 脚本构建；`npm run bundle` 把 tarball 输出到 `bundles/`，DSH profile 通过插件管理安装同一 tarball；项目以 devDependency 安装同一 tarball 以获得 authoring。初版不发布 registry，也不建 provider store、多版本或签名/自动更新。operation 未来可拆到独立 Git 仓库，包名与公开契约保持，主仓库改用发布版本；不要求 submodule。

| 发行物 | 包含 | 安装方式 |
| --- | --- | --- |
| P2 初版单包 | bridge（Cordis 入口）、body（stdio 子进程）、内置 Mineflayer provider、operation 声明、authoring 子路径、预设 behavior／act／policy、共享契约与 manifest | `npm run bundle` 输出 tarball 到 `bundles/`；DSH profile 通过插件管理安装；项目以 devDependency 安装同一 tarball 以获得 authoring。 |
| 游戏驱动（若需要） | 对应版本/加载器 JAR 或其他驱动 | 初版 Mineflayer 不需要；真实客户端阶段另行安装，不能仅靠 npm。 |
| 行为内容包 | 预设 behavior／act／policy 及检查所需声明 | 初版预设随单包内置，项目源码在项目内检查；不单独发包。 |

初版不单独交付 bridge、body、provider 或 authoring；它们是同一个包的组成部分，模块/进程边界仍按接口与运行文档。**v1 只要求目录分离，不要求拆包**：provider 与 operation 声明、内容产物不在同一目录，且 provider 不反向依赖核心。具体拆包形式（独立包名、版本节奏、安装方式）在第二版再定，届时 provider 作为独立包实现 op 契约并携带静态声明，主包保留核心、operation 声明与内置 behavior／act／policy。已选客户端路线和 Mineflayer 首版验证，不代表发行物与整合包已经通过验证；完成相应实测前，不宣布“解压即玩”或支持全部本机整合包。

## 6. 可复现发布与离线边界

初版用 `npm run bundle` 从同一源码构建一个 tarball，输出到 `bundles/`；不提交构建产物，不把开发目录符号链接当作发布内容。项目以 devDependency 安装同一 tarball 以获得 authoring；版本不一致时 `/p2 setup` 或 checker 拒绝。发布记录（M6 起）包含 releaseId、源码 revision、构建工具版本、锁文件摘要、tarball 摘要、组件 manifest 摘要和 DSH/游戏测试矩阵。

body 与内置 provider 随单包交付，但 body 不得依赖 DSH 安装目录中偶然存在的库；bridge 通过宿主允许的 peer 与普通依赖解析。单包应尽量把 body/provider 的运行时依赖 bundle 进包内；若 Mineflayer 等无法完整 bundle，则必须在干净环境验证 tarball + 依赖闭包可安装，并记录限制。隔离引擎若以 WASM 或其他二进制资产形式交付，必须随 tarball 一起打包并验证离线加载，不能在运行期下载。

首版由 bridge 管理 body 及辅助进程的生命周期，需验证 tarball 安装、入口解析、运行时选择、管道日志分离、退出收尾和 Windows 进程树回收。保持 body 模块与 DSH 解耦，不因采用插件托管而依赖宿主的隐式模块解析。独立 launcher、网络鉴权与 WS 发行推迟到[后续方案](WS-FUTURE.md)，不是首版交付前提。

首版先支持本机Windows受测环境，其他平台作为独立矩阵，不默认宣称支持。Node携带方式、签名、自动更新、在线注册平台及JS隔离引擎均须在发布原型中确认；在确认前文档不提供假安装命令。

## 7. 库发布验收与支持等级

manifest对每个游戏组合区分declared（声明）、experimental（实验）、verified（受测），记录验证日期和驱动/模组清单摘要。只有经过实际测试才能称verified。

发布门槛包括：schema一致性、独立查询/控制/停止/重连测试、QueryOp零自动重试、旧epoch拒绝、持续操作清理、结果未知处理、错误码映射、受测包安装、license及依赖清单。它们属于维护者发布流程，不放进用户behavior checker。

正式宣称支持某个游戏组合前，必须通过候选文档G0—G6相关门槛。只证明能登录不能宣称正常生存，只有参数类型匹配不能宣称取消可靠。

D4 的软件验收另覆盖：对象键重排和集合重排不改变摘要，有序数组重排改变摘要；工作区绝对路径、检查时间和注册状态变化不改变内容身份；源码字节、依赖或 binding 变化改变相应摘要；新 act 或 policy 不改变环境 binding；自引用摘要、直接依赖环以及 `call` 形成的行为依赖环被拒绝。固定输入应得到固定摘要，摘要检查不替代游戏兼容验收。

初版单包验收另覆盖：`bundles/` 中的 tarball 可在干净 DSH profile 安装并加载；项目安装同一 tarball 后 authoring 版本一致；包版本变化但 body/provider/behavior/op contract 摘要不变时 binding 不变；内置 provider manifest 与实际加载实现一致。

# operation 能力绑定、版本与发布设计

> 本文规定 operation 的能力声明、版本绑定、安装升级与发行验收。同仓库多包与 pnpm 仍为暂定选型；完整发行和游戏驱动尚需实测。
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

首版优先固定确切版本和摘要；语义版本范围用来声明可接受性，实际执行binding必须解析为精确集合。0.x契约不假定同major即可兼容，按受测清单检查。错误语义、停止能力或可见范围改变也可能是契约变更，不只看类型是否一样。

## 2. provider manifest

一个provider manifest描述packageId、packageVersion、artifactDigest、opContractVersion、bodyProtocolRange、运行时要求、gameCompatibility、operations、驱动要求和停止/重连能力。

每个operation有独立id及契约引用。operation清单是构建时可读的静态能力声明；连接时握手得到当前配置实际启用的能力子集。连接后能力收缩会使新运行拒绝或当前运行进入明确失败/清理，不能在检查器中偷偷查询游戏探测。

具体游戏版本、模组存在性和配置条件的验证由provider负责。body只消费“满足/不满足/未知”与声明，不内置Java/基岩版策略分支。未知兼容不当作已支持；允许开发实验时必须显式标注实验binding，不能混入受测发布清单。

## 3. 不可变 binding

binding 只固定执行环境：body/IR 与运行契约版本、选定 provider 包及内容摘要、operation 契约与静态能力清单、驱动版本，以及影响执行语义的配置。运行环境中的引擎/核心实现按确切版本和内容锁定；构建工具版本另外进入 artifact。act revisions、注册表内容和默认启用版本不属于环境 binding，新增 act 不改变 bindingId。

bindingId取规范化清单摘要。checker接收该binding的静态声明，不连接游戏；启动前body核验真实加载包和运行握手与binding一致。检查通过但实际能力缺失时返回CAPABILITY_MISSING，不改写“检查通过”等于游戏可用的含义。

一个角色一次运行只用一个provider，不混合两个实现的查询和控制。provider可内部组合模块，但所有控制归同一broker。行为/act依赖的op必须全部包含在绑定集合中，类型和停止语义必须匹配。

### 3.1 环境、产物依赖与运行实例

| 对象 | 固定内容 | 变化边界 |
| --- | --- | --- |
| bindingId | 确切执行环境及静态能力声明 | provider、契约或执行语义配置变化时生成新 binding。 |
| artifact 依赖清单 | 实际使用的确切 act artifactId、纯辅助库及其他构建依赖；包含内容摘要和传递依赖闭包 | 重新选择依赖后生成并检查新 artifact，不修改旧产物。 |
| run | behavior artifactId、其确切依赖闭包、bindingId 和本次参数 | 显式启动新实例；运行中不追随注册表默认版本。 |

候选与当前运行可以使用不同的 act 集合。静态检查可面向另一个 binding，但依赖及环境声明须已在本地可用，不加载新 provider、不连接游戏、不联网安装。启用记录按目标 binding 区分；启用其他环境的产物不切换当前环境，只有与当前加载 binding 一致且实际能力满足要求的产物才能启动。

依赖是单向的：binding 不引用 act；act 产物不引用调用它的 behavior；behavior 锁定确切 act 产物。拒绝产物依赖环，不能用跨产物相互摘要构造循环身份。纯辅助库复用不引入新的 act 调度者。

同一 behavior 的运行时 act 产物必须面向同一目标 binding；其他环境构建的 act 不能仅凭源码 revision 相同直接混用，需为目标环境重新构建检查。纯辅助库按确切内容和允许的模块规则校验，其摘要进入闭包，不要求把每个辅助库变成可启用的行为产物。

### 3.2 身份与摘要规则

| 标识 | 定义与计算输入 |
| --- | --- |
| sourceDigest | 源快照清单的摘要：入口相对路径、排序后的源码/本地构建输入相对路径及各文件原始字节摘要。外部包的精确选择由依赖清单锁定。 |
| revision | 定义的源码版本；首版在 definitionId 内采用 sourceDigest，不代表某个环境中的唯一可执行产物。 |
| bindingId | 环境清单的摘要：版本、包内容摘要、operation 契约和静态能力、驱动与有效配置；不包含 behavior/act 集合。 |
| artifactDigest | 规范化产物清单的摘要：类型、definitionId、源码摘要、IR 或打包代码/文件摘要、manifest、相对源位置映射、精确依赖清单、构建工具版本及 bindingId。依赖闭包的确切内容均须由摘要覆盖。 |
| artifactId | 由 artifactDigest 加类型化标识前缀形成，不另外计算一套不同的内容摘要。 |

所有摘要采用 SHA-256；待摘要清单带格式版本和对象种类，以规范化 JSON 的 UTF-8 字节计算。对象键按固定顺序排序，字符串转义和有限数值表示由同一版本的规范化器统一处理；行为节点、分支等有序数组保留顺序，文件/依赖等集合按声明的唯一键排序并拒绝重复。M0 必须用固定样例验证规范化结果，不能依赖调用方字段插入顺序或各自序列化。

文件内容按实际字节计算，不静默改换行或源码。清单路径使用相对根目录的规范化路径和 `/` 分隔符，拒绝越界及规范化后重名，不纳入本机绝对目录。源文件换行改变会改变 sourceDigest；相同内容搬到另一工作区不应仅因绝对路径而改变身份。

摘要输入排除自身的 ID/digest 字段、检查凭据、检查时间、日志、owner、runId、connection/body epoch、注册表默认映射和 enabled/retired 状态；这些是独立元数据，不得回填到内容清单后再次参与自身摘要。配置只纳入影响绑定的有效项；秘密明文及其直接内容摘要不写入 artifact/session，影响绑定的秘密引用使用非秘密标识和明确版本。即时连接状态和世界引用不属于静态 binding，仍须在运行时独立核验。

同一源码在不同依赖或 binding 下构建可以保留同一 revision，但得到不同 artifactId。检查凭据独立绑定 artifactDigest、bindingId 和 checker 版本；检查时间可用于审计，不改变产物身份。相同输入若产生不同代码/IR，则是不同产物，不能仅凭 sourceDigest 复用检查结论。

### 3.3 变更影响范围

| 变更 | 检查与运行处理 |
| --- | --- |
| 新增旧行为未引用的 act | 检查新 act 及引用它的新候选；旧产物与 binding 不变。 |
| act 源码或依赖改变 | 生成新产物；采用它的候选重新检查，锁定旧产物的行为不自动升级。 |
| behavior 源码或依赖选择改变 | 重新构建并检查该候选及所需依赖闭包。 |
| provider、契约或执行语义配置改变 | 生成新 binding；要在新环境启用的内容重新检查，旧环境凭据不直接复用。 |
| 内容产物退休 | 禁止其本身及依赖它的行为新启动；已有 run 按固定闭包继续结束，不自动替换同名产物。 |

首版可完整重查一个候选包，暂不优化增量算法；范围仍是候选及其依赖，不因新增 act 而重查全库。精确产物启用、切换及退休规则见[扩展生命周期](BEHAVIOR-LIFECYCLE.md#5-artifact-与检查凭据)。

## 4. 安装、选择、启用、启动

以下流程用于执行环境/provider 变更。相同 binding 下新增 behavior/act 走内容检查与启用流程，不重新加载 provider。

```text
安装包 → 发现manifest → 选择确切版本 → 解析binding
    → 检查受影响behavior/act → 停止旧运行并清理
    → 加载/握手新provider → 显式开始新运行
```

允许多个版本在磁盘并存；同一body同时只加载一个游戏provider。安装不执行角色动作，不意味着启用。首版不做provider热替换，也不因发现新版本自动下载或切换。

升级失败保持旧包和配置可回退；若旧控制已停止，新provider加载失败，body保持无主动行为并显示原因，不自动恢复旧动作。回退旧包同样重新验证binding与当前behavior依赖，不撤销游戏世界变化。

operation运行时升级只由人类管理命令发起；agent可以提出缺失能力和候选代码，库维护者走开发、测试、发布。QueryOp和ControlOp同样遵守此边界。

## 5. 源码与交付组织

暂定同仓库物理包：contracts/builder-sdk、core（含runtime/checker/registry逻辑模块）、bridge、op-contracts、具体provider。初期可合并contracts包以减少维护；只在发布/依赖生命周期确实不同处拆包。模块职责仍按[接口文档](CONTRACTS.md)。

首个游戏provider以Mineflayer为底层依赖。Mineflayer及其插件依赖归该provider管理，不成为core、观测层、公共契约或behavior／act的直接依赖；对外数据、错误与控制生命周期统一映射到operation契约。后续真实客户端provider按自身驱动要求交付，各实现可有不同能力集合，不承诺无条件迁移行为或运行中热替换。

pnpm负责工作区依赖、构建工具及锁文件，P2负责运行binding和能力检查。operation未来可拆到独立Git仓库，包名与公开契约保持，主仓库改用发布版本；不要求submodule。

| 发行物 | 包含 | 安装方式 |
| --- | --- | --- |
| DSH bridge bundle | 编译ESM、Cordis patch、配置/显示元数据、类型及普通依赖 | DSH plugin manager；不手改profile。 |
| body发行包 | stdio 子进程入口、可信核心、检查/runner 环境、固定依赖与配置模板 | 插件定位本地入口，人工 /p2 start 后创建；安装/加载不启动进程。 |
| operation发行包 | manifest、实现、契约版本及依赖闭包 | 安装到本地provider集合，人工选择。 |
| 游戏驱动（若需要） | 对应版本/加载器JAR或其他驱动 | 按最终接入方案单独安装，不能仅靠pnpm。 |
| 行为内容包 | 预设behavior/act及检查所需声明 | body registry导入并绑定后启用。 |

完整发行可同时附带bridge、body和一个默认provider，但逻辑上仍是不同生命周期。已选客户端路线和Mineflayer首版验证，不代表发行物与整合包已经通过验证；完成相应实测前，不宣布“解压即玩”或支持全部本机整合包。

## 6. 可复现发布与离线边界

发布记录releaseId、源码revision、构建工具版本、锁文件摘要、所有产物digest、DSH/游戏测试矩阵。工作区的workspace依赖需要在可安装发行物中正确解析；不能把开发目录符号链接当作发布内容。

body不得依赖DSH安装目录中偶然存在的库；bridge则通过宿主允许的peer与普通依赖解析。单个npm tarball不必包含所有传递依赖，离线发行必须另行物化依赖闭包或打包运行所需文件，并在干净环境验证。

首版由 bridge 管理 body 及辅助进程的生命周期，需验证入口解析、运行时选择、管道日志分离、退出收尾和 Windows 进程树回收。保持 body 模块与 DSH 解耦，不因采用插件托管而依赖宿主的隐式模块解析。独立 launcher、网络鉴权与 WS 发行推迟到[后续方案](WS-FUTURE.md)，不是首版交付前提。

首版先支持本机Windows受测环境，其他平台作为独立矩阵，不默认宣称支持。Node携带方式、签名、自动更新、在线注册平台及JS隔离引擎均须在发布原型中确认；在确认前文档不提供假安装命令。

## 7. 库发布验收与支持等级

manifest对每个游戏组合区分declared（声明）、experimental（实验）、verified（受测），记录验证日期和驱动/模组清单摘要。只有经过实际测试才能称verified。

发布门槛包括：schema一致性、独立查询/控制/停止/重连测试、QueryOp零自动重试、旧epoch拒绝、持续操作清理、结果未知处理、错误码映射、受测包安装、license及依赖清单。它们属于维护者发布流程，不放进用户behavior checker。

正式宣称支持某个游戏组合前，必须通过候选文档G0—G6相关门槛。只证明能登录不能宣称正常生存，只有参数类型匹配不能宣称取消可靠。

D4 的软件验收另覆盖：对象键重排和集合重排不改变摘要，有序节点/分支重排改变摘要；工作区绝对路径、检查时间和注册状态变化不改变内容身份；源码字节、依赖或 binding 变化改变相应摘要；新 act 不改变环境 binding；自引用摘要和依赖环被拒绝。固定输入应得到固定摘要，摘要检查不替代游戏兼容验收。

# 实施顺序、验收与待验证决策

> 本文规定 M0—M6 的实施顺序、阶段退出条件、验收矩阵与待验证事项。计划和验收要求不代表实现已完成或测试已通过。

## 1. 设计基线与适用范围

首版为本机、一个 body 控制一个角色、一个 owner session。人工 start 后由 DSH bridge 创建并持有独立 body 子进程，使用 stdio；插件安装/加载/重载不自动创建进程。body 生命周期跟随插件，调度仍不等待模型。**初版全部合并为一个 npm 包**：bridge、body、内置 provider、operation 声明、authoring 子路径与预设 behavior／act／policy 同包交付，provider 与核心分目录；bridge 仍是 Cordis 入口，body 仍是独立子进程。behavior／act／policy 可由 agent 扩展，operation 只经基础库维护发布；单线程树无 Parallel，一个 act 可协调多个底层效果。

首版不承诺硬实时生存、跨游戏版本行为自动正确、全量世界记忆、整局确定性回放、任意代码安全证明、多人多角色调度或运行中provider热替换。上述边界不是待补接口，而是明确控制项目范围。

## 2. 决策记录

| 编号 | 决定 | 依据/细节 |
| --- | --- | --- |
| A01 | 模型不在动作关键路径，既有behavior继续由代码推进 | [运行时](RUNTIME.md) |
| A02 | behavior/act/op 三层；query 读取可供多个上层使用；policy 属于 behavior 层，不构成第四级 | [主架构](ARCHITECTURE.md) |
| A03 | 一棵活动树、一个控制act，先确认停止再接管 | [状态与控制权](RUNTIME.md) |
| A04 | 代码构建数据IR，执行器不运行作者任意树回调 | [契约](CONTRACTS.md) |
| A05 | 检测器被动，无真实或模拟游戏测试 | [扩展生命周期](BEHAVIOR-LIFECYCLE.md) |
| A06 | QueryOp一次请求，零自动重试；清理操作最多追加一次且共用期限 | [运行时](RUNTIME.md) |
| A07 | 不建P2世界副本、不记录环境变化事件 | [反馈与数据归属](FEEDBACK-AND-RECOVERY.md) |
| A08 | body 独立调度、生命周期由插件托管；人工 start，stdio 关闭或存活超时清理退出 | [DSH 接入](DSH-INTEGRATION.md)；独立常驻 body 与 WS 保留为后续方案。 |
| A09 | 不可变artifact、精确binding、运行中版本不变 | [发布设计](OPERATIONS-AND-RELEASE.md) |
| A10 | 初版单包交付：bridge、body、内置 provider、authoring 子路径同包；内部按目录分层，后续再拆 | [主架构4.5](ARCHITECTURE.md#45-仓库组织与包管理初版单包后续可拆) |
| A11 | 生成代码不持游戏连接，隔离runner与可信broker分开 | [扩展生命周期4](BEHAVIOR-LIFECYCLE.md#4-构建act-与-policy-的代码隔离) |
| A12 | 采用独立客户端路线，初版用 Mineflayer 验证；服务器角色不作为当前方向 | [接入决策](MINECRAFT-INTEGRATION-OPTIONS.md#11-接入路线决策) |
| A13 | Mineflayer 仅为 operation 实现依赖，core、观测层及行为内容不直接依赖其对象或接口 | [依赖边界](MINECRAFT-INTEGRATION-OPTIONS.md#12-mineflayer-与-p2-的依赖边界) |
| A14 | D1 已确认：数据以受限 JSON 跨 ctx 边界传递；query 返回值与观测元数据；时效不自动传播 | [数据契约](CONTRACTS.md#31-数据归属与寿命)、[运行规则](RUNTIME.md#43-局部状态与结果写入)；第一版沿用 locals 保存查询快照，保留后续评估空间。 |
| A15 | D2 已确认：顺序写入立即可读，新动作与终态前统一检查条件并裁决 | [调度检查点](RUNTIME.md#31-新动作与终态的统一检查点)、[完成裁决](RUNTIME.md#42-完成判定)；取消优先，程序错误不被目标掩盖，普通环境失败可让位于有效目标证据，故障阻止终态提交。 |
| A16 | D3 已确认：外部验收结束原 run，补做工作新建 run；请求有明确标识、来源与唯一决定 | [验收契约](CONTRACTS.md#71-外部完成验收契约)、[运行规则](RUNTIME.md#44-外部完成验收)；确认/否定、非法命令、重复/失效、取消竞争与断线取回分别处理。 |
| A17 | D4 已确认：binding 固定环境，artifact 锁定实际依赖，run 按 artifactId 固定内容 | [发布设计 §3](OPERATIONS-AND-RELEASE.md#3-不可变-binding)、[生命周期 §5—6](BEHAVIOR-LIFECYCLE.md#5-artifact-与检查凭据)；新增 act 不改变全局环境，明确摘要、检查范围、候选并存及退休规则。 |
| A18 | D5 首版方案已确认：stdio 子进程、协议与传输解耦、固定单 owner、显式生命周期 | [首版协议](CONTRACTS.md#8-bridgebody-消息协议)、[接入流程](DSH-INTEGRATION.md#4-启动与关闭状态机)；已讨论 WS 设计保存在 [WS-FUTURE.md](WS-FUTURE.md)，以后实现。 |
| A19 | D6 首版已确认：日志只服务开发调试，业务不等落盘，队列有界且停止优先 | [反馈设计 §3](FEEDBACK-AND-RECOVERY.md#3-当前状态日志与内存预算)；仅内存去重与通知，持久索引/可靠投递/崩溃恢复延期。 |
| A20 | 三层职责纠正：op 是原子能力（声明归 P2 核心、实现归 provider），act 是唯一控制层，behavior 不得直接引用 ControlOp | [主架构 §3](ARCHITECTURE.md#3-核心概念)、[运行时 §5](RUNTIME.md#5-act-与操作控制权)；现有 provider 动作下沉为 op。 |
| A21 | behavior = 计划（受限生成器协程）+ 决策（`decide` 调用的 policy）+ 状态；集合算子与子行为调用为候选 | [BEHAVIOR](BEHAVIOR.md)、[契约 §4.1](CONTRACTS.md#41-policy-作者接口)；按证据扩展。 |
| A22 | 安全口径只承诺三项：不能访问宿主能力、不能超出资源预算、不能绕过控制账本；不承诺语义安全，不为第三方来源背书 | [隔离设计](ISOLATION.md)；`imported` 产物默认不启用。 |

这些是当前架构基线，新增部分仍是可复审的设计决定，不是源码实现事实。修改长期约束时应更新关联文档与验收，而不是只改示例代码。

## 3. 实施阶段

当前处于 M5.5 之后的实现阶段：behavior 表示已确定为受限生成器协程，重点是把 JS 运行时补齐、实现威胁反应，并清理基线遗留问题。

### M0：契约与可安装骨架

建立单包骨架：一个 npm 包内的 bridge、body、authoring 子路径与共享契约；统一 schema、错误类型、binding manifest 及构建产物格式。构建 stdio body 空进程和仅有管理命令的 bridge：安装/加载无子进程，人工 start 创建并握手，stop 回收。本地通过 `npm run bundle` 把 tarball 输出到 `bundles/`，供 DSH 安装测试；初版不发布 registry。此时不连接 Minecraft，不注册可执行游戏工具。

D4 在 M0 定义环境清单、精确依赖清单、源码 revision 与 artifactId，以及带格式版本的统一规范化器和 SHA-256 摘要规则。固定样例验证对象键/集合排序、语义数组顺序、相对路径、原始字节、排除字段和无循环摘要；sourceDigest 相同而依赖/binding 不同的产物应可明确区分。

D5 在 M0 建立消息接口、stdio JSON Lines 和内存测试传输，分开协议分发与进程管理；验证 hello 的 epoch 引导、分帧、stdout/stderr 分离、重复 start、正常关闭、管道失效及握手失败回收。暂不实现 WS 端口、令牌、租约竞争或独立 launcher。

退出条件：干净环境能从 `bundles/` 安装并加载同一个 tarball，人工 start 创建唯一 body 并完成 hello/describe；错误版本、错误归属和非法消息被拒绝；安装后无 P2 子进程、游戏连接或自动模型回合。同一个 tarball 安装到临时项目后，`authoring` 子路径可解析并完成类型检查，版本与 body 包一致。确认 Node 运行时、tarball 依赖解析和 Windows 进程树生命周期证据。

### M1：纯执行器与受控扩展

实现树控制结构、状态机、查询结果注入的开发测试端、act/broker 生命周期、内存命令记录和简单调试日志。开发测试端仅用于 P2 自身测试，不成为用户 checker 依赖。实现构建隔离与不可变 artifact 启用，不把运行日志作为恢复数据库。

数据流按 D1 实现受限 JSON 跨边界传递与观测元数据；调度按 D2 实现固定输入批次、同轮写入可见、条件依赖版本与检查点、结束意图及终态裁决。覆盖对应运行时验收场景，尤其是同批取消与成功、目标与环境失败、程序错误、收尾故障及晚到结果；设计确认不代表测试已通过。

D3 在 M1 实现每个 run 唯一的待确认记录、根成功且收尾后的准入、确认/否定结束原 run、重复与相反决定、失效及取消竞争。以受控命令测试验证状态转换和终态检查，不将外部确认当作执行错误恢复；首版协议按 D5 的 stdio 方案实现，D6 使用简单调试日志，命令与确认记录仅保存在当前 epoch 内存中。

D4 在 M1 实现候选依赖锁定、按目标 binding 保存产物启用状态、独立检查凭据、artifactId 切换和运行闭包固定。覆盖 H1/H2 并存、无关新增不重查、同源码不同产物、退休依赖拒绝新启动、切换等待中资格变化及其他 binding 候选拒绝启动；允许完整检查一个候选包，不先实现全库增量算法。

D6 在 M1 实现异步 JSONL、大小轮换、有界日志缓冲、丢弃计数与 loggingUnavailable；日志故障不改变执行器健康，不让 accepted/终态等待落盘。命令去重仅在当前 epoch 内存有效，日志可删，重启不重建运行或索引。验证普通队列满载时停止/清理仍能推进，不实施崩溃恢复测试框架。

退出条件：[运行时验收场景](RUNTIME.md#11-验收场景)通过；用户checker不触发QueryOp/ControlOp；构建无限循环不会阻塞body；随机重复/乱序输入不产生双控制者。

### M2：DSH会话与事件闭环

实现人工 start、局部工具、固定 owner、heartbeat 存活检测、命令查询、事件队列、session 来源及停止/退出故障展示。验证模型 stop 保留 body、人工 stop/插件释放关闭 body，使用开发端反馈，不宣称已经能玩游戏。

D3 在 M2 接入 confirm 的明确请求标识、可信调用来源、status 取回及事件合并；验证模型不能自报玩家身份，未实现可信玩家入口时只支持 agent 判断。确认、否定、非法命令和 accepted/已提交终态应分别展示，旧通知和重复命令不造成重复验收或唤醒。

D6 在 M2 使用有界内存事件队列，不做持久 pending 或 events.ack；溢出时合并/丢弃进度并提示缺口，通过当前 status 汇总。插件退出不恢复未投递事件，不承诺跨崩溃可靠通知。

退出条件：只绑定正确项目的现有 session；插件卸载关闭自己持有的进程但不销毁用户 agent；重载后不自动 start，事件重复不无限唤醒；accepted 不渲染为任务完成。DSH 异常退出、runner 卡住及输出背压下验证控制清理和进程树回收；强制结束不误报游戏停止，新 epoch 不重放旧命令。

### M3：Minecraft接入可行性实验

使用 Mineflayer operation 实现进行最小实验，固定一个受支持的原版或可接受原版客户端的环境。具体游戏版本、世界入口、独立身份及所有者授权条件另行确定，不能静默修改现有整合包或更换用户版本。按接入文档G0—G3验证独立P2、当前事实与可停止控制；同时检查core、观测层和behavior／act没有直接依赖Mineflayer对象、类型、事件或插件接口。provider 仍作为单包内的模块构建，不新建发行物；若 Mineflayer 无法完整 bundle，则记录依赖闭包与安装限制，不因此拆包。

退出条件：可观察到两个独立角色；动作控制不争抢人类角色；取消、body丢失、游戏暂停、世界卸载均有明确结果。失败时记录实现限制，再评估修复或真实客户端实现，不绕过核心控制契约、不自动转向服务器假玩家。此阶段通过不代表目标模组包兼容。

后续真实客户端验证另行安排：先以可见窗口及较低画质验证控制mod与代表性模组交互，再测量资源并评估无头运行。保留同一operation契约，具体驱动、加载器与无头工具尚未选定。

### M4：首个完整行为与反馈

实现少量明确act和一个有限目标behavior、一个持续behavior，加入受阻、取消、查询失败及玩家改变目标的流程。测试真实环境下的behavior恢复与agent选择。

退出条件：目标完成证据明确；失败可定位到revision/op；会话记录实际结果；停止时间测量支持调整配置；游戏行为问题进入反馈循环而不是被checker“测通过”。

> 实施记录：M4 的“act”实现落在 op 层（provider 的 look/move/jump/moveTo/stop），behavior 直接调用了控制 op；按 A20 的纠正，真正的 act 层在 M5 补齐。该段历史证据保留不改，M5 验收包含 M4 链路等价性回归。

### M5：三层补齐与验证

本节只列阶段与门槛。

**G1 基础设施（冻结集）**

1. 分层与目录：provider 的 look/move/jump/moveTo/stop 下沉为 op；`operation` 声明归核心，`provider` 只实现；`acts`／`behaviors`／`policies` 分目录；behavior 引用 ControlOp 在检查阶段拒绝。
2. op 最小契约与 broker：静态声明、握手核验、按 act 声明默认拒绝、效果预算、清理与对账接线；补 `dig`／`pickup` 与验证所需查询。
3. act 层：单文件、op 强制声明、不可变产物、`ActRef`、共享 runner（`role` 预留拆分）。
4. `decide` 与 policy：单一决策调用点、异步等待、纯桥、有界预算。
5. 运行时冻结项 F1—F8（见验证计划 §3.4）：分支切换等收尾、act 前完成检查、`ctx.fail`、查询时效与复用、查询期限、status 可读性、参数校验、取消期间拒绝新 act。
6. 冻结内核：G2 开始后不再增加命令类型或执行器分支。

**G2 验证**

- 四个场景：S1 拾取最近掉落物、S2 持续巡逻、S3 有限采集、S4 巡逻途中拾取再继续。
- 四个策略变体：最远优先、往返巡逻、达标后返程、目标失效即失败。
- 一组公共扰动：policy 等待中取消、取消与成功同批、unknown/过期、活动分支 policy 失败、清理失败。
- 指标与结论规则见验证计划 §7—§8。

**G3 结论（已完成）**

M5 阶段已完成，验证记录归档在 `docs/history/`。当前 behavior 表示为受限生成器协程，见 [BEHAVIOR.md](BEHAVIOR.md)。

**M5 遗留门槛**：隔离 S1—S7 与真实游戏公共扰动仍未执行，作为后续门槛保留。

退出条件：G1 的冻结集实现并通过测试；G2 的四个场景、四个反例、四个变体有明确结论且证据可复核；G3 结论与依据已记录；M4 链路在分层后回归通过；恶意/错误示例无法直接访问宿主能力（朴素攻击集），runner 失控时 broker 仍清理并拒绝未声明 op；隔离 S1—S7 与真实扰动补齐。

### M5.5：behavior 表示（已完成）

behavior 表示已确定并落地：受限生成器协程，见 [BEHAVIOR.md](BEHAVIOR.md)。

### 下一步：JS 运行时补齐与反应速度

1. **JS 运行时补齐**（启用前必须）：
   - `currentStep` 结构化（类型 + 目标），而不是裸字符串；
   - `ctx.progress` 进入 `p2_status`；
   - 有限 behavior 的完成检查点（成功/失败前统一走收尾校验）；
   - behavior 迁入隔离 runner（当前为进程内 `node:vm`）；
   - 时效策略：显式 `ctx.fresh()` 的默认值与检查点位置。
2. **反应速度**：按 [THREAT-REACTION.md](THREAT-REACTION.md) 实现 guard 条件切换、直接唤醒 owner 与低频轮询；guard 条件限 health/hostile/inventory/time。
3. **基线遗留**：`dig` 对脚下方块不收尾（`ACT_TIMEOUT`）、1 宽下台阶寻路不可用、`blocks` 计数截断早于过滤——先修或在 act 侧规避。

## 4. 验证矩阵

| 层 | 必测故障 | 不能借此声称 |
| --- | --- | --- |
| builder/checker | 语法/类型错、非法引用、循环构建、超预算、变更源码 | 策略合理、游戏一定成功。 |
| behavior/policy | 空集合、类型错误、未知值、`decide` 超时或非法返回、`fail` 传播 | 策略合理、目标可达。 |
| runtime | unknown guard、迟到响应、停止超时、冲突切换、旧epoch | 真实游戏驱动的停止已可靠。 |
| broker/provider | 未确认控制、部分成功、重复取消、连接丢失、thread延迟 | 玩家目标一定达成。 |
| bridge | scope清理、session错配、重复事件、DSH退出/重载 | 模型一定及时响应。 |
| 日志/队列 | 不可写、磁盘满、缓冲溢出、轮换、满载停止、旧 epoch 拒绝 | 日志完整、可靠落盘或崩溃后恢复。 |
| packaging | 单包 tarball 干净安装、项目 authoring 版本、依赖闭包、版本拒绝、回退 | 未测试平台或整合包兼容。 |
| game体验 | 有限/持续行为、协作、长期项目、偏好一致性 | 整局输入可确定性回放。 |

## 5. 明确保留的验证门槛

| 待验证项 | 当前方案 | 完成所需证据 |
| --- | --- | --- |
| Minecraft客户端接入 | Mineflayer首版验证已选；真实客户端为后续方向 | 固定测试版本、连接与授权条件，取得G0—G6证据；真实客户端另测驱动、模组交互与运行资源。 |
| 生成代码执行引擎 | 独立进程+受限JS上下文（act 走 op 桥，policy 走纯桥），候选需核验 | 中断/内存/能力桥原型与逃逸面审查；只承诺宿主能力、资源、账本三项，见[隔离设计](ISOLATION.md)；未完成不开放自定义 act／policy。 |
| behavior 与 policy 表达力 | 受限生成器协程 + `decide` 调用的 policy；长跑、打断与恢复为主要观察项 | 按实施阶段门槛执行，记录核心修改次数、策略归属、取消责任与可读性。 |
| 具体超时与数据年龄 | RUNTIME配置初值 | Windows及选定游戏组合的分位数和卡顿数据。 |
| DSH新版本兼容 | 源码核验 0.2.1-rc.2；安装端为 0.2.1-rc.3（卸载器版本），M0 以实际 runtime 为准 | 实际安装、命令、工具、session和HMR测试。 |
| Windows 托管进程生命周期 | 人工 start 后由插件持有 body，stdio 通信 | 正常 stop、热重载、DSH 异常退出、管道失效、runner 卡住和进程树回收实验。 |
| 发行格式与包管理 | 初版单包；`npm run bundle` 输出 tarball 到 `bundles/`，不发布 registry | 干净环境安装同一 tarball、项目 authoring 版本一致、offline 依赖与 Node 携带方式验证。 |
| 游戏专用schema | 只确定通用Query/Control契约 | 首批行为需求、所选provider真实可用数据。 |

独立 launcher、WS 鉴权、租约交接和跨连接恢复单列在[后续 WS 方案](WS-FUTURE.md)，不阻塞 stdio 首版。首版日志及队列按 D6 简化方案实现并测量初始额度；可靠落盘、持久索引/通知、日志修复和崩溃恢复明确延期。上述首版门槛仍需验证，不能跳过后声称成品可玩。

## 6. 本轮文档工作验证记录

本轮只进行文件/源码/安装元数据读取、官方资料研究、架构文档编写及文档一致性检查。没有执行DSH/游戏端安装、没有连接服务器、没有运行行为或模型集成测试、没有提交或推送Git。

本轮文档检查覆盖主文档及子文档，修复了 A02/A10 指向旧文件名的链接；代码围栏配对及行尾空白已检查。相对链接与章节锚点以当前工作区检查为准；外部链接的实时可达性不由本地检查器保证。两份Minecraft启动配置摘要与JAR内版本信息另作只读复核，与候选文档一致。

后续实施应在本文件或独立验收记录中逐项补充“版本、环境、步骤、观察结果”，不得用计划表替代测试证据。

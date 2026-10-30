# DSH 接入与插件生命周期

> 本文定义 DSH bridge 的接入方式、会话归属、工具注册、事件投递与插件生命周期，并说明宿主源码提供的能力边界。
>
> 关联：[主架构](ARCHITECTURE.md)、[协议](CONTRACTS.md)、[反馈](FEEDBACK-AND-RECOVERY.md)、[发布](OPERATIONS-AND-RELEASE.md)。

## 1. 源码核验结论

| 核验事实 | 对本项目的影响 | 本地证据 |
| --- | --- | --- |
| DSH 为 ESM，工作区使用 pnpm；声明 Node `^22.19.0 || >=24.0.0` | bridge按宿主支持环境构建，不依赖任意新Node特性 | package.json:2–10 |
| bundle 用 `dsh.bundle.patch` 指定一份或多份 Cordis patch | bridge可作为Host-only bundle交付 | packages/boot/app-boot/README.md:48–52 |
| `engines.dsh` 存在时优先决定兼容，DSH peers不再参与该兼容判定 | 显式写受测范围，不能以为两种声明共同收紧范围 | 同上:52 |
| Host插件安装可执行代码，影响当前profile的所有session | 不能宣传安装绝对零副作用；项目只保证默认不启动P2游戏工作 | packages/boot/plugin-manager/README.md:14、31 |
| 插件管理接受本地目录、registry、git或tarball等来源 | 首版使用本地构建的单包 tarball，不必先建独立仓库/市场 | 同上:44–54 |
| tools.register支持全局/agent局部作用域，返回准确disposer | P2工具按owner agent挂载，结束只释放自己的注册 | packages/core/tools/src/index.ts:1065–1096 |
| 命令运行不自动成为模型消息，但有session命令日志 | `/p2`管理动作与模型游戏工具分开 | packages/interaction/commands/README.md:11、31–45 |
| inject不唤醒；followup和steer会唤醒 | 先合并事件再投递，不把每tick都变成回合 | packages/core/agent/README.md:47；src/runtime-types.ts:214–241 |
| create/resume返回拥有agent teardown权的handle | 附着用户已有agent不等于拥有它，插件卸载不应销毁它 | packages/core/agent/README.md:31–44 |
| session header只在给定meta.cwd时写cwd | 插件不能假设省略cwd会自动归项目 | packages/core/session/src/index.ts:1165–1180 |
| workspace.attachSession校验header.cwd的realpath与项目目录相等 | 人工在正确项目创建session；不尝试自动“收养”会话 | packages/workspace/workspace/src/entity.ts:110–150 |
| working-directory可提供无原始目录会话的fallback；有效cwd与header项目分开 | “未分组会话一律无法推理”是过度推断 | packages/session/working-directory/README.md:25、41 |
| DSH运行时依赖解析在进程内安装，第三方Worker不会自动注入 | body/runner需要自己的依赖闭包，不继承宿主解析魔法 | packages/boot/app-boot/README.md:133–141 |

上述路径均相对本地DSH源码根。源码行号只对应此次快照；升级后需复查。没有把DSH源码仓库的内部包命名/发布规则强加给第三方P2仓库。

## 2. 接入拓扑与所有权

```text
人类 → DSH现有会话/agent
            ↕ scoped tools、已记录输入
        P2 bridge插件（进程管理）
            ↕ 协议层 → stdio传输适配器
        插件持有的P2 body子进程
            ├─ 独立调度、broker
            ├─ 构建进程／act runner
            └─ provider → 游戏连接/驱动
```

首版 body 保持独立进程和独立调度，但生命周期跟随 bridge 插件，不在宿主进程内执行行为树，也不等待模型逐动作响应。人类显式 /p2 start 后由 bridge 创建 body；不要求独立 launcher、监听端口、配对令牌或对常驻 body 重新附着。原 WS 及独立部署设计保留在[后续方案](WS-FUTURE.md)。

一个 body 只绑定一个由实际 DSH 上下文确定的 owner session。插件拥有自己创建的 body、构建进程及 runner 的回收责任，不拥有用户 agent 的 teardown 权。换 session 时先关闭旧 body，再在新 session 人工 start，不实现运行中的 owner 交接。必须确认旧进程树已回收；存活进程已知的控制故障仍要处理。全进程崩溃后不自动重建旧账本，开发者需核查未确认的游戏效果，不能仅因进程消失就认定停止成功。

## 3. 插件默认状态与人工命令

安装、启用、加载或热重载插件只注册管理命令和配置，不自动创建 body 或其他 P2 辅助进程、不连接游戏、不注册可执行 P2 模型工具、不排模型回合。人工 start 才开启托管进程生命周期；新 body 不自动开始 behavior，也不重放旧命令。插件加载本身仍执行宿主代码，不宣称绝对零副作用。

| 命令（建议名称） | 行为 |
| --- | --- |
| /p2 setup | 建立/核验项目与源码、artifact 配置；不默认 git init、不启动子进程或安装游戏驱动。 |
| /p2 start | 校验当前 agent/session 项目归属，创建 body、握手并同步状态，再注册该 owner 的工具；已启动时不重复创建进程。 |
| /p2 status | 显示启动/关闭阶段、owner、binding、运行与故障；未启动时显示 inactive，不自动启动。 |
| /p2 stop | 注销普通调用入口，请求 shutdown，停止并确认收尾、关闭 body 及辅助进程，移除工具与订阅。 |
| /p2 shutdown | 首版可作为 /p2 stop 的别名，不引入另一种常驻服务生命周期。 |

模型工具 stop 仅停止指定 behavior，body 保持可用；人工 /p2 stop 关闭整个托管 body，两者必须在界面上区分。游戏连接由 provider 及人工 start 所授权的配置管理，行为启动仍须显式 switch。

显式人工命令不等于任意目录权限。用户取消命令等待只代表不再等待，不证明停止完成；管道仍有效时查询 commandId，已断开则由存活界面尽力标明结果未知，不保证记录持久保存，也不自动重启。

## 4. 启动与关闭状态机

`inactive → starting → active → stopping → inactive`；启动/退出失败保留 failed 或 stopping/faulted 及诊断，不伪装成成功关闭。

启动顺序：

1. 从命令上下文取得真实 agent/session，核验原始项目与配置项目；同一插件实例只允许一个托管 body，重复 start 合并或返回已有状态。
2. 用固定可执行入口和参数启动本地 body，建立专用管道；不使用可见控制台窗口，不通过 shell 拼接命令，也不监听网络端口。
3. hello 协商协议、绑定 owner，获取 bodyEpoch、角色与当前 binding。握手须有界；失败则关闭本次进程树，不保留可调用工具。
4. 启动独立于模型回合的 heartbeat，获取 status/事件游标，核验当前连接与控制健康；不从旧日志恢复运行或控制账本。当前已知控制故障时只显示诊断，不启动动作。
5. 同步状态后注册当前 owner 的局部工具并声明 active；过程不自动 switch 或调用模型。

关闭顺序：

1. 人工 stop、插件卸载或热重载时关闭普通工具入口，保留内部状态查询和收尾通道。
2. 通过 shutdown 请求停止当前 run、清空 pending、完成 act/broker 收尾，关闭游戏连接及 runner/构建进程，再退出 body；不能在收尾前直接关闭通信作为正常路径。
3. 正常完成须取得收尾结果并回收托管进程。插件重载完成后保持 inactive，等待下一次人工 start。
4. 宿主崩溃、管道 EOF/写端失效或存活超时由 body 自行进入清理退出。管道丢失不等待重连；首版重新 start 创建新 bodyEpoch。
5. 进程树退出必须有界；平台回收机制和期限须在 Windows 原型中验证。必要强制结束时尽力显示 interrupted/结果未知，不要求可靠落盘；不能将强杀或进程退出称为游戏停止证明。

stdout 只供协议，stderr 统一日志并持续消费。辅助进程不得继承 bridge—body 管道而妨碍 EOF 检测；日志和输出背压不得阻塞控制清理。插件 dispose 回调不保证必有充足清理时间，须以管道关闭、heartbeat 和进程树回收实验共同验证，不能仅凭父子关系宣布回收可靠。

bridge 不创建/恢复用户 agent，不改 session header，不自动 fork/move 项目。原始项目不匹配时拒绝 start；无 header.cwd 即使可在 DSH 工作，也不符合本项目绑定政策。

## 5. 模型工具与界面反馈

工具只在 active 的 owner agent 可见：observe、status、check、activate、switch、stop、confirm、guard、watch、events、snapshot、trace 等，名称以最终 SDK 为准。check 需要显式区分 `artifactKind`（behavior／act／policy／op）；op 可在当前 binding 激活使用（开发阶段），policy 不单独 activate。源码编辑复用 DSH 工作区能力；进程启动、shutdown 和驱动原始调用不暴露给模型（临时 `p2_body` 开发入口除外）。

工具分层约定：

| 工具 | 用途 | 返回 |
| --- | --- | --- |
| `p2_status` | 全量状态（run、guard、watch、provider、观测摘要） | 结构化 JSON |
| `p2_card` | 高频轮询用的紧凑状态卡（run 摘要、health、位置、附近敌对、guard/watch 计数） | 小对象 |
| `p2_observe` | 单次 QueryOp | `{ value, meta }` |
| `p2_snapshot` | 批量观测（position/health/inventory 摘要/blocks/entities），逐项 meta 与 partial | `{ parts, partial }` |
| `p2_trace` | dev-only 有界执行轨迹（run/act/op/guard/watch 时序与耗时） | 事件数组 + 统计 |
| `p2_guard` | 多 guard set/clear/status | guard 摘要 |
| `p2_watch` | watch add/remove/list/clear | watch 摘要 |
| `p2_events` | 游标读取 guard/watch/run 事件 | 事件数组 + gap/dropped |

当前阶段限制必须对 agent 明示：哪些内容类型允许编写与检查、哪些允许启用、隔离引擎门槛是否已通过、`imported` 是否允许。能力清单与阶段限制随 status/describe 返回，不能只写在文档里而让 agent 试探。

`p2_snapshot` 与 `p2_card` 都只发出**一次** body 往返；`inventory` 计数、实体敌对计数等摘要由 bridge 纯函数生成（纯函数定义见 `src/bridge/summaries.ts`），不新增 provider 查询语义。批量观测逐项返回 `status/value/meta`，单项失败或未完成只影响该项并把整体标为 `partial`；未知保持 `null`，不折成 0 或空数组。`p2_watch` 只有登记/撤销/查询入口，没有停止或切换控制。

工具声明参数与输出schema，输出同时包含结构化结果和可读摘要。switch返回accepted+commandId，不能渲染为“已开始/已完成”。停止超时展示控制权未释放，不能用一个普通失败卡片掩盖。

confirm 明确指定 bodyEpoch、runId、confirmationId 和 commandId，并提交确认或否定及依据，不隐式操作“当前任务”。bridge 根据实际入口提供可信来源：模型工具调用记为 agent 判断，只有可核验的人类交互入口才记为玩家确认。模型声称“玩家同意”、环境文本或行为源码均不能提升来源；尚未实现玩家入口时仅记录 agent 判断。body 仍须校验当前 owner 授权及请求归属，来源字段不替代鉴权。

界面区分“待外部验收”“agent 判断通过”“玩家确认通过”“外部否定目标”和“确认命令被拒绝”。同一有效管道上可通过 status 取回同一请求；管道关闭后旧 run 随关闭流程结束，未取得结果时存活的 bridge 显示结果未知，新 body 不恢复请求。已关闭请求不因旧通知重现。暂时无法判断就继续等待；确认或否定结束原 run，补做工作另起新 run。accepted 不等于验收完成，规则见[运行时外部验收](RUNTIME.md#44-外部完成验收)。

PTC调用这些工具时，也必须经过相同body owner、binding和控制权验证。DSH工具并发额度不赋予P2并行act能力；并发switch请求在body串行处理。

工具注册以人工 start/关闭为单位，不随每次 behavior 增删。工具 schema 保持小而稳定，能力清单与编写参考按需读取；缓存效果需后续测量。

## 6. 事件进入session

执行器事件经 bridge 有界内存队列去重/合并。guard/runtime 事件在 owner `running` 时用 `steer` 投递到下一 step，idle 时用 `followup` 开新 turn；watch 事件在窗口内合并为一条摘要，running 时用 `inject` 附带、idle 时用 `followup` 唤醒。首版无持久 pending 队列，插件退出后不恢复未投递通知。人类消息沿 DSH 原路径，不由 bridge 复制一份。

`p2_events` 是执行事件流（guard/watch/fault/restart），周期 status 与 run 生命周期不入队，当前状态用 `p2_status`/`p2_card`、run 轨迹用 `p2_trace` 读取；`dropped` 是本次 drain 的丢弃数，`droppedTotal` 是累计值。

`inject()`只是不立即唤醒，不代表内容永远不消耗token：进入下一次模型请求仍有上下文成本。成功调用不等于模型已经看到；当前进程内按批次跟踪，首版不从 session/调试日志自动恢复投递状态。[反馈文档](FEEDBACK-AND-RECOVERY.md)定义有界事件队列、可能重复与缺口处理。

默认不因每条进度调用steer。控制故障先由body隔离，通知用于说明和后续安排；不能借频繁取消DSH回合充当实时控制器。bridge只能取消自己明确拥有的排队意图，不取消用户agent的其他工作。

## 7. 会话、记忆与DSH job

P2策略统一叫behavior，DSH job保留为宿主后台事务。检查编译等长工作可按宿主已支持的后台任务方式呈现，但DSH job的结束不意味着游戏behavior结束；二者必须用不同id关联。

首版每次游玩人工选择现有 session，显式 start 后固定该 body 的 owner。会话交流及显式目标文件仍可由宿主/项目保存，运行记录和通知仅在内存管理，调试日志不作为恢复依据；换 session 先关闭旧 body，再人工启动新 body。长期目标与偏好存项目文件，session 承载本次交流与工作上下文。

AGENTS.md只放简短身份、工作目录与边界，编写behavior／act／policy的长参考可放项目skill。具体DSH skill扫描范围在实施时复查，不把整份架构文档每轮注入。

## 8. bundle 与依赖发布

首版采用单包交付：一个 npm 包同时包含 DSH bridge（Cordis 入口）、body（stdio 子进程入口）、内置 Mineflayer provider、operation 声明、authoring 子路径和预设 behavior／act／policy。包内按目录分层；bridge 不 import core/body/provider，body 仍是独立进程。`package.json` 保留 `dsh.bundle.patch` 字段并指向包根的 `cordis.patch.yml`；`files` 只包含构建产物、manifest、patch 和显示元数据，不发布 `src` 或测试。初版使用本地私有包名，发布前再定 scope，不假称官方 `@deepseek-ai` 包。

bundle patch 新增插件必须写在 `insert:` 下；顶层带 `id` 的行用于覆盖已有 entry，直接写会报 `entry not found`。当前 patch 形如 `- insert: - id: dsh-minecraft-p2 / name: dsh-minecraft-p2`。

bridge 对 DSH/Cordis 使用宿主兼容的 peer 依赖，并显式声明经过验证的 `engines.dsh` 范围。不要把第二份宿主核心打入 bridge；初版以实际安装 runtime 的版本为准，M0 实测后固定。当前不能据此承诺整个 0.2 系列或未来版本均兼容。

body 与 provider 随包交付，但 body 不引用 DSH 安装目录内部文件、不依赖 profile runtime resolution；provider 只在 body 内通过 registry 加载。DSH 通过插件经理安装该包；项目以 devDependency 安装同一 tarball 以获得 authoring，版本必须与 body 所在包一致。初版不发布 registry，本地用 `npm run bundle` 输出 tarball 到 `bundles/`。

安装成功、插件已加载、body 已创建、协议已就绪、behavior 已启动是不同事实。HMR 与宿主重启后不自动 start；更新该包前正常关闭并确认清理。

首版验证插件托管入口、单包 tarball 安装、Node 运行时及依赖闭包、Windows 进程树回收和离线安装。独立 launcher 与 WS 保留到后续阶段，不作为首版交付前提；后续拆 bridge/body/provider/authoring 时保持协议、manifest 与包名。

## 9. 对原调查的修正

| 原表述 | 本架构采用的限定 |
| --- | --- |
| MCP只有请求，不能表达通知/控制权 | 不将此作为协议不可能性结论；本项目选择bridge以便会话唤醒和生命周期集成，控制权仍是应用层协议。 |
| 必须Fabric客户端或服务端mod | 已选独立客户端路线，初版用 Mineflayer 验证；客户端驱动与服务器角色分别保留为后续方向与历史方案。 |
| 未分组会话半瘫痪、一定不能推理 | DSH有fallback cwd；项目拒绝不匹配session是本项目政策。 |
| 插件卸载即teardown agent | 仅插件创建并持有handle的agent可由其销毁；本项目附着现有agent，不拥有其生命周期。 |
| 注入免费 | 不唤醒不等于没有后续上下文token成本。 |
| 环境危险自动触发模型 | P2不记录环境变化事件；运行失败/受阻可请求决策，危急反应来自现有behavior。 |
| body完整日志保证整局回放 | 首版日志仅供尽力调试，可能缺失尾部或被轮换；不保证完整轨迹、崩溃恢复或整局确定性回放。 |
| setup默认git init | 本项目不把Git初始化作为运行前提；若宿主项目识别确需配置，由人工明确处理。 |

## 10. 接入验收

1. 安装/启用单包后没有body/游戏连接与P2模型工具；管理命令可用。
2. 正确 session 可人工 start；目录不匹配、非 owner 调用或旧 epoch 请求被拒绝，其他 session 看不到可写工具；重复 start 不创建第二个 body。
3. 工具返回的accepted/started/terminal可区分，PTC并发不绕过单act规则。
4. HMR/dispose 关闭本插件的 body、runner/构建进程及工具，不销毁用户 agent；重载后保持未启动。
5. 正常 stop、DSH 异常退出、stdin EOF、stdout 失效、心跳超时及 runner 卡住均进行进程树/控制清理验证；强制结束不误报游戏停止成功。
6. 当前进程内事件去重、缓冲超限提示缺口；插件退出不恢复未投递通知，不承诺跨崩溃不丢失，也不制造无限模型回合。
7. confirm 指定请求且模型无法伪装玩家；同一存活 body 可查询待确认记录，新 epoch 不复活旧请求，重复决定不重复发终态事件。
8. stdout 无日志污染，JSON Lines 可拆包/合包且限制未完成缓冲；stderr 持续消费，输出背压不阻塞收尾。更换测试用内存传输不改变协议处理规则。
9. 从干净环境安装 `bundles/` 中的单包 tarball，验证 DSH peers、项目 authoring 版本一致、第三方依赖及 runner 解析。
10. 与已核验DSH版本及下一候选版本分别跑集成测试后，才扩展兼容范围。

本次仅阅读源码和写设计，以上尚未执行。原始调查保留供追溯，出现冲突时按主架构、本文源码限定及当前版本验证结果处理。

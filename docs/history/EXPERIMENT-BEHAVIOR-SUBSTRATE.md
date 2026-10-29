# behavior 表示方式对照实验（IR vs 受限 JS）

> 状态：**计划中，未开始**。当前主线仍是 behavior IR；JS 方案见 [../BEHAVIOR.md](../BEHAVIOR.md)。
> 本文记录实验目标、共享基线、分支与安装方式、实验协议、判定标准与下一步。实验结论出来前，不改变 `ARCHITECTURE.md §5.1` 的现行决定。

## 1. 为什么要做

M5 的 G3 判定为“继续采用小 IR”，但那只证明了四个简单场景。现在的真实问题是：

- 在 **agent 作为决策者、behavior 作为有界策略** 的架构下，IR 的表达力与作者效率能否支撑长期生存、采集、合成、建造、协作与末影龙阶段？
- 如果 IR 需要不断加节点/表达式，或策略被迫塞进 policy/act，是否不如换成受限 JS 协程？

这不是“IR 是否图灵完备”的问题，而是 **复杂度放在哪里、谁能写、写得多快、是否可观察/可控制** 的问题。

## 2. 实验问题

| 编号 | 问题 | 判定证据 |
| --- | --- | --- |
| Q1 | IR 能否在不改核心（或只加少量领域无关原语）的情况下表达实际策略？ | 每个策略是否需要核心/运行时修改；改动清单与次数。 |
| Q2 | JS 是否显著降低 subagent 的作者成本？ | 从规格到可运行的耗时/token/迭代次数；checker 与运行时错误。 |
| Q3 | 哪种 substrate 在长跑、打断、取消、恢复下更稳、更可观察？ | 长跑策略的稳定性、卡住、清理、status 可用性。 |
| Q4 | 哪种 substrate 的潜力与扩展性更好？ | 新策略的表达上限、复用/组合、维护局部性、是否出现“巨型 act/policy”。 |

**不作为判定指标**：死亡次数、通关速度、单位时间收益。它们受世界随机性与操作水平影响，不能回答 substrate 的潜力问题。

## 3. 计划（0—7）

| 步骤 | 内容 | 产出/门槛 |
| --- | --- | --- |
| 0 | 写实验协议与判定标准（本文）；写 JS 架构草案（../BEHAVIOR.md） | 两份文档可评审；问题/证据/边界固定 |
| 1 | JS 架构初值已确认（完成证据、时效、取消、policy 内联、artifact 形态），见 [../BEHAVIOR.md §10](../BEHAVIOR.md) | 初值记录为“实验期决定”，不是最终契约 |
| 2 | 完成共享基线：op、provider、broker、act/policy runner、body/bridge、status/observability | 基线功能清单；`npm run check` 绿 |
| 3 | 冻结基线：打 tag `m5-baseline`；确认 smoke 清单与日志模板 | 基线 tag；smoke 脚本/清单 |
| 4 | 从基线拉两个分支：`exp/behavior-ir`、`exp/behavior-js` | 两分支都能 build/check/跑 smoke |
| 5 | 两边 bundle 安装验证：同包名、不同版本、一次装一个 | 桌面 DSH 中工具可见、body 可连、smoke 通过 |
| 6 | 生存实验：真实世界、基本 behavior/act 起步、过程中写新策略 | 每分支至少两组 session；日志与证据 |
| 7 | 决策：写 memo，确认合并/归档 | 结论 + 合并到 `dev` + 文档更新 |

## 4. 共享基线

**共享（两分支一致）** —— 基本 op/act 与 smoke 的具体清单见 [BASELINE-OP-ACT-SMOKE.md](../BASELINE-OP-ACT-SMOKE.md)。

- `src/contracts`：IR/act/policy/op/错误/摘要/协议（JS 分支只加 behavior artifact 形态）。
- `src/operation`：QueryOp / ControlOp 声明与契约。
- `src/provider`：Mineflayer 实现、能力声明、连接生命周期。
- `src/core` 的 broker、控制账本、act/policy 端口、取消/收尾、时效与预算机制。
- `src/body`、`src/bridge`：工具面、命令、status 字段、安装/启动/停止。
- act/policy 的检查器、隔离 runner 的通用部分。
- 观测层：查询结果、摘要、status 字段。

**分支私有**

- IR 分支：节点/表达式/执行器语义的扩展（如确实需要 `forEach`/`call`/`waitUntil`）；每次扩展记为成本。
- JS 分支：`behavior` artifact 契约、runner 的 behavior 角色、`JsBehaviorRun` 驱动、step 协议。
- 两边都不能私改 broker / op / provider 的语义来“帮助”自己的 substrate；共享缺陷走 `dev` 修复并同步两边。

**基本模块清单（基线前置）**

- QueryOp：position、inventory、entities、block、time、区域方块扫描（采集/探索所需）。
- ControlOp：look、move、jump、moveTo、stop、dig、place、attack、use、container/trade（按需要）。
- act：move-to、mine-one、place-block、attack、follow/escort、craft（按需要）。
- policy：选择、计数、距离、威胁判定等纯函数。
- 工具面：check/activate/switch/observe/status/stop；status 含当前步骤/目标/waiting/progress/lastFailure/lastRun。

> 基本模块只保证“能开始实验”，不追求覆盖所有游戏机制；实验中新需要的 act 只实现一次，两边共用。

## 5. 分支与安装

- 分支：`exp/behavior-ir`、`exp/behavior-js`，均从 `m5-baseline` tag 拉出。
- 共享修复：在 `dev` 修复后合入两个分支；两个 exp 分支之间不互相合并；分支分叉点与共享提交记录在实验日志。
- 建议使用两个 worktree，避免来回切换工作区；实验时一次只激活一个分支的 bundle。
- bundle：**同包名、不同版本、一次装一个**（例如 `0.2.0-exp-ir.1` / `0.2.0-exp-js.1`）；记录版本、tarball 摘要、commit。
- 切换流程：`/p2 stop` 或人工停 body → 卸载旧 bundle → 安装新 bundle → 启动 body → 验证工具可见 → smoke。切换时间与异常入日志。
- 桌面 DSH 是目标环境（不是 `npm run dev` 的 web）；实验期间允许启动新 session，但必须在本 profile 下，工具面以安装的 bundle 为准。

## 6. 实验协议

**环境**

- 正常生存世界；同一 seed、同一初始条件；每个分支开始前做世界快照/备份。
- 同一 Minecraft 版本、LAN 端口、provider 配置、operator 账号。
- 同一套基本 act/op/policy；同一个 agent（DSH）操作；subagent 负责写新 behavior/act。

**过程**

1. 每个分支至少两组 session，目标相同（例如：木/石工具 → 庇护所 → 铁 → 一次 escort 或长距离采集）。
2. 只给基本 behavior/act 起步；实验过程中必须写新策略；新 act 只实现一次并共用。
3. 两个分支交替进行（IR → JS，再 JS → IR），减少学习效应；记录顺序。
4. 至少包含：一次长跑不切换（escort 或大范围采集）、一次频繁打断（采集 + 威胁）、一次需要新 act 的策略、一次需要新 behavior 的策略。
5. 遇到共享基线缺陷：在 `dev` 修复并同步两边，记录为“基线问题”，不计入 substrate 失败。
6. 遇到某分支需要核心/运行时改动：记录改动内容、次数、耗时；这是该 substrate 的成本，不阻断实验。

**日志模板（每个策略）**

| 字段 | 内容 |
| --- | --- |
| 规格 | 目标、输入、成功/失败条件、预期时长 |
| substrate | IR 或 JS；artifact/节点数/代码行数 |
| 作者 | subagent 标识；耗时/token；迭代次数 |
| 检查 | checker 错误、修复轮次 |
| 运行 | 成功/失败/取消；关键事件；卡住与恢复 |
| 改动 | 是否需要核心/运行时修改；内容与耗时 |
| 复核 | 独立 agent 四问（阶段/目标/下一步/失败出口） |
| 备注 | 策略泄漏（act/policy 变大）、复用、可维护性 |

## 7. 公平性规则

- 两边工具面、status 字段、错误码尽量一致；差异必须记录，不能把“工具差异”算成 substrate 优势。
- 新 act 只实现一次，两边共用；不能一边靠更多 act 取胜。
- 两边都遵守三级边界：behavior 不碰 ControlOp；act 不做长期策略；policy 不做全局规划。
- JS 分支允许内联纯计算，但要记录“内联替代了 policy”的次数；IR 分支允许加领域无关原语，但要记录每次核心改动。
- 禁止把策略塞进 act/policy 来“省事”；发现即记录，并在判定时作为该 substrate 的泄漏成本。

## 8. 判定

- 我（DSH）在两个分支实际操盘后写决策 memo；不设死亡/时间硬指标。
- 证据类别：表达上限、作者循环、长跑稳定性、组合复用、可观测性、安全性、维护局部性、agent babysitting。
- 结论选项：**沿用 IR / 转受限 JS / 混合**；混合必须给出边界与双维护成本，不能只写“两者结合”。
- 你确认后：胜者合并到 `dev`；败者归档不删除；共享资产（op/act/policy）可移植，behavior 内容不强行移植。
- 若 JS 胜出：同步修订 `ARCHITECTURE.md §5.1`、相关 decision 与验收；若 IR 胜出：记录“作者效率为何没有输”的证据。

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 分支漂移 | 共享修复只走 `dev`；记录分叉点；定期同步。 |
| 安装/打包问题污染结论 | 两边先过同一 smoke；安装失败先修复再实验。 |
| 学习效应/agent 偏见 | 交替顺序；同一目标；subagent 独立；日志对照。 |
| “潜力”判定主观 | 按证据类别记录；memo 引用具体案例与改动清单。 |
| JS 生命周期/安全风险 | 统一 driver、step 超时、取消、ctx 白名单；实验期不外推第三方安全。 |
| 时间成本 | 每分支设 session 上限；先完成基本模块再开始；不在实验中追求通关。 |

## 10. 当前状态

| 项 | 状态 |
| --- | --- |
| 实验协议 | 本文（草案） |
| JS 架构 | [../BEHAVIOR.md](../BEHAVIOR.md)（§10 初值已确认；JS 分支原型已实现，PASS 19/19） |
| 共享基线 | 清单已整理（[BASELINE-OP-ACT-SMOKE.md](../BASELINE-OP-ACT-SMOKE.md)）；实现未开始 |
| 基线 tag | 未创建 |
| 两分支 | 已创建；IR 分支 smoke PASS 19/19，JS 分支 smoke PASS 19/19 |
| 桌面 bundle 安装 | 未验证 |
| 实验 | 未开始（分支实现与 smoke 已完成） |

## 11. 下一步

1. ~~评审并确定 ../BEHAVIOR.md 的待定问题（§10）~~（已确认，2026-10-28）。
2. 按 [BASELINE-OP-ACT-SMOKE.md](../BASELINE-OP-ACT-SMOKE.md) 完成共享基线与基本模块，跑通现有测试。
3. 打 `m5-baseline` tag，写 smoke 清单与日志模板。
4. 创建两分支，分别实现 IR 扩展与 JS 驱动。
5. 两边 bundle 安装到桌面 DSH，验证工具面与 smoke。
6. 开始生存实验，记录日志。
7. 写决策 memo，确认合并。

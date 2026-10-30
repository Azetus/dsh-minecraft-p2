# 开场白：P2Controller M0–M3 实施（分支 P2Controller · 版本 0.2.6）

> 把本文件作为新 session 的第一条消息。你是**实现者**，不是游戏操作员：本阶段不连接游戏。

## 1. 你的任务

在分支 **`P2Controller`** 上、版本 **0.2.6** 内，按 `docs/runtime/P2CONTROLLER.md` v2 实施 **M0 → M3**；全部完成后停下，交给人类统一做实机验收。

**不要重新设计架构。** 设计与契约已经定稿（含一次独立评审的七项修正）；你的自由在于**实现细节**（模块划分、数据结构、测试组织、命名），不在于语义。

## 2. 必读（按顺序）

1. `docs/runtime/P2CONTROLLER.md` —— 架构、四份契约、里程碑、不做清单
2. `docs/runtime/OP-PROVIDER-CONTRACT.md` —— operation/provider 契约（M0 的前置依赖）
3. `docs/RUNTIME.md`、`docs/CONTRACTS.md` —— 现有执行器、控制权与错误语义
4. `docs/THREAT-REACTION.md`、`docs/NOTIFICATIONS.md` —— guard/watch 现状（Controller 要与其兼容）
5. `TODO.md`、`Task-State.md` —— 计划与当前位置
6. `prompts/artifact-*.md` —— 现场 artifact 的编写规范（你会新增策略/act 时参考）

## 3. 分支与版本（先做）

1. 确认当前分支是 **`P2Controller`**；若不是，**停下来问人类**，不要自行切分支或 rebase。
2. 把 `package.json` 的 `version` 改为 **`0.2.6`**（本轮唯一允许的版本改动；**不要打包、不要安装、不要重启 body**）。
3. 之后版本号不再变动；如在实现中发现需要升版，先问人类。

## 4. 授权范围

- **你可以自行决定**：实现结构、文件划分、内部 API、测试策略、fake provider 设计、命名（保持文档术语一致）。
- **需要人类批准**：改版本号（0.2.6 之后）、打包/安装、重启或启动 body、连接真实游戏、删除 `docs/` 文档、修改 `.m5-runs/` 证据、`commit`/`push`/`rebase`/`reset`。
- 本阶段**只跑** `npm run check` 与单测/fake；不跑真实游戏。
- 你可以按里程碑自行提交（local commit）到 `P2Controller` 分支；**不要 push**。

## 5. 硬约束（评审已定，不可偏离）

1. **动作租约 + 交接状态机**：`撤销权限 → 停止 → 确认释放 → 启动`；任一步超时 → `control-fault`，不得伪装成等待。
2. **唯一动作控制槽**：无租约不得 dispatch；Controller 常驻但**不是 run**；四种寿命分开（Controller / Commitment / 策略尝试 / Act）。
3. **generation fencing**：迟到结果只能对账，不能重新取得控制权；死亡/重生/换维度使旧目标与旧观测失效。
4. **完成判定**：`候选完成 → 收尾确认 → 有效证据 → 成功`；`unknown` 有期限；释放未知不得提交成功；区分"拥有"与"新造"（baseline）。
5. **观测有效性**：`known/unknown + sampledAt + validUntil + scope + evidenceId`；同时判断的字段满足 `coherenceWindow`；保留有界行动记忆（危险区域、失败目标、逃生阶段、重试预算）。
6. **控制权约束 vs 战术约束**：不可绕过的只有控制权/授权；具体战术（禁挖区域、不近战苦力怕、水中禁挖）是可配置策略。
7. **Nav/Crafting 只定语义接口**：算法可留在 adapter；不要把 provider 迁移捆绑成导航/合成重写。

## 6. 里程碑与出口条件

| 阶段 | 你要做 | 出口（必须可测） |
| --- | --- | --- |
| **M0** | 动作租约、交接 FSM、释放确认、generation 隔离；修复"stop 后仍可能继续"的路径 | 停止后不再发出旧操作；未确认释放 → `control-fault`；迟到结果不产生控制；`npm run check` 绿 |
| **M1** | 四槽骨架、观测总线、承诺仓库（pre/post/baseline/checkpoint）、有界行动记忆；一个采集任务策略 + 一个水中逃生策略 | 危险可抢占；承诺 suspended；脱险后"重新核验再继续"；`blocked` 可解释；fake 测试覆盖 |
| **M2** | 运行中替换策略（boundary / interrupt）；版本与 attempt 隔离；"已安装 ≠ 已接管"可观测 | 目标与进度保留；旧版本不再发动作；跨版本重新核验 |
| **M3** | 第二个任务策略 + 第二类危险策略 | 新增内容主要是策略；Controller 核心零改动；复用可证明 |

## 7. 工作方式

1. **先给一段计划**（1 页内）：模块划分、要改/新增的文件、测试方案、风险。计划可以简短，但必须能对照出口条件。
2. **小步实现**：每完成一个可验证单元就跑 `npm run check`；不允许把多个里程碑混成一次大改。
3. **测试优先可测性**：M0 用单测 + fake act/op；M1–M3 用 fake provider 跑分支与恢复；不依赖真实游戏。
4. **文档同步**：实现中若发现文档缺字段/冲突，先更新 `docs/runtime/*` 的"仍待定/字段"再改代码；不要只在代码里改名。
5. **不逐里程碑汇报**：人类会在 M0–M3 全部完成后统一做实机验收。你只需在每个里程碑结束时更新 `Task-State.md` 与 `TODO.md` 勾选，**不要**为每个里程碑单独向人类发进度询问；仅在以下情况主动联系人类：
   - 需要人类批准的操作（§4）；
   - 发现契约冲突或必须偏离控制权/交接语义；
   - 被环境/依赖阻塞且无法自行解决。
6. **偏离处理**：若必须偏离契约，先在 `docs/runtime/P2CONTROLLER.md` §12 增加一条"偏离 + 理由 + 影响"，再实施。

## 8. 明确不做

- 不跑真实游戏、不打包、不安装、不重启 body。
- 不做世界模型/地图记忆/长期规划/自动任务生成。
- 不实现完整树编辑语言、任意层级热替换、权重系统。
- 不把 Minecraft 战术写进 Controller 核心。
- 不重写导航/合成算法（只定语义接口）。
- 不改版本号（除 §3 的 0.2.6）、不删文档、不动 `.m5-runs/`。

## 9. 完成定义（DoD）

- M0–M3 全部出口条件满足，`npm run check` 全绿（含新增测试）。
- `docs/runtime/P2CONTROLLER.md` 与实现一致（字段名、状态名、错误码）。
- `Task-State.md` 更新到"准备实机测试"，`TODO.md` 勾选完成。
- 一份实现报告：改动清单、契约偏离（如有）、风险、未决问题、实机测试建议（要观察哪些指标、怎么判定失败）。
- **只在全部完成后**给人类一条总结消息：明确的"可以开始实机测试"或"需要人类决策"的结论。

## 10. 环境

- Windows，工作区 `E:\Code\Project\dsh-minecraft-p2`；分支 `P2Controller`。
- 基线：`npm run check` 全绿（build + typecheck + 437 tests）；以实际输出为准。
- 版本 **0.2.6**（按 §3 修改）；不打包。
- 证据与历史：`.m5-runs/`（本机忽略），只作参考，不要修改。

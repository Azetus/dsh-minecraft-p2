# 文档目录规则

- `docs/` 下的文档描述项目**当前**状态、契约与计划；读到它们就应当知道项目现在是什么样。
- 运行时设计在 `docs/runtime/`，当前唯一入口是 [P2Mind](runtime/P2MIND.md)；面向 agent 的操作指令在仓库根的 `prompts/`。
- `docs/history/` 存放里程碑记录与**已结束/已废弃**的设计，仅供回顾；**当前文档不得引用 history**。
- 文档不记录决策过程（"经过某次实验决定……"属于 `history/`）；当前文档只写"是什么、为什么这样定"。
- 阶段收尾时，把该阶段记录移入 `history/`，并在同一次提交里更新 `docs/` 下的当前状态。

## 索引

| 文档 | 内容 |
|---|---|
| [../README.md](../README.md) | 项目定位、当前状态、目标用法 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 进程边界、分层、目录、生命周期 |
| [runtime/P2MIND.md](runtime/P2MIND.md) | P2Mind 控制结构（权威设计） |
| [CONTRACTS.md](CONTRACTS.md) | ClientPort / Job / WorkGiver / Driver / Tracker / 树的契约 |
| [RUNTIME.md](RUNTIME.md) | tick 循环、预算、失败与恢复 |
| [OPERATOR-PLAYBOOK.md](OPERATOR-PLAYBOOK.md) | 操作员/agent 的运行纪律 |
| [DEPENDENCIES.md](DEPENDENCIES.md) | 依赖与版本 |
| [history/](history/) | 归档（已废弃设计，仅供回顾） |

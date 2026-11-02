# 文档目录

`docs/` 下的文档描述项目**当前**状态、契约与实现边界；读到它们就应当知道项目现在是什么样。

- 运行时设计在 `docs/runtime/`，当前入口是 [P2Mind](runtime/P2MIND.md)。
- 面向 agent 的操作提示词在仓库根的 `prompts/`。
- 当前文档不引用已废弃设计；不在仓库中保留历史归档。
- 文档只写“是什么、为什么这样定”，不记录决策过程。

## 索引

| 文档 | 内容 |
|---|---|
| [../README.md](../README.md) | 项目定位、当前能力、用法 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 进程边界、分层、目录、生命周期 |
| [AUTHORITY.md](AUTHORITY.md) | Agent/P2 决策权二分与新增行为评审清单 |
| [runtime/P2MIND.md](runtime/P2MIND.md) | P2Mind 控制结构（权威设计） |
| [runtime/MOTION.md](runtime/MOTION.md) | 运动模块：规则集、规划器、执行器、战斗控制器 |
| [runtime/PITFALLS.md](runtime/PITFALLS.md) | 踩坑清单与实现红线 |
| [CONTRACTS.md](CONTRACTS.md) | ClientPort / Job / WorkGiver / Driver / Tracker / 树的契约 |
| [RUNTIME.md](RUNTIME.md) | tick 循环、预算、失败与恢复 |
| [OPERATOR-PLAYBOOK.md](OPERATOR-PLAYBOOK.md) | 操作员/agent 的运行纪律 |
| [DEPENDENCIES.md](DEPENDENCIES.md) | 依赖与版本 |

# 文档目录

`docs/` 下的文档描述项目**当前**状态、契约与实现边界；读到它们就应当知道项目现在是什么样。

- 运行时设计在 `docs/runtime/`，当前入口是 [P2Mind](runtime/P2MIND.md)。
- 面向 agent 的运行提示由 body 启动时注册的 `skills/p2-operator/SKILL.md` 及 `skills/p2-*` 提供；仓库根不再保留独立 prompt 文件。
- 当前索引只列当前文档；显式标注历史快照的文件不作为当前契约。
- 文档只写“是什么、为什么这样定”，不记录决策过程。

## 索引

| 文档 | 内容 |
|---|---|
| [../README.md](../README.md) | 项目定位、当前能力、用法 |
| [../AGENT.md](../AGENT.md) | 开发协作指南、架构边界与验证要求 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 进程边界、分层、目录、生命周期 |
| [AUTHORITY.md](AUTHORITY.md) | Agent/P2Mind 决策权二分与新增行为评审清单 |
| [runtime/P2MIND.md](runtime/P2MIND.md) | P2Mind 控制结构（权威设计） |
| [runtime/MOTION.md](runtime/MOTION.md) | 运动模块：规则集、规划器、执行器、战斗控制器 |
| [runtime/AGENT-REACTION.md](runtime/AGENT-REACTION.md) | Agent 战逃反应提示词 |
| [runtime/PITFALLS.md](runtime/PITFALLS.md) | 踩坑清单与实现红线 |
| [CONTRACTS.md](CONTRACTS.md) | ClientPort / Job / WorkGiver / Driver / Tracker / 树的契约 |
| [RUNTIME.md](RUNTIME.md) | tick 循环、预算、失败与恢复、owner session |
| [OPERATOR-PLAYBOOK.md](OPERATOR-PLAYBOOK.md) | P2 运行纪律（Agent/P2Mind） |
| [DEPENDENCIES.md](DEPENDENCIES.md) | 依赖与版本 |

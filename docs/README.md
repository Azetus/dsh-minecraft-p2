# 文档目录

`docs/` 下的文档描述项目**当前**状态：架构、契约、运行时行为和实现边界。读完后应能回答“项目现在是什么样、为什么这样定”。

## 入口

- 面向使用者：[README.md](../README.md)
- 面向开发 agent：[AGENT.md](../AGENT.md)
- 面向游戏内 Agent：[skills/p2-operator/SKILL.md](../skills/p2-operator/SKILL.md)

## 索引

| 文档 | 内容 |
|---|---|
| [../README.md](../README.md) | 项目定位、当前能力、用法、工作区副作用 |
| [../AGENT.md](../AGENT.md) | 开发协作指南、架构边界与验证要求 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 进程边界、分层、目录、生命周期 |
| [AUTHORITY.md](AUTHORITY.md) | Agent/P2Mind 决策权二分与新增行为评审清单 |
| [runtime/P2MIND.md](runtime/P2MIND.md) | P2Mind 控制结构（权威设计） |
| [runtime/MOTION.md](runtime/MOTION.md) | 运动模块：规则集、规划器、执行器、战斗控制器 |
| [runtime/AGENT-REACTION.md](runtime/AGENT-REACTION.md) | Agent 战逃反应提示词 |
| [CONTRACTS.md](CONTRACTS.md) | ClientPort / Job / WorkGiver / Driver / Tracker / 树的契约 |
| [RUNTIME.md](RUNTIME.md) | tick 循环、预算、失败与恢复、owner session |
| [OPERATOR-PLAYBOOK.md](OPERATOR-PLAYBOOK.md) | P2 运行纪律（Agent/P2Mind） |
| [DEPENDENCIES.md](DEPENDENCIES.md) | 依赖、构建与开发环境 |

## 维护规则

- 只写当前事实与设计理由，不记录历史设计、演进过程、变更记录、测试记录或反馈。
- 已删除的机制不保留“旧实现”段落；需要兼容当前输入时，只描述当前行为。
- 文档不出现其他项目的名称或信息；使用的依赖与宿主平台除外。
- 新增文档必须进入本索引；删除文档时同步清理所有引用。

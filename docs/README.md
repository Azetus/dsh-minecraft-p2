# 文档目录

## 按任务查阅

| 要做的事 | 先看哪里 |
|---|---|
| 了解插件能力、安装方式和工作区副作用 | [项目 README](../README.md) |
| 接手开发任务，确认授权、检查与提交规则 | [开发协作指南](../AGENTS.md) |
| 定位 bridge、body 或 provider 的职责与代码目录 | [架构](ARCHITECTURE.md) |
| 新增 giver、driver 或行为 | 先用[决策权评审清单](AUTHORITY.md#8-评审清单)判断归属，再查 [P2Mind 控制结构](runtime/P2MIND.md) |
| 实现接口或判断一次动作、job 的成功条件 | [接口契约](CONTRACTS.md)；逐个 driver 的后置条件见 [Driver 成功定义](CONTRACTS.md#51-driver-成功定义) |
| 排查调度、停止、失败恢复或 owner 唤醒 | [运行时](RUNTIME.md) |
| 修改寻路、站位或战斗控制器 | [运动模块](runtime/MOTION.md)；已有实机覆盖见[远程战斗验收](runtime/MOTION.md#73-远程战斗实机验收) |
| 核对依赖或构建插件 | [依赖说明](DEPENDENCIES.md)和[本地构建与检查](DEPENDENCIES.md#4-本地构建与检查) |
| 检查已有 `p2-dev` 并保留原 session | [复用隔离环境的命令与影响](DEPENDENCIES.md#5-检查或启动隔离的-p2-dev) |
| 外层开发 agent 通过 DSH 派单并验收 LAN 游戏行为 | [p2-live-acceptance 工作区 skill](../.agents/skills/p2-live-acceptance/SKILL.md) |
| 开发者用本机 `.live/*.live.ts` 定向验证游戏行为 | [实机验收入口](../AGENTS.md#52-实机验收入口) |
| DSH owner session 操作 P2、处理订单或战逃通知 | [p2-operator 运行 skill](../skills/p2-operator/SKILL.md)、[异常处理手册](OPERATOR-PLAYBOOK.md#5-异常处理)、[战逃反应提示词](runtime/AGENT-REACTION.md) |

## 维护规则

- 正文描述当前设计、实现边界和设计理由。删除机制时清理过期说明；仍需兼容的输入按当前行为说明。
- 实机结论写入对应机制的文档，注明版本、环境、已验证行为和未覆盖范围。逐轮测试日志、原始回执和观测文件保存在本机 `.live/runs/`。
- 对其他项目的引用限于实际使用的依赖和宿主平台。
- 增删或移动文档时，同步更新本索引和指向它的链接。

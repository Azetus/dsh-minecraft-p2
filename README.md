# dsh-minecraft-p2

Minecraft 生存 agent 的 DSH 运行时：bridge 进程 + body 子进程 + Mineflayer provider。

**版本 0.3.1：P2Controller 是唯一自主控制模式。Behavior/guard/switch/confirm 已删除。**

## 快速开始

```text
/p2 setup
/p2 start
p2_status
p2_card
```

检查并启用 act：

```text
p2_check  {sourcePath: 'acts/goto.mjs', artifactKind: 'act'}
p2_activate {artifactId}
```

检查并启用策略：

```text
p2_check  {sourcePath: 'strategies/probe-walk.strategy.js', artifactKind: 'strategy'}
p2_activate {artifactId}
p2_controller action=enable
p2_controller action=install {artifactId}
p2_controller action=commit {goal, strategyKey, post, baselineKeys, checkpoint?}
```

停止：

- `p2_controller action=cancel`：取消当前承诺
- `p2_controller action=disable`：停止自主行动
- `/p2 stop`：停止 body

## 文档

- [架构](docs/ARCHITECTURE.md)
- [契约](docs/CONTRACTS.md)
- [运行时](docs/RUNTIME.md)
- [操作员手册](docs/OPERATOR-PLAYBOOK.md)
- [P2Controller 设计](docs/runtime/P2CONTROLLER.md)
- [Body 接线](docs/runtime/P2CONTROLLER-BODY-WIRING.md)
- [Agent 提示词](prompts/runtime-agent.md)

## 开发

```text
npm run check   # build + typecheck + test
npm run bundle  # bundles/dsh-minecraft-p2-<version>.tgz
```

# dsh-minecraft-p2

Minecraft 生存 agent 的 DSH 运行时。常驻 P2Mind 负责在游戏内执行、恢复和验证目标；Agent 只下达目标级 order，并在偏离或终态时介入。

## 能力

- 有限 order 面：`go / place / dig / collect / equip / use / attack / check / container / craft / build / traverse / hold`
- 常驻 NPC 执行：选目标、续做、失败重试、停止确认和终态验证
- 计划、蓝图、材料政策与三态验证
- 游戏内聊天接入、completion wake、body 重启与意图日志恢复
- owner-session：persona、记忆、workspace skill、自动唤醒
- 当前通过 mineflayer 接入；其他客户端适配不在当前范围

## 快速开始

前置：在 DSH 中安装本插件 tarball 并重载插件；Minecraft Java 服务端可连接。构建与本地开发见 [依赖、构建与开发环境](docs/DEPENDENCIES.md)。

```text
/p2 setup
/p2 start 127.0.0.1:25575
```

启动后：

```text
p2_status
p2_observe {mode:"find", only:["crafting_table"], radius:16}
p2_order {verb:"go", params:{x:48,y:64,z:30}}
p2_order {verb:"dig", params:{x:12,y:48,z:-3}}
p2_order {verb:"collect", params:{radius:8}}
p2_report
```

`p2_order` 只返回 accepted；终态、blocked 或失败通过 completion wake 推回。Agent 不轮询、不 `Start-Sleep`。

## `.p2` 工作区

`/p2 start` 会在当前 Session 的工作区创建 `.p2/`，缺失文件从 `content/templates/` 复制，已有文件不覆盖：

```text
.p2/
  persona.md        # 人格；编辑后下一回合生效
  config.json       # 角色与连接行为、autoWake 配置
  memory/<world>/<character>.jsonl
  skills/<name>/SKILL.md   # 工作区 skill，热加载
```

`.p2/` 是本机状态，整体不入库；连接目标只来自 `/p2 start <host>:<port>`，不写入 `config.json`。

## 文档

- [文档目录](docs/README.md)
- [架构](docs/ARCHITECTURE.md)
- [P2Mind 设计](docs/runtime/P2MIND.md)
- [契约](docs/CONTRACTS.md)
- [运行时](docs/RUNTIME.md)
- [P2 运行手册](docs/OPERATOR-PLAYBOOK.md)
- [依赖、构建与开发环境](docs/DEPENDENCIES.md)

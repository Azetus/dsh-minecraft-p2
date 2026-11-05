# dsh-minecraft-p2

Minecraft 生存 agent 的 DSH 运行时：bridge 进程 + body 子进程 + P2Mind 常驻 NPC AI + 可替换的客户端接入。

P2Mind 把角色交给常驻 NPC AI：agent 只下**目标级 order**，NPC 自己选工作、执行、失败重试，并在偏离/终态时唤醒 agent。角色只做玩家能做的事，走路、挖掘、放置都通过 ClientPort 完成。

## 当前能力

- 有限 order 面：`go / place / dig / equip / use / attack / check / container / craft / build / traverse / hold`
- 常驻树 + 主树 + WorkGiver / JobTracker / Driver
- 计划、蓝图、材料政策与三态验证
- 游戏内聊天接入、completion wake、body 重启与意图日志恢复
- owner-session：persona、简易记忆、workspace skill、自动唤醒
- mineflayer ClientPort；自研客户端 mod 是后续适配方向

## `.p2` 工作区

`p2 start` 会在启动 P2 的 session 工作区创建 `.p2/`，缺失文件从 `content/templates/` 复制，已有文件不覆盖：

```text
.p2/
  persona.md        # 人格，编辑后下一回合生效
  config.json       # minecraft 连接/角色 + autoWake 配置
  memory/<world>/<character>.jsonl
  skills/<name>/SKILL.md   # 工作区 skill，热加载
```

`.p2/` 是本机内部内容，整体不入库；模板在 `content/templates/` 入库。人格定义“人类输入是否当命令”；operator 只定义工具语义。

## 运行

```text
/p2 setup
/p2 start 127.0.0.1:25575          # 启动 body 并连接该 MC 服务器
p2_status                      # 当前 order / job / 预算 / 最近偏差
p2_observe {mode:"find",only:["crafting_table"],radius:16}  # 只读：最近已加载方块，先 find 再 go/craft
p2_observe {min,max,detail}    # 只读观测：方块/计数/表面，或 points 定向查询
p2_entities {radius,names}     # 实体/掉落物观测
p2_order {verb, params?, blueprint?, policy?}
p2_orders
p2_cancel {id}
p2_report
p2_say {text}
p2_memory {action:"remember"|"recall"|"forget", ...}
```

`p2_order` 只返回 accepted；终态、blocked 或失败通过 completion wake 推回。Agent 不轮询、不 `Start-Sleep`。

## 开发

```text
npm run check   # build + typecheck + test
npm run bundle  # bundles/dsh-minecraft-p2-<version>.tgz
```

## 文档

- [架构](docs/ARCHITECTURE.md)
- [P2Mind 设计](docs/runtime/P2MIND.md)
- [契约](docs/CONTRACTS.md)
- [运行时](docs/RUNTIME.md)
- [操作员手册](docs/OPERATOR-PLAYBOOK.md)
- [文档目录](docs/README.md)

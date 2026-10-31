# dsh-minecraft-p2

Minecraft 生存 agent 的 DSH 运行时：bridge 进程 + body 子进程 + 可替换的客户端接入。

**当前方向：P2Mind（NPC AI 控制结构）替代旧 P2Controller。设计已定稿，实现从 M0 开始。**

旧实现对 agent 是“逐步操作入口”，实际长跑里只能退化成巨型脚本或微操；P2Mind 把角色交给常驻 NPC AI，
agent 只下**目标级 order**，NPC 自己选工作、执行、失败重试，并在偏离/终态时唤醒 agent。

## 现在能做什么

- 设计文档：[P2Mind](docs/runtime/P2MIND.md) / [架构](docs/ARCHITECTURE.md) / [契约](docs/CONTRACTS.md) / [运行时](docs/RUNTIME.md)
- 代码：M0 之前，旧控制层仍留在仓库里（`src/controller/`、`src/core/`、`src/runner/`、`ops/`、`acts/`、`strategies/`），**M0 第一步删除**。

## 目标用法（M1 起）

```text
/p2 setup
/p2 start
p2_status                      # 精简状态：当前 order / job / 预算 / 最近偏差
p2_observe {min,max,detail}    # 只读观测：方块/计数/表面，或 points 定向查询
p2_entities {radius,names}     # 不移动的实体/掉落物观测（按距离排序）
p2_preview_blueprint {blueprint} # 蓝图 dry-run：缺料/冲突/未加载格
p2_order {verb:"build", blueprint:{blocks:[...]}, policy:{conflict:{mode:"clear"}}}  # 内联蓝图 + 冲突策略
p2_order {verb: "shelter", params: {quality: "minimal"}}   # 下一条 order
p2_orders                      # 队列
p2_cancel {id}                 # 取消
p2_report                      # 最近一次偏离/终态摘要
```

Agent 负责选点、蓝图、材料轮次与 order；P2Mind 在 order 内完成移动、挖掘、放置与恢复。

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
- [文档目录规则](docs/README.md)
- 归档（仅供回顾）：[`docs/history/`](docs/history/)

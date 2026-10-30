# prompts/: 运行时提示词集

> 状态：**草案**（2026-10-30）。这些是"怎么做"的操作指令，不是设计文档。

## 这套文件是什么

| 文件 | 读者 | 作用 |
| --- | --- | --- |
| `runtime-agent.md` | 主 session（owner / operator） | 接入游戏时的系统提示：角色、开场动作、四层分工、启动清单、验收纪律、错误码速查、禁止项 |
| `artifact-behavior.md` | subagent（author） | 编写 / 修改 behavior 的规范与自检清单 |
| `artifact-act.md` | subagent | 编写 act 的规范（manifest、生命周期、preconditions、读回校验） |
| `artifact-op.md` | subagent | 编写 query/control op 的规范（portability、limits、schema 一致） |
| `artifact-guard-watch.md` | subagent + 主 session | 登记 guard/watch 与写 policy 的规范（领先指标、边沿语义、TTL） |

## 与 docs/ 的分工

- `docs/` 回答"为什么这样设计、契约是什么"（例如 `docs/THREAT-REACTION.md`、`docs/runtime/OP-PROVIDER-CONTRACT.md`）。
- `prompts/` 回答"现在该做什么、按什么顺序、验收标准是什么"。
- 两者冲突时：**以代码与 `docs/CONTRACTS.md` 为准**，并立即修 prompt。

## 为什么用 prompt/skill 而不放在项目根 `AGENT.md`

1. 项目根 `AGENT.md` 会把规则施加到**所有** session（包括开发、测试、发布），而本套规则只适用于"已接入真实游戏"的会话。
2. 按 artifact 类型分片，subagent 只加载它需要的那一份，节省上下文、减少规则互相干扰。
3. 主 session 的 `runtime-agent.md` 与 subagent 的 `artifact-*.md` 职责不同，混在一个文件里会互相污染。

加载方式（择一，后续实现）：

- 以 system prompt 注入 `runtime-agent.md`；
- 或作为 skill 在接入游戏时加载，子 agent 按类型加载 `artifact-*.md`。

## 打包注意（后续工作）

当前 `package.json` 的 `files` 只包含 `lib/**` 与 `cordis.patch.yml`，`prompts/` **不会**随 bundle 发布。若希望插件在 `p2_body start` 时自动注入本套提示词，需要：

1. `files` 增加 `prompts/**`；
2. 插件加载时读取并暴露为资源（或提供 `p2_prompt` 工具返回对应文件内容）；
3. 在 `p2_status` 中标注当前提示词版本，便于证据记录。

在此之前，这些文件由 owner 手工引用。

## 维护规则

- 任何新错误码、新字段、新工具语义，先在 `docs/CONTRACTS.md` 定稿，再同步到对应 prompt。
- 每个 prompt 末尾的"自检清单"必须可勾选、可验证；不接受"注意安全"这类不可执行条款。
- 反例优先收录真实发生过的语义陷阱（见 `runtime-agent.md` §8 速查表）。

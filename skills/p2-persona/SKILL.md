---
name: p2-persona
description: Use when speaking as P2 in Minecraft and when deciding how to treat human input. The workspace persona file defines identity, tone, and whether human messages are commands; the operator contract only defines tool semantics.
---

# P2 persona

## 人格在哪里

- 人格正文在启动 P2 的 session 工作区：`.p2/persona.md`。
- 首次 `p2 start` 会从 `content/templates/persona.md` 创建；之后插件只读，不会覆盖。
- 编辑后下一个模型回合生效（mtime 动态 section）；不需要重启。
- 文件最大 4KB；超限截断并日志。

## 人格决定什么

- 身份、称呼、语气、句长、是否用表情。
- 你与人类的关系：人类输入是命令、请求，还是仅供参考。
- 你的边界、偏好、是否愿意拒绝/攻击玩家等。
- 插件不预设服从/不服从；operator contract 不替你决定这层关系。

## 不决定什么

- 工具权限和 `p2_*` 语义仍由插件/tool 定义。
- 人格不能把不存在的工具变成存在；也不能取消 P2 的 body-level 安全反射。
- 显式 `attack` 可以指定任何实体，包括玩家；`p2_policy.fight` 的玩家保护只是 P2 自动选择的默认值。
- 不要把人格写成工具规则或安全规则；那些属于 operator。

## 说话

- 游戏聊天短句、直接；不用客服腔。
- 只提真正记录过的事；不确定就说“不知道/没记过”。
- 不要声称执行了没有证据的动作。
- 需要目标/行动时用 `p2_order` / `p2_duty`；`p2_say` 只负责说话。

## 编辑

编辑 `.p2/persona.md` 即可。人格是用户内容，不是运行态；不要在人格里塞秘密。

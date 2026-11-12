# dsh-minecraft-p2

简体中文 | [English](README_EN.md)

让 DeepSeek Harness（DSH）以**第二名玩家**的身份加入你的 Minecraft 世界。你可以在游戏里和 P2 聊天，让它去指定地点、挖矿或捡拾掉落物。接到任务后，P2 会自己找路、选用工具，并在遇到阻碍时尝试绕路或重试。

P2 以独立角色连接服务器，无需安装客户端 Mod。当前版本仅支持允许离线登录（`online-mode=false`）的 Minecraft Java 版服务器；支持的游戏版本见下方[兼容性](#minecraft-版本)。

> **0.2.x 预览版** · 部分功能仍在完善，命令和工具参数可能随版本更新而变化。

## 功能

- **持续执行任务** · P2 接到目标后会在游戏中持续执行，并向 DSH 报告任务完成、受阻或失败的情况。
- **放置方块与收集材料** · P2 可以在指定位置放置方块，也可以通过挖掘和拾取掉落物来收集材料。
- **生存与自理** · P2 默认会在遇险时尝试撤离、饥饿时尝试进食、卡住时尝试脱困。自动战斗默认关闭，可按需开启。
- **个性与记忆** · 在 `.p2/persona.md` 中设置 P2 的说话方式，以及它是否把玩家的话当成命令。记忆按世界和角色分别保存。

## 兼容性

本插件通过 Mineflayer 使用原版 Java 协议连接服务器。能否连接，取决于目标服务器是否接受原版客户端，而不是取决于模组被标为“客户端”还是“服务端”。

### Minecraft 版本

P2 通过 [Mineflayer](https://github.com/PrismarineJS/mineflayer) 用原版 Java 协议连接服务器，所以**能连接哪些游戏版本由 Mineflayer 决定**。Mineflayer 声明支持的 Java 版范围是 `1.8.8` 到 `26.1`，具体以它的 `testedVersions` 为准。

- **一般不需要自己填版本**：默认会自动识别服务器版本。
- **我们完整验证过的是 `1.21.1` 和 `26.1.2`**：移动、挖掘、放置、取消、断线重连等行为都在这两个版本上跑过实时测试。
- **能登录不等于能用**：其它版本通常也能连上，但挖掘、放置、合成、战斗等行为不做保证；这类问题请按版本兼容性问题反馈。
- 如果自动识别失败或行为明显异常，可以在 `.p2/config.json` 里显式写出版本，例如 `"version": "1.21.1"`。
- 仅支持 Java 版，不支持基岩版。
- 仅支持离线登录（`online-mode=false`）；不支持 Mojang/Microsoft 正版验证服务器。

### 模组与服务器

通常可以连接：

- 原版或离线服务器。
- 不强制客户端安装模组、也不向客户端发送未注册自定义数据包的服务器。
- 只影响本地画面、HUD、地图等表现，且不会在玩家加入时发送协议数据的客户端模组。

可能无法连接：

- 强制要求客户端安装特定模组、或强制模组握手的服务器。
- 玩家加入时向客户端发送原版客户端不认识的自定义数据包的服务器。即使某个模组主要面向客户端，在 LAN 整合世界里也可能由它的服务端部分触发。
- 深度修改方块、物品、配方、维度、注册表或世界同步的服务器。

### 能交互的范围

能登录不等于能操作模组内容。

Mineflayer 只认识协议库中的原版方块、物品、配方和实体。模组新增的内容可能表现为未知方块或类似空气的对象，无法可靠地挖掘、放置、合成或交互。因此在模组环境中：

- 建议只操作原版内容；
- 或把该服务器当作“可以登录，但无法可靠交互”的容器。

## 安装

### 前置条件

- 已安装 DSH。本插件在 DSH `0.2.1-rc.3` 上测试。
- 有一个可连接的 Minecraft Java 版服务器，且已设置 `online-mode=false`。
- P2 的默认角色名是 `P2_Bot`。连接时，服务器内不能有同名玩家在线。

### 通过 DSH 插件页面安装

1. 点击 DSH 左侧栏的「插件」，再点击「添加插件」。
2. 在弹窗中输入 **`dsh-minecraft-p2`** 安装默认发布版本，或输入 **`dsh-minecraft-p2@<version>`** 安装指定版本。如果你有本地 `.tgz` 安装包，直接输入文件的绝对路径。
3. 确认添加；如果出现启用提示，按提示启用插件。

### 通过 DSH 命令行安装

安装默认发布版本可运行以下命令。

```text
dsh plugin --profile web add dsh-minecraft-p2
```

将 `web` 换成你实际使用的 DSH profile。桌面版常用 `desktop`。要安装指定版本，将包名换成 `dsh-minecraft-p2@<version>`。

安装本地 `.tgz` 时，填入安装包的绝对路径。路径含空格时请加上引号；将 `<version>` 替换为实际版本。

```text
dsh plugin --profile web add "/绝对路径/dsh-minecraft-p2-<version>.tgz"
```

安装或升级后，请完全退出并重新启动 DSH，让宿主重新加载插件。

## 快速开始

在 DSH 中打开一个有项目目录的会话。你可以先输入 `/p2 setup` 检查当前会话的项目目录。

在同一个会话中输入 `/p2 start`，并把示例中的地址和端口换成你的 Minecraft 服务器地址和端口。

```text
/p2 start 127.0.0.1:25575
```

首次运行 `/p2 start` 会在项目目录下生成 `.p2/` 和默认配置。连接成功后，在游戏的玩家列表里确认 `P2_Bot` 已加入，然后在游戏聊天里试着发一句「P2，你好」。

- 在 DSH 中输入 `/p2 status` 查看 P2 的运行状态。
- 输入 `/p2 stop` 让 P2 断开连接。
- 如需更改角色名，先停止 P2，再修改 `.p2/config.json` 中的 `minecraft.username`，然后重新运行 `/p2 start`。连接地址由启动命令指定。

## DSH 工具

P2 启动后，这些工具会在启动它的 DSH 会话中可用。你可以在该会话中用自然语言请 DSH 查看 P2 的状态或交给它任务。

| 工具 | 用途 |
|---|---|
| `p2_status` | 查看连接状态、所属会话、当前任务和最近的失败 |
| `p2_body` | 启动、停止、重启或查看 P2 body；未启动时任何会话可启动，启动后仅 owner 可控制 |
| `p2_order` | 提交任务，支持 `go / place / dig / collect / equip / use / attack / check / container / craft / build / traverse / hold` |
| `p2_orders` | 查看正在执行和排队的任务，以及队列受阻的原因 |
| `p2_cancel` | 取消指定任务或全部排队任务 |
| `p2_report` | 查看最近一次任务偏离或结束的摘要 |
| `p2_events` | 查看事件流，用于排查问题 |
| `p2_observe` | 观察方块、统计数量或查询指定位置 |
| `p2_entities` | 观察实体和掉落物 |
| `p2_preview_blueprint` | 预检蓝图的材料、冲突和未加载的位置 |
| `p2_say` | 让 P2 在游戏聊天里发一条消息 |
| `p2_memory` | 写入、查询或删除记忆 |
| `p2_duty` | 启动或停止常驻任务 |
| `p2_policy` | 设置 P2 的战斗、撤离和自理策略 |
| `p2_base_activity` | 设置空闲时的活动，支持 `idle / wandering / escort` |

例如，DSH 可以用 `p2_observe` 查找附近的工作台，再用 `p2_order` 让 P2 前往指定坐标。

```text
p2_observe {mode:"find", only:["crafting_table"], radius:16}
p2_order {verb:"go", params:{x:48,y:64,z:30}}
```

`p2_order` 返回 `accepted` 表示任务已受理。任务完成、受阻或失败时，P2 会主动把结果报告给 DSH 会话。

## `.p2` 工作区

`/p2 start` 会在当前会话的项目目录中补齐缺失的模板文件，并保留已有文件。

```text
.p2/
  persona.md              # 人格设定，编辑后下一回合生效
  config.json             # 角色、连接行为和自动唤醒设置
  memory/<world>/<character>.jsonl
  skills/<name>/SKILL.md   # 工作区技能，支持热加载
  archive/journal.jsonl    # 身份不匹配时归档的上一份意图日志（只保留最近一次）
```

`.p2/` 保存本地状态，请将它排除在版本控制之外。改用户名或换存档后，旧 journal 会自动归档，不会再因此拒绝启动。

## 插件结构

```text
DSH 插件（bridge）
  └─ body 子进程（P2Mind）
       └─ provider（mineflayer）── Minecraft 服务端
```

DSH 负责会话、工具和插件生命周期，P2Mind 负责在游戏内执行任务，mineflayer 负责与 Minecraft 服务端交互。

## 文档

- [开发与设计文档](docs/README.md)

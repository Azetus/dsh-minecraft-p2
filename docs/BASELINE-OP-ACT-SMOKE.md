# 共享基线：基本 op/act 清单与 smoke 清单

> 状态：**整理中，未冻结**。本文是 IR 与受限 JS 两个实验分支的共同起点；冻结后打 `m5-baseline` tag。
> 目标：让两个分支只差 behavior 层；op、act、provider、broker、status、工具面尽量一致。实验期间新需要的 act 只实现一次，两边共用。

## 1. 原则

- **最小但可生存**：基线只保证“能开始正常生存实验”，不追求覆盖全部游戏机制；缺失能力在实验中按需补，补一次两边共用。
- **op 是能力，act 是技能**：op 只做原子读写；act 做单目标、可停止、有边界的完整动作；behavior 才做策略编排。
- **两边一致**：同一 op 名称、参数、结果、错误码；同一 act 名称与参数；同一 status 字段。分支不能私改共享语义。
- **失败可诊断**：每个 op/act 的失败都有明确错误码；smoke 要覆盖成功、失败、取消、清理。
- **不预置策略**：基线只给基本 act，不预置“探索/战斗/建造/协作”等完整策略；这些在实验中由 subagent 编写。

## 2. 当前已有能力（M5 结束时）

### QueryOp（5）

| op | 参数 | 返回 | 备注 |
| --- | --- | --- | --- |
| `position` | 无 | `{x,y,z}` | 缺维度；基线扩展 `dimension` |
| `inventory` | 无 | `[{name,count}]` | Mineflayer 名称不带命名空间（`apple`） |
| `entities` | `{objectType?, name?}` | `[{id,name,displayName,type,objectType,item,position}]` | 含玩家、生物、掉落物 |
| `time` | 无 | `{timeOfDay,age,paused,doDaylightCycle,difficulty}` | |
| `block` | `{x,y,z}` | `{name,x,y,z}` 或 `null` | 单方块 |

### ControlOp（6）

| op | 参数 | 效果/停止 | 备注 |
| --- | --- | --- | --- |
| `look` | `{yaw,pitch}` | none/none | |
| `move` | `{direction,durationMs?}` | active/poll | 持续控制 |
| `jump` | 无 | none/none | 150ms 脉冲 |
| `moveTo` | `{x,z,tolerance?,timeoutMs?,blockedMs?}` | active/poll | 水平寻路 |
| `stop` | 无 | none/none | 清控制状态，隐式授予所有 act |
| `dig` | `{x,y,z}` | active/poll | 单方块 |

### act（3）

| act | 参数 | 声明的 op | 备注 |
| --- | --- | --- | --- |
| `move-to` | `{x,z,tolerance?,timeoutMs?,blockedMs?}` | `position`, `moveTo`, `stop` | |
| `mine-one` | `{pos:{x,y,z}}` | `block`, `dig`, `stop` | |
| `stop` | 无 | `stop` | |

## 3. 基线目标清单

### 3.1 QueryOp

优先级：P0 实验前必须；P1 实验中按需补；P2 后续。

| op | 优先级 | 参数 | 返回 | 用途 |
| --- | --- | --- | --- | --- |
| `position` | P0（扩展） | 无 | `{x,y,z,dimension}` | 定位、跟随、阶段判断；加维度支持下界/末地 |
| `inventory` | P0（已有） | 无 | `[{name,count}]` | 资源、工具、食物判断 |
| `health` | **P0 新增** | 无 | `{health,food,saturation,oxygen?,armor?}` | 生存与战斗撤退；字段按 provider 能力可空 |
| `entities` | P0（已有） | `{objectType?, name?, maxDistance?}` | 现有结构 + `distance?` | 玩家/怪物/掉落物；`maxDistance` 减少数据量 |
| `blocks` | **P0 新增** | `{names?, radius?, count?, yMin?, yMax?}` | `[{name,x,y,z,distance}]` | 找树/矿/工作台/床；按距离排序，有上限 |
| `block` | P0（已有） | `{x,y,z}` | `{name,x,y,z}` 或 `null` | 单方块确认 |
| `time` | P0（已有） | 无 | 现有结构 | 昼夜、维度时间 |
| `players` | P1 | `{maxDistance?}` | `[{name,uuid?,position,distance}]` | 协作/escort；也可用 `entities` 过滤 Player |
| `container` | P2 | `{x,y,z}` | 容器摘要/槽位 | 箱子、熔炉、交易 |
| `recipe` | P1/P2 | `{item}` | 配方/可用性 | 合成；也可放在 act 内部 |

`blocks` 语义（初版）：

- 只扫描已加载区块；`radius` 默认 16，最大 32；`count` 默认 16，最大 64。
- `names` 可传字符串或数组（不带命名空间，如 `oak_log`、`iron_ore`）；省略时返回最近的任意非空气方块（用于粗略地形/探索，慎用）。
- 按距离升序返回；结果带 `distance`；找不到返回空数组（成功，不是失败）。
- 扫描是只读查询，不改变游戏状态；不保证覆盖未加载区域。

### 3.2 ControlOp

| op | 优先级 | 参数 | 效果/停止 | 说明 |
| --- | --- | --- | --- | --- |
| `look` | P0（已有） | `{yaw,pitch}` | none/none | |
| `move` | P0（已有） | `{direction,durationMs?}` | active/poll | |
| `jump` | P0（已有） | 无 | none/none | |
| `moveTo` | P0（已有） | `{x,z,tolerance?,timeoutMs?,blockedMs?}` | active/poll | |
| `stop` | P0（已有） | 无 | none/none | 隐式授予所有 act |
| `dig` | P0（已有） | `{x,y,z}` | active/poll | |
| `place` | **P0 新增** | `{x,y,z,face?,item?}`，`face` 取 `up/down/north/south/east/west` | none/none | 放置一个方块；需要相邻参照与手持物品 |
| `attack` | **P0 新增** | `{entityId}` | none/none | 单次攻击；冷却/连击由 act 负责 |
| `equip` | **P0 新增** | `{item,destination?}`，`destination` 取 `hand/off-hand/head/torso/legs/feet` | none/none | 装备到主手/副手/护甲；找不到或不可装备失败 |
| `use` | **P0 新增** | `{offhand?}` | active/poll | 使用手持物（吃、喝、点火等）；act 负责按住/释放 |

| `toss` | P2 | `{item,count?}` | none/none | 给予玩家/丢弃 |
| `container` | P2 | `{x,y,z,action,...}` | 视动作 | 存取、熔炉、交易 |

`chat` 不做 op，作为 agent 侧工具（由 DSH 会话直接发送）；behavior 不负责聊天。`follow` 不做 act，作为 behavior（循环查询玩家位置 + `move-to`）；`place-block` 由 act 负责相邻面/支撑的局部选择。

每个新增 ControlOp 都需要 provider 声明能力并在握手时核验；QueryOp 不改变状态，不需要 capability 标记。

失败码（基线约定，provider 可细化）：

- `moveTo`：`MOVE_TO_BLOCKED`、`MOVE_TO_TIMEOUT`（已有）。
- `dig`：`DIG_NO_BLOCK`、`DIG_FAILED`（已有）。
- `place`：`PLACE_NO_ITEM`、`PLACE_UNSUPPORTED`、`PLACE_FAILED`。
- `attack`：`ATTACK_NO_TARGET`、`ATTACK_FAILED`。
- `equip`：`EQUIP_NO_ITEM`、`EQUIP_FAILED`。
- `use`：`USE_NO_ITEM`、`USE_FAILED`。
- 通用：`UNKNOWN_OP`、`OP_KIND_MISMATCH`、`OP_NOT_DECLARED`、`OP_FAILED`。

### 3.3 act

| act | 优先级 | 参数 | 声明的 op | 说明 |
| --- | --- | --- | --- | --- |
| `move-to` | P0（已有） | `{x,z,tolerance?,timeoutMs?,blockedMs?}` | `position`, `moveTo`, `stop` | |
| `mine-one` | P0（已有） | `{pos}` | `block`, `dig`, `stop` | |
| `stop` | P0（已有） | 无 | `stop` | |
| `place-block` | **P0 新增** | `{pos, face?, item?}` | `block`, `look`, `place`, `stop` | 单方块放置；不决定“建什么” |
| `attack-one` | **P0 新增** | `{entityId, cooldownMs?}` | `entities`, `attack`, `stop` | 单次攻击；战斗循环由 behavior 负责 |
| `equip-item` | **P0 新增** | `{item, destination?}` | `inventory`, `equip`, `stop` | 单次装备 |
| `use-item` | **P0 新增** | `{offhand?}` | `inventory`, `use`, `stop` | 单次使用（吃/喝）；按住时长由 act 处理 |

| `craft` | P1 | `{item,count?}` | `inventory`, `block`, `look`, `place?`, `use?` | 合成；配方解析可在 act 内，属于技能 |
| `attack-target` | P2 | `{entityId, timeoutMs?}` | `entities`, `attack`, `moveTo`, `stop` | 战斗技能 act（追击+攻击），实时性更高 |
| `build-segment` | P2 | `{blueprint}` | `block`, `place`, `moveTo`, `stop` | 分段建造；避免巨型 act |

**不在基线内**：探索策略、采集策略、战斗策略、建造策略、协作策略、末影龙阶段；这些是实验中要编写的 behavior。

## 4. 基线实现顺序

1. **扩展 contracts/provider**：`position.dimension`、`health`、`blocks`、`place`、`attack`、`equip`、`use`；补错误码。
2. **补 act**：`place-block`、`attack-one`、`equip-item`、`use-item`；每个 act 单文件、声明 ops、可停止/收尾。
3. **观测/status**：`currentStep`（IR 为 activeNode，JS 为 step）、`activeTarget`、`waiting`、`progress`、`lastFailure`、`lastRun` 证据；两边一致。
4. **测试**：op 契约、provider 行为（可用假 provider）、act 生命周期、取消/清理。
5. **smoke**：按 §5 在真实游戏跑一遍；两分支都通过后打 `m5-baseline`。
6. **冻结**：tag `m5-baseline`，记录 commit、能力清单、smoke 结果。

## 5. smoke 清单

原则：每个用例记录 **预期 / 实际 / 结果 / 备注**；P0 全部通过才冻结基线。两边用同一份清单，工具面尽量一致。

### A. 环境与连接

| ID | 用例 | 预期 |
| --- | --- | --- |
| A1 | 安装 bundle、启动桌面 DSH、确认 `p2_*` 工具与 `/p2` 命令 | 工具可见；`/p2 status` 可用 |
| A2 | 启动 body、连接 LAN 25575 | `hello` 成功；provider `connected`；P2_Bot 在游戏中 |
| A3 | 查询 `position` / `inventory` / `health` / `time` / `blocks` / `block` | 均 `ok`；meta 含 sampledAt/validUntil；`blocks` 结果有上限、按距离排序 |
| A4 | 关闭 body 再启动 | 不自动启动 behavior；旧 run 不复活；世界状态保留 |

### B. 产物与工具面

| ID | 用例 | 预期 |
| --- | --- | --- |
| B1 | check act / policy / behavior；activate；switch；status；stop | 全部接受；status 有 activeRun/activeAct/activeNode/activeTarget/waiting/lastFailure |
| B2 | 把 policy 当 behavior activate | 拒绝（`POLICY_NOT_ACTIVATABLE` 或等价） |
| B3 | 缺必填参数 switch | 拒绝，错误指明参数 |
| B4 | behavior 直接引用 ControlOp | check 阶段拒绝 |
| B5 | 未知 act 引用 / 未声明 op 的 act | check 阶段拒绝 |

### C. act 成功与失败

| ID | 用例 | 预期 |
| --- | --- | --- |
| C1 | `move-to` 到附近可达点 | 成功；status 显示目标；到达后控制释放 |
| C2 | `move-to` 到屏障后/不可达点 | 失败 `MOVE_TO_BLOCKED`/`MOVE_TO_TIMEOUT`；无残留移动 |
| C3 | `mine-one` 挖一个可挖方块 | 成功；方块变空气；物品掉落/拾取可观察 |
| C4 | `mine-one` 对空气 | 失败 `DIG_NO_BLOCK` |
| C5 | `place-block` 在可放置位置 | 成功；方块出现；手持物品减少 |
| C6 | `place-block` 无物品/无支撑 | 失败 `PLACE_NO_ITEM`/`PLACE_UNSUPPORTED`；无残留控制 |
| C7 | `attack-one` 攻击附近生物 | 成功；目标受伤/后退；无残留控制 |
| C8 | `attack-one` 无效 entityId | 失败 `ATTACK_NO_TARGET` |
| C9 | `equip-item` 装备工具/护甲 | 成功；手持/护甲变化 |
| C10 | `equip-item` 不存在物品 | 失败 `EQUIP_NO_ITEM` |
| C11 | `use-item` 吃食物 | 成功；food 上升；使用状态释放 |
| C12 | `use-item` 无可用物品 | 失败 `USE_NO_ITEM` |

每个失败用例后追加：**再启动一个 `move-to`，确认控制权已释放、旧 op 无晚到结果**。

### D. 取消与切换

| ID | 用例 | 预期 |
| --- | --- | --- |
| D1 | `move-to` 运行中 switch 到另一个 behavior | 旧 act 停止并收尾后才启动新 act；status activeTarget 更新 |
| D2 | `move-to` 运行中 stop | 终态 `cancelled`；位置稳定；无移动残留 |
| D3 | act 失败后立刻 switch | 不在收尾完成前启动新 act（F8） |
| D4 | 连续 switch 两次 | 最终只有最后一个 behavior 运行；无旧 run 推进 |

### E. query / policy / 时效

| ID | 用例 | 预期 |
| --- | --- | --- |
| E1 | `decide` 正常返回 | 结果写入 local；后续分支使用该结果 |
| E2 | policy 抛错/超时（测试产物） | `decide` 失败；run 失败；不触发 act 清理（无活动 act 时） |
| E3 | 查询后等待超过 validUntil 再使用 | `STALE_OBSERVATION`（可在软件测试覆盖；真实游戏 smoke 只验证新鲜查询） |
| E4 | guard 复用新鲜证据 | 同一查询在有效期内不重复提交（软件测试） |

### F. 长跑与稳定性

| ID | 用例 | 预期 |
| --- | --- | --- |
| F1 | 60 秒连续采集/巡逻，不切换 | 持续 running；status 有进度；无控制漂移 |
| F2 | 长跑中 stop | 干净取消；无残留 act/控制 |
| F3 | 长跑中查询/日志频率 | 不阻塞 tick；查询有界；日志不无限增长 |

### G. bundle 安装与切换

| ID | 用例 | 预期 |
| --- | --- | --- |
| G1 | 安装 IR bundle（版本 A） | 工具可见；body 可连；smoke A—F 通过 |
| G2 | 卸载 IR、安装 JS bundle（版本 B） | 同一工具面；body 可连；smoke A—F 通过 |
| G3 | 记录版本/tarball 摘要/commit/切换耗时 | 日志完整 |
| G4 | 安装后未启动 behavior | 角色不动；无自动 run |

### H. 两分支一致性

| ID | 用例 | 预期 |
| --- | --- | --- |
| H1 | 同一 smoke 在两分支执行 | 除 behavior artifact 形态外，结果一致；差异记录在实验日志 |
| H2 | 同一基本 act/policy 在两分支复用 | 不需要复制或改写；op 声明与错误码一致 |

## 6. smoke 记录模板

| 字段 | 内容 |
| --- | --- |
| 用例 ID | A1、C3… |
| 分支/版本 | IR/JS；bundle 版本；commit |
| 世界/位置 | 维度、坐标、时间、难度 |
| 前置 | 背包、实体、方块状态 |
| 步骤 | 工具调用与参数 |
| 预期 | 见 §5 |
| 实际 | 状态、错误码、status 快照 |
| 结果 | pass/fail/blocked |
| 备注 | 残留控制、晚到结果、日志、耗时 |

## 7. 冻结条件

- P0 的 op/act 全部实现并有测试；
- A—H 的 P0 用例在两个分支都通过（或差异有明确记录且不影响 substrate 对比）；
- 工具面/status 字段两边一致；
- 世界备份完成；日志目录与模板就绪；
- 打 `m5-baseline` tag，记录 commit 与能力清单。

## 8. 实现记录（2026-10-28）

| 项 | 状态 |
| --- | --- |
| 查询 op：`health`、`blocks`、`position.dimension` | 已实现（provider + 契约 + build 能力声明） |
| 控制 op：`place`、`attack`、`equip`、`use` | 已实现 |
| act：`place-block`、`attack-one`、`equip-item`、`use-item` | 已实现 |
| 单元测试 | 173 passed / 1 skipped（`npm run check`）；离线时 body 流程测试跳过 |
| 真实游戏 smoke | **PASS 19/19**（2026-10-28，超平坦世界，LAN 25575）；证据 .m5-runs/baseline-smoke-2026-10-28T08-12-24-390Z.json |
| `m5-baseline` tag | 代码基线已可打 tag；真实 smoke 作为实验开始前的门槛 |

## 9. 已确定的边界

| 问题 | 决定 |
| --- | --- |
| `chat` | agent 侧工具，不是 op；behavior 不负责聊天 |
| `follow` | behavior（循环查询玩家位置 + `move-to`），不是 act |
| `place` 参照面 | act 负责相邻面/支撑的局部选择；behavior 只给目标位置 |
| `blocks` 上限 | 半径默认 16、最大 32；数量默认 16、最大 64；支持 y 范围 |
| 攻击边界 | 基线只给 `attack-one`（单次）；战斗循环由 behavior 编写，`attack-target` 后续再议 |

## 10. M5.5 基线扩展（2026-10-28，`dev`）

> 本节是当前基线的权威清单；§2、§3 是 M5 时的历史目标表。op 声明在 `src/operation/index.ts`，实现在 `src/provider/mineflayer.ts`。

### 10.1 查询 op（14）

| op | 参数 | 返回 | 备注 |
| --- | --- | --- | --- |
| `position` | — | `{x,y,z,dimension}` | |
| `inventory` | — | `[{name,count}]` | 仅主背包 |
| `health` | — | `{health,food,saturation,oxygen,armor[]}` | `armor` 是已穿戴物品列表 |
| `entities` | `{objectType?,type?,name?,maxDistance?,count?}` | 见 §10.3 | 已实现限距与 `distance` |
| `blocks` | `{names?,radius?,count?,yMin?,yMax?}` | `[{name,x,y,z,distance}]` | y 过滤作用于候选集，见 §10.3 |
| `block` | `{x,y,z}` | `{name,x,y,z}` 或 `null` | |
| `time` | — | `{timeOfDay,age,paused,doDaylightCycle,difficulty}` | `age` 是世界 age |
| `equipment` | — | `{held,offhand,armor[],quickBarSlot}` | 补 `inventory` 缺的手持/护甲 |
| `entity` | `{id}` | 单个实体视图或 `null` | |
| `players` | `{maxDistance?}` | `[{name,uuid,position,dimension,distance}]` | escort/协作 |
| `recipe` | `{item,craftableOnly?}` | `[{result,requiresTable,ingredients[],craftable}]` | craft 的事实来源，不做递归规划 |
| `container` | `{x,y,z}` | `{kind,slots[],fuel?,progress?}` | 打开窗口读快照后关闭；pending 查询 |
| `offers` | `{entityId}` | `[{index,input1,input2,output,disabled,uses,maxUses}]` | 村民交易列表 |
| `weather` | — | `{raining,thundering,thunderState}` | |

### 10.2 控制 op（21）

| op | 参数 | 效果 | 备注 |
| --- | --- | --- | --- |
| `look` | `{yaw,pitch}` | none | |
| `lookAt` | `{entityId}` 或 `{x,y,z}` | none | 实体取头部高度 |
| `move` | `{direction,durationMs?}` | active | direction 含 `jump/sprint/sneak` |
| `jump` | — | none | 落地才完成，会占用控制位 |
| `moveTo` | `{x,z,tolerance?,timeoutMs?,blockedMs?}` | active | 无进展时自动跳跃上一格台阶 |
| `stop` | — | none | 清控制状态 |
| `dig` | `{x,y,z}` | active | 无工具/掉落语义 |
| `place` | `{x,y,z,face?}` | none | 需要手持方块 |
| `attack` | `{entityId}` | none | 单次挥击，无射程检查 |
| `equip` | `{item,destination?}` | none | |
| `use` | `{offhand?,durationMs?}` | active | 按住时长由调用方给 |
| `craft` | `{item,count?,table?}` | active | 就近工作台（4 格内）或显式坐标 |
| `container-transfer` | `{x,y,z,action,item?,count?}` | none | action：`deposit/withdraw/load-input/load-fuel/take-input/take-fuel/take-output` |
| `toss` | `{item,count?}` | none | |
| `respawn` | — | none | 死亡后重生；provider 监听 `death` 清控制 |
| `sleep` | `{x,y,z}` | active | 成功=上床且醒来（跳过夜晚） |
| `interact` | `{entityId}` | none | 右键实体（挤奶/剪羊毛/交互） |
| `activate` | `{x,y,z}` | none | 右键方块（门/按钮/拉杆/床） |
| `mount` / `dismount` | `{entityId}` / — | active / none | 船、马 |
| `trade` | `{entityId,index,count?}` | none | 与村民成交 |

### 10.3 语义与限制

- `entities`：`maxDistance` 按到 bot 的欧氏距离过滤；结果带 `distance`，按距离升序，默认上限 64（最大 256）。`objectType` 是 mineflayer 精确值（`Pig`），`type` 才是宽类（`animal`/`hostile`）。
- `blocks`：`findBlocks` 只返回最近 N 个候选，y 过滤是**候选集内过滤**；带 y 条件时候选集扩大到 256–2048。文档不再暗示“按 y 搜索”。
- `container`/`offers`：打开窗口是异步的，查询以 `pending` 返回并由执行器轮询；3s 未打开窗口返回 `CONTAINER_TIMEOUT`/`OFFERS_TIMEOUT`。
- `moveTo`：`blockedMs` 内无进展时每 300ms 脉冲一次 `jump`（forward 保持按住），可上一格台阶；更高的墙仍按 `MOVE_TO_BLOCKED` 失败。
- 能力门控：provider 声明 `capabilities`（`src/provider/mineflayer.ts` 的 `PROVIDER_CAPABILITIES`），`DeclaredOpBroker` 对未声明的能力返回 `CAPABILITY_MISSING`。capabilities 目前**未纳入 bindingId**（binding 仍由 body manifest 计算），这是已知缺口。
- `status` 新增 `version`（bodyVersion）、真实 `connection`、`rescue:{enabled,tpRadius}`；run 进入终态后 `activeAct/activeNode/activeTarget/waiting` 置空。

### 10.4 act 清单

| act | 参数 | 声明 op |
| --- | --- | --- |
| `move-to` / `mine-one` / `stop` / `place-block` / `attack-one` / `equip-item` / `use-item` | 同 §3.3 | 不变 |
| `craft` | `{item,count?,table?}` | `craft`,`stop` |
| `furnace-load` | `{pos,input:{item,count},fuel:{item,count}}` | `container-transfer`,`stop` |
| `furnace-take` | `{pos}` | `container-transfer`,`stop` |
| `chest-transfer` | `{pos,action:'deposit'|'withdraw',item,count?}` | `container-transfer`,`stop` |
| `toss-item` | `{item,count?}` | `toss`,`stop` |
| `sleep` | `{pos?}` | `blocks`,`sleep`,`stop` |
| `respawn` | — | `respawn`,`stop` |
| `interact` | `{entityId,item?}` | `equip`,`interact`,`stop` |
| `trade` | `{entityId,index,count?}` | `trade`,`stop` |
| `mount` | `{entityId}` | `mount`,`stop` |


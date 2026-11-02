# 踩坑清单（mineflayer / body / DSH）

> 本文件只记录**已经踩过并验证过**的坑与对应规则。实现 P2Mind 前必读：适配器、Tracker、建造 driver 都会直接撞上这些。
> 每条格式：**现象 → 机理 → 规则**。

## 1. mineflayer / 协议层

### 1.1 `bot.dig()` 的 promise 不是证据
- **现象**：`dig` resolve 了，方块还在；或超时了，方块已经没了。
- **机理**：dig 成功 = 本地计时器 + 本地把方块置空气，服务端随后才确认/回滚；被中断会 reject `Digging aborted`。
- **规则**：以读回为准；读回要两次（间隔 ~200ms）但只算“稳定性观察”，不是“服务端已接受”；需要强证据时走独立观测路径。

### 1.2 `placeBlock` 没有错误码
- **现象**：失败只有文本（`the block is still air` / `Server refused to place`），且判定是启发式的。
- **规则**：不要解析错误文本做控制流；用“目标读回 + 换面/换点/换材料重试”收敛。门/床这类带状态方块用 `name + state 子集` 匹配。

### 1.3 `equip()` 之后 `heldItem` 可能是空
- **现象**：`equip` 成功返回，`placeBlock` 报 `must be holding an item to place`；物品随后消失（被放到别处）。
- **机理**：热栏/窗口同步滞后；窗口打开时手持状态不生效。
- **规则**：写操作前 `closeWindow`；`equip` 后校验 `heldItem.name`，不匹配就重试/显式设置热栏；失败返回 `EQUIP_FAILED`，不要继续放置。

### 1.4 开容器会挡住放置
- **现象**：合成/开熔炉之后紧接放置，失败或物品异常。
- **规则**：任何写操作前先关窗口；读熔炉/箱子走独立 `check` Job。

### 1.5 `findBlocks` 的函数匹配器很贵
- **现象**：一次查找几秒，body 心跳被拖死。
- **机理**：函数匹配器会逐段扫 4096 格；传 block id 数组才走调色板快路径。
- **规则**：只用 id 数组；半径与交互距离匹配（见 1.9）。

### 1.6 legacy pathfinder `goto()`（已移除）
- 历史问题：`stop()` 之后 promise 不 resolve；`path_update` + 空路径时“伪成功”。
- **当前**：pathfinder 已从 provider/port 删除，所有移动走 `MotionRun`；这条只保留为历史记录，不要在新代码里重新引入。

### 1.7 `lookAt` / `placeBlock` 依赖物理 tick
- **现象**：物理停摆（区块未加载、死亡、传送中）时，`lookAt` 的 promise 永不 resolve。
- **规则**：所有 await 都有硬超时；超时返回 `unknown`，不重放。

### 1.8 未加载 ≠ 空气
- **现象**：`blockAt` 对未加载区块返回 `null`；`getBlockStateId` 对未加载返回 `0`，与空气同值。
- **规则**：只以 `blockAt !== null` 判“已加载”；`null` 一律 `unknown`，不折成空气。

### 1.9 交互距离
- 方块 4.5 格、实体 3.0 格。`findBlocks` 的 `maxDistance` 常大于交互距离 → “找到也够不到”。
- **规则**：giver 选目标时必须同时检查可达性；driver 不负责“够不着就换目标”。

### 1.10 版本缺口（4.39 + 1.21.1）
- 没有 `mayPlace` / `waitForUpdate` / `noPath` 事件 / `craft` 事件；放置事件是 `blockPlaced`。
- `openContainer(crafting_table)` 必抛（工作台不是容器）→ 合成走 `bot.craft`。
- `takeOutput` 在空槽抛 `AssertionError`（无 message）→ 必须 try/catch。
- `openFurnace` 内部 `once('windowOpen')` 是 20s；外部 10s 超时会留下晚开窗口污染后续。
- `update_time` 只有 `age/time`；`doDaylightCycle` 是推断值，不能当权威。

### 1.11 目标从查询范围消失不等于死亡
- **现象**：攻击后目标从 `entities` 查询里消失，若直接报 `killed`，实际可能只是走出跟踪范围或区块卸载。
- **机理**：`entities` 只覆盖当前跟踪范围；死亡证据只有 `entityDead`，受伤证据是 `entityHurt`。
- **规则**：只有 `entityDead` 才报 `killed`；消失只能报 `targetLost`/`insufficient`，并等待一个短窗口再下结论。

## 2. body / 事件循环 / 心跳

### 2.1 同步忙等会打死心跳
- **现象**：`heartbeat-missed`，body 被重启，控制状态全丢。
- **机理**：心跳 2s / liveness 6s；async 循环里如果没有 `await` 到 **timer**，只跑微任务，事件循环拿不到 I/O，心跳发不出去。
- **规则**：任何等待都要 `await sleep(...)`；不要把“同步轮询 + 偶尔 return false”写成 async 循环；每次长等待前先报 progress。

### 2.2 重启代价
- 重启 = 新 epoch = 控制状态丢失。P2Mind 靠“意图日志 + 世界重建”恢复，不靠内存。

## 3. DSH / 工具层

### 3.1 一次工具往返 = 一次模型回合
- 实测 8–15s。CP1 的 600s 窗口只够 40–75 次动作 → **逐步操作在数学上不可行**。
- 规则：agent 只在 order 与偏离/终态时出现；执行循环在 body 内。

### 3.2 观测有硬顶
- `p2_observe` 同步硬顶约 1000ms；慢查询直接超时。
- 规则：事实源必须同步且快（≤250ms）；需要等待的观测放 `check` Job。

### 3.3 大返回体拖慢一切
- 大段状态返回会拖慢生成并污染上下文。
- 规则：只读精简 `p2_status`、`p2_report` 与必要的事件；不要整包读状态。

### 3.4 工具与身份
- `p2_*` 工具在 body start 后注册；binding 身份随 epoch 变化，不要硬编码 id。

## 4. 世界与验收

- dev 世界每轮必须新建；被挖过的世界会让选址/资源结论失真。
- 验收世界：`keepInventory=true`、`allowCommands=0` 必须在 T0 前用只读脚本核对 `level.dat`。
- 验收世界**不得**使用 RCON、指令、传送、改模式、注入；`level.dat` 只读。
- 证据必须能独立复核：方块/背包/时间 + 意图日志；执行方自报不算证据。

## 5. 速查表（写代码前过一遍）

| 场景 | 必须做 | 禁止 |
|---|---|---|
| 挖/放 | 两次读回、超时返回 unknown | 用 promise resolve 当成功 |
| 放置前 | closeWindow + 校验 heldItem | 直接 placeBlock |
| 找方块 | id 数组 + 可达性检查 | 函数匹配器、超距目标 |
| 移动 | MotionRun 分片 A* + executor 超时/读回 | 裸 await goto；用 pathfinder 状态判无路；盲跳恢复 |
| 任何 await | 硬超时 | 无界等待 |
| 长循环 | 每步 `await sleep`、报 progress | 微任务忙等 |
| 观测 | 单快照、unknown 不折空 | 多源拼盘当同一时刻 |
| 中断 | 结束 job、从世界重建进度 | 恢复 job 内部半步 |
| 证据 | 独立读回 + 意图日志 | 自报即成功 |

## 6. 运动模块（P2Motion，实机验证）

### 6.1 垫脚/搭桥移动的自放置状态
- **现象**：垫脚放置第一块后，执行器下一 tick 复验 `cost` 把刚放的块当障碍，返回 `UNREACHABLE`，中途 abort。
- **机理**：`cost` 同时服务规划与执行；放置移动执行后世界已改变，原“目标格可替换”条件不再成立。
- **规则**：放置类 Move 的 `cost` 只检查**尚未放置**的格；垫脚的可站检查用当前层脚位，不用原始起点。

### 6.2 垫脚放置时机
- **现象**：跳起后立即放置，server 拒绝（目标格仍是空气/玩家 AABB 重叠）。
- **机理**：目标块是脚刚离开的格；脚部必须高于该格顶面（约 +1.0）才不与玩家碰撞。
- **规则**：`pos.y > targetCell.y + 1.0` 后再发放置；失败落地后重置为起跳重试，不向自己脚位重放。

### 6.3 消失不等于死亡
- **规则**：战斗只有 `entityDead` 才报 `killed`；目标离开查询范围报 `targetLost`，并等待短窗口收迟到死亡事件。

## 7. 服务端 block tags（P2Motion，1.21.1 / 26.1 实测）

### 7.1 tags 包的时序与映射
- **现象**：`tags` 可能在 spawn/registry 就绪之前到达；监听晚了就拿不到。
- **机理**：`minecraft-protocol` 按包名 emit；mineflayer 不消费 `tags`，`bot.registry` 在连接流程后段才设置。
- **规则**：`createBot()` 后立即监听；先存 `blockId`，registry 就绪后再映射；`tagsReady=false` 时走名字 fallback，不能把“未就绪”当成“无 tag”。断线重建索引。

### 7.2 tag 的语义边界
- **规则**：tag entries 是 **block id**（`registry.blocks[id]`），不是 state id。
- **规则**：`minecraft:replaceable` 只表示“可被放置替换”，不等于“可穿过”；行走仍看 collision。
- **规则**：`minecraft:doors` 包含铁门；可开用 `mob_interactable_doors`/`wooden_doors`，铁门用 `doors && !openable`。
- **规则**：没有通用 hazard tag；危险仍需最小名表兜底（lava/cactus/sweet_berry/magma/powder_snow/pointed_dripstone 等）。

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

### 1.6 `pathfinder.goto()` 可能永久 pending
- **现象**：`stop()` 之后 promise 不 resolve；或 `path_update` + 空路径时“伪成功” resolve。
- **规则**：永不裸 `await goto`；用 `path_update.status` 区分增量搜索和无路，另做实际位移看门狗 + 硬超时；`stop()` 之后必须 `setGoal(null)`（顺序不能反），再清按键。
- `path_update` 发出后，上游才把结果写入内部 path；不能在监听回调内同步 stop 后就当作停稳，应在下一事件循环确认/处理。
- `allow1by1towers=false` 只禁垂直垫高，不禁搭桥；无放置授权时还必须清空 `scafoldingBlocks`。
- `2.4.5` 的陆地 `maxDropDown` 对支撑方块计数，允许脚部下降 2 格需要设为 3；本项目另按路径节点限制下降 ≤2 格。斜向下落没有完整检查落脚格的 `exclusionStep`，必须补检查，避免踩到岩浆块。真实 A* 地形回归覆盖这两种情况。

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
| 移动 | path_update + 实际位移 + 硬超时 + stop 后 setGoal(null) | 裸 await goto；用 isMoving 判无路；盲跳恢复 |
| 任何 await | 硬超时 | 无界等待 |
| 长循环 | 每步 `await sleep`、报 progress | 微任务忙等 |
| 观测 | 单快照、unknown 不折空 | 多源拼盘当同一时刻 |
| 中断 | 结束 job、从世界重建进度 | 恢复 job 内部半步 |
| 证据 | 独立读回 + 意图日志 | 自报即成功 |

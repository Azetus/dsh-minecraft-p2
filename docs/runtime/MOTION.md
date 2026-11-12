# 运动模块（Motion）

> **当前实现**：Combat 由 50ms tick `CombatSession` 独占；移动用 `combatInput` 持久控制，盾用 `offhandHold` 持久 stance，attack 不停止移动/不放下盾。

> 运动模块在真实服务端与当前适配器下执行原版移动/战斗语义；方块语义优先读服务端 block tags。当前边界：水默认 `swim`，梯子/藤蔓可上下，脚手架只作为支撑/放置方块（不做柱内攀爬与侧穿），不安装也不依赖客户端 mod。
> 本文只描述运动模块的当前契约与实现边界。

## 1. 目标与边界

运动模块负责两件事：

1. **移动**：把“从 A 到 B”变成一条可执行、可验证、可取消的路径。
2. **战斗**：围绕一个已锁定的目标，持续完成接近、停步、攻击、走位与撤退。

它不负责：选择目标、决定任务、生成 order、修改计划、扩大任务范围。目标仍由 Agent 决定，P2Mind 只提交目标、约束和取消请求，接收进度与结果。

### 1.1 分层

```text
P2Mind（order / plan / tree / giver / tracker）
        │  BodyApi（moveTo / attack / combatInput 等）
        ▼
src/provider/mineflayer.ts + src/provider/motion（适配器：世界、实体、tick、输入、动作）
        │
src/motion/model / search / execute / combat（纯 TS，不 import 适配器）
```

- `src/motion` 核心只依赖自己的 `MotionWorld` 接口，不 import 具体客户端库。
- 适配器负责把客户端的状态、tick、输入和动作映射到 `MotionWorld`。
- `src/mind/drivers/move.ts` 负责移动 job；`attack.ts` 准备武器/盾后返回 `CombatSessionHandle`，由 50ms tick 驱动。
- 同一时刻仍只有一个执行者；运动模块不绕过 JobTracker 的写令牌、停止确认与暂停语义。

### 1.2 复用点

- **建造**：giver 在选择 stage/stance 时可以调用只读的 `isReachable(cell)` / `pathTo(cell)`，用同一套规则筛掉不可达站位，而不是“几何看起来能站”。
- **战斗**：追击、接敌、走位直接调用 `moveTo` / `followTarget`，不另写一份寻路。
- **采集/交互**：`moveTo` 的接近语义与放置/挖掘的站位校验共用同一套规则。

## 2. 规则集（Movement Model）

### 2.1 世界视图

`MotionWorld` 提供只读视图与执行原语：

```ts
type RawBlock = {
  loaded: boolean
  name: string
  state: Record<string, string>
  collision?: readonly CollisionBox[]   // 来自方块状态；缺失 = 未知
  serverTags?: ReadonlySet<string>      // 服务端 block tags；undefined = 尚未就绪
}
type MotionWorld = {
  self(): { pos; velocity; yaw; pitch; onGround; sneaking; sprinting; health }
  blockAt(p): RawBlock | null            // null = 未加载
  entities(box): EntityView[]
  tick(): number
  onTick(cb): () => void
  setInput(control, on): void
  look(yaw, pitch): void
  useOn(p): void
  place(p, item): void
  dig(p): void
  attack(entityId): void
  releaseAll(): void
}
```

规则：

- `blockAt(p) === null` 或 `loaded === false` 都表示**未加载**，不是空气。
- 碰撞体来自方块状态（适配器给 `block.shapes`），不由规则层硬编码方块名。
- 语义（危险、门、可攀爬、可替换等）来自可替换的 `BlockClassifier`：规则只读标签，不读方块名；原版名称表集中在 `semantics/vanilla.ts`，换内容集不需要改规则或搜索。
- 液体、危险方块、门/栅栏门等用标签/状态判断；未知一律按不可用处理。
- 所有查询在一次规划/执行快照内保持一致；执行中重新读取时以新快照为准。

### 2.1.1 服务端 block tags（tag 优先）

`minecraft-data` 没有 block tag 数据，但服务端会下发原版 `tags` 包。适配器在 `createBot()` 后立即监听 `bot._client` 的 `tags`，按连接维护 `BlockTagIndex`：

- 原始数据是 `Map<tagName, Set<blockId>>`；`bot.registry` 可用后再映射为 `blockId -> Set<tagName>`；
- `tagsReady=false` 时 `serverTags` 为 `undefined`，分类器走名字/后缀 fallback；不能把“没有 tags”当作“没有危险”；
- 映射后的空集合表示“已就绪且该方块没有 tag”，与“未就绪”区分；
- 每个 bot 一份索引，断线重建；不引入进程全局版本状态。

分类优先级：

| 语义 | 服务端 tag | fallback |
|---|---|---|
| 门 | `minecraft:doors` | `_door` 后缀 |
| 可开 | `minecraft:mob_interactable_doors` / `minecraft:wooden_doors` | 非 iron 的 `_door` |
| 栅栏门 | `minecraft:fence_gates` | `_fence_gate` 后缀 |
| 可攀爬 | `minecraft:climbable` | CLIMBABLE 小表 |
| 可替换 | `minecraft:replaceable` | REPLACEABLE 小表 + AIR |
| 火/营火危险 | `minecraft:fire` / `minecraft:campfires` | HAZARD_NAMES 小表 |
| 其他危险 | 无通用 tag | HAZARD_NAMES（最小表） |
| 固体 | collision 非空 | `solid` / 兼容名表 |

约束：

- `minecraft:replaceable` 只表示“可被放置替换”，**不等于可穿过**；行走仍以 collision 为准。
- 上锁门用 `doors && !openable` 判定，未识别的新红石门不会被误开。
- tag 缺失或未知时，危险结论保持 `unknown`，不得默认安全。
- `pale_oak_door` 由 `wooden_doors`/`mob_interactable_doors` 自动识别，不依赖名字表。

### 2.2 共享谓词

规划器与执行器必须使用**同一组**谓词：

- `canWalkThrough(cell)`：脚部/头部可通过。
- `canWalkOn(cell)`：可作为支撑面。
- `canPlaceAgainst(cell)`：可作为放置参照。
- `isDoorPassable(cell, side)`、`isGatePassable(...)`。
- `isHazard(cell)`：岩浆、火、仙人掌、甜浆果、泡沫柱等。
- `isClimbable(cell)`、`isWater(cell)`、`isLava(cell)`。
- `standable(cell)`：2 格净空 + 支撑 + 非危险。
- `supportFeet(cell)`：只算支撑面（不判身体）得到的脚高，用于“身体检查暂时无意义”的场合（垫脚刚放下的方块、从半砖起跳、落点判定）。

支撑高度按**玩家 footprint** 取最大面（`supportTopAt`，采样 0.2/0.5/0.8），不是格中心单点：楼梯的两个碰撞盒正好在中心分开，单点采样会得到 0.5 并被踏步盒判成 body-collision，footprint 采样才得到真实可站的 1.0。半砖仍是 0.5、上半砖/整方块 1.0、地毯 0.0625、栅栏 >1（拒绝）。

水的语义按 `waterProfile`：

- `none`：所有流体格不可通行（保守行为）。
- `wade`：仅接受“脚格是水、头格不是水、水下是完整可走地面”的单格水深；脚湿头干，可以走过去、跳出来、落进去。更深的水列需要 waterline 控制器，仍为 `no`。
- `swim`：在 `wade` 之上额外接受任意深度的**水面格**：脚在顶层水格、头格为空气、不需要水底支撑；不下潜，水下格不是节点。默认档位。

谓词返回三态时，未知一律按“不可用”处理，不能折成可用。所有谓词使用同一份规则快照；`RuleSet.invalidate()` 在每个执行 tick 开始时清缓存。

### 2.3 约束

`MotionConstraints` 把“这次移动允许什么”集中传入：

> `profile:'sprint'` 只让 `Traverse`（平地直线）按住 sprint；`Ascend/Descend/Fall/Parkour` 等仍走 `walk`，并在每个 move 的每拍把 sprint 关掉。`go { sprint:true }` 是唯一入口，默认关闭；move driver 在 `food <= 6` 时丢弃该授权（原版饥饿门槛），`risky`（vanilla planner）忽略 sprint。客户端物理会应用冲刺速度修正；服务端只校验位移上限。

```ts
type MotionConstraints = {
  profile: 'walk' | 'sprint' | 'parkour' | 'descend' | 'ascend'
  allowBreak: boolean          // 默认 false
  allowPlace: boolean          // 默认 false；搭桥/垫脚必须显式授权
  allowParkour: boolean        // 默认 false
  allowDiagonal: boolean       // 默认 false（先直线）
  allowClimb?: boolean         // 默认 true；梯子/藤蔓
  waterProfile: 'none' | 'wade' | 'swim' // 默认 swim；none/wade 显式关闭
  allowFallOntoHalfSupport?: boolean   // 默认 false；落半砖/地毯
  allowParkourFromHalfSupport?: boolean // 默认 false；从半砖起跳
  maxFall: number              // 允许的无水落差
  allowFallIntoLava: boolean
  assumeWalkOnWater: boolean
  allowWalkOnMagma: boolean
  worldBorder?: { min; max }
  minY?: number
  maxY?: number
  material?: string            // 搭桥/垫脚的方块
  hasThrowaway?: boolean
  toolset?: string[]
}
```

约束只影响“这次规划/执行允许的边”，不改变目标。

## 3. Move：一条边 + 一个逐 tick 状态机

### 3.1 接口

```ts
type MoveStatus =
  | 'prepping' | 'waiting' | 'running'
  | 'success' | 'unreachable' | 'failed' | 'canceled'

interface Move {
  readonly src: Cell
  readonly dest: Cell
  cost(ctx: MoveContext): number          // 不可能时返回 COST_INF
  validPositions(): Cell[]                // 执行中允许出现的脚位
  update(state: MoveState, ctx: MoveContext): MoveStatus
  reset(): void
  safeToCancel(state: MoveState): boolean
  toBreak(): Cell[]
  toPlace(): Cell[]
}
```

- `cost` 由规划器和执行器共用；执行器在运行时重新计算，变成 `COST_INF` 就中止。
- `validPositions` 用于“被推离/传送/卡住后回到路径”的恢复。
- `update` 是逐 tick 的：设置输入、看向、放置、挖掘、等待；返回状态。它读取 `MoveContext`（世界、规则、约束、自身、tick），便于同一状态机在纯逻辑环境与真实适配器间复用。
- `safeToCancel` 决定能否在移动中途切换路径；放置/搭桥过程中通常不允许。
- `toBreak`/`toPlace` 是“这条边需要先改变的世界”，不是目标选择。

### 3.2 状态

`prepping`（先破块/先转视角/先放支撑）→ `waiting`（等待条件）→ `running`（逐 tick 执行）→ `success` / `unreachable` / `failed` / `canceled`。

- `unreachable`：世界在规划与执行之间变化，当前边已不可执行。
- `failed`：执行器自身无法完成（输入无效、动作被拒、超时）。
- `canceled`：收到取消，已释放输入。

## 4. Move Set

当前 Move Set 以原版地面移动的最小集为基础；桥/垫脚必须显式授权。

- **跳跃类净空**：`Ascend/Descend/Pillar/Parkour` 的 `cost` 与 `toBreak` 共用同一 clearance 集。`jumpClearance` 由真实脚高 + `JUMP_PEAK` + `PLAYER_HEIGHT` 推出顶点覆盖格（含 `src.above(2)`/`dest.above(2)`/gap 中间列；只裁掉 <0.1 格的擦碰，3 高走廊仍可 +1 跳）；`Descend` 额外查 `dest.above(2)`；`Pillar` 每一级都查自己的顶点净空。规划期不可行的撞头边直接 `COST_INF`，不留给执行器报 `jump-did-not-land`。

| Move | 前置 | 逐 tick | 完成 | 主要失败 |
|---|---|---|---|---|
| `Traverse` | 同层、目标可站、净空、非危险 | 朝向 + forward，必要时开门；离开门格后关门 | 到达目标脚位 | 卡住、被推离、方块变化 |
| `Ascend` | 目标高 1、顶点净空、可站、真实抬升 ≤ `JUMP_PEAK−0.15` | 距离约 1.1 时提前起跳，持续 forward | 站上目标 | 跳早/跳晚、撞头、从半砖起跳过高 |
| `Descend` | 目标低 1、落点可站 | 走出边缘/走落 | 到达低层 | 落点变化、被推下 |
| `Fall` | 落差 ≤ maxFall、落点安全、落点不是半高支撑、可落任意深度水面（swim） | 走出边缘、落地 | onGround 或水面浮体 + 目标脚位 | 落点危险、超深、落半砖 |
| `Downward` | 正下方可站、脚下支撑已消失 | 走落/下降 | 到达 | 落点变化 |
| `Bridge` | 同层、缺支撑、allowPlace、材料 | 潜行接近边缘、放置、读回、前进 | 支撑块读回可站 | 放置失败、读回不符、被推下 |
| `Pillar` | 原地、allowPlace、材料、脚下是完整支撑 | 跳起、脚下放置、读回、落上 | 到达高度 | 放置被拒、读回不符、从半砖起跳 |
| `Diagonal` | 两相邻角都可走/可站 | 斜向移动 | 到达 | 角落卡住、支撑不足 |
| `Parkour` | 冲刺跳 2 格、起跳/落点检查、起点不是半砖/楼梯/梯子 | 起跳、空中、落地 | 到达对岸 | 起跳点偏、落点变化、撞头 |
| `Climb` | 目标格 climbable 且身体可通过；竖直 ±1 或同层相邻 | 对准柱心、上升按 jump / 下降按 sneak / 侧向 forward | 脚在目标格且有攀爬块 | 未贴上梯子、被推离 |
| `ClimbExit` | 起点是 climbable 且身体可通过；目标可站、高 1、直邻或斜邻 | 先跳后前移 | 站上目标 | 跳不出、撞平台侧 |
| `Swim` | 起点是水面格；目标为同层水面或同层/+1 岸、头格干 | 始终 forward；出水或眼入水时 jump | 到达水面/岸脚位 | 卡住、被推离、头部完全没入超过 3 s |

当前不做：水桶、冰面、Elytra、岩浆行走、parkour place、潜水（水面姿态只认“头格不是水”）。

### 4.1 边界地形的默认策略

- **水**：默认是 `swim`：`wade` 仍可走 1 深水；水面格（脚在顶层水格、头格干）可站、可规划，任意深度，不潜水、不做 waterline。`SwimMove` 负责水面→水面（同层）和水面→岸（同层/+1）；它始终按住 forward，出水或眼入水时按住 jump。`standingCell` 把浮体的脚格归一化到水面节点，搜索起点和 `arrived()` 都用它；水格目标到达时允许未 `onGround`（浮在水面即算到达），之后 `escape` 仍可能把身体带向岸边，这是接受的取舍。执行器对 swim 跳过 `isValid/recover`，湿 move 的停滞只看水平位移，水 move 超时 ×3；只有头部完全没入水（眼格与其上一格都是水）持续 3 s 才报 `STUCK`。`escape` 的水线判定同样只认“头完全没入”，并以 dry 格为目标，避免抢占游泳 order；`standCells` 目标选择默认 dry（`pickup` 显式 `dry:false` 保留水格拾取）。
- **梯子/藤蔓**：`Climb` 可用；梯子格本身不可站（无支撑），到达判定用 `onClimb`。`ClimbExit` 负责“梯顶再上一格”（含斜向），即标准二层结构里从梯子穿洞上到楼板；反向（从楼板进梯）走 `Climb` 的 dy=−1。水面 `swim` 档可从水面进入梯子，梯顶再经 `ClimbExit` 上岸；没有可到岸的梯子仍为 no path。
- **脚手架**：只作为支撑/放置方块；支持顶面站立、单块上/下台阶、旁边通过；**不做柱内攀爬与侧穿**。适配器只提供静态 collision shape，柱内/侧穿没有合法移动边，`scaffold-through` 为 no path；柱内攀爬/侧穿不在当前范围，除非专门实现物理层。
- **半砖/楼梯**：collision + footprint 支撑；从下半砖起跳整方块、从下半砖垫脚、落半砖默认拒绝（物理不可行或落点高度歧义）；下半砖→下半砖允许。
- **跳跃预算**：两条"物理不可能"用真实脚高与 1.2522 的跳跃峰值比较，而不是"支撑是不是整方块"——
  - `Ascend`：`destFeet − srcFeet > 1.2522 − 0.15` 才拒绝。所以 farmland/dirt_path（0.9375 → 抬升 1.0625）允许，箱子/灵魂沙（1.125）按余量拒绝，下半砖（1.5）拒绝。
  - `Pillar`：`srcFeet + 1.2522 − 0.15 > src.y + 1.01` 才允许。所以 farmland 起垫脚允许，下半砖/灵魂沙拒绝；放置门限与规划共用同一个 `PLACE_CLEARANCE`。
- **支撑面的已知 over-approximation**：footprint 取最大支撑面会把薄片也算成可站（竹子、墙头、花盆/蛋糕、可可、水晶、推头等 18px 级薄面），部分非楼梯方块因此从“不可站”变“可站”。这是有意的保守方向（宁可多算可站，也不误杀楼梯与 farmland），执行器对因此失败的边有 STUCK 边界；不使用方块名表收窄。
- **楼梯高度近似**：站立高度仍是一格一个值，楼梯每级按 1.0 台阶处理（不做 0.5 平滑上台阶）；这是双高度 cell 之外的显式取舍。

### 4.2 未校验路径（vanilla 式，显式 opt-in）

安全规划器保证“不产生假路”，代价是它不支持的边只能整体拒绝。为保留“像人类玩家一样行动、允许犯错”的灵活性，另有一条**未校验**通道：复刻原版 `WalkNodeEvaluator` + `PathFinder` + `MoveControl` 的思路（1 格节点、无逐边前置、贪心跟随）。它的语义是“尽力而为”，不是“保证可达”。

- 接口：`go { risky: true }`（默认 false）；port `MoveOptions.planner: 'astar' | 'vanilla'`。`risky` 不授予 break/place/parkour/diagonal。
- 目标：按原版 `createPath` 吸附（空气格→其正下方第一块地面之上；实心格→其上一格；其余原样），再做**精度 0** 的精确搜索；未命中时与原版一致，沿“最接近路径”走完并如实报告。
- 结果：`planner`、`unvalidated: true`、`waypoints`、`reachedPlan`、`closest`、`goalAdjustedTo`、`reachedExact`、固定 `note`。
- 失败码：`VANILLA_NO_PATH`（含“走到最近点仍未到达”）、`VANILLA_STUCK`、`VANILLA_TIMEOUT`；均不重试。
- 备选：安全规划器以 `GOTO_NO_PATH` / `GOTO_SEARCH_TIMEOUT` 失败时，附 `observed.alternative = { planner:'vanilla', unvalidated:true, available, waypoints, closest }`；只报告、不执行。
- 排除仍用 tag：`hazard` / `lava` → 不是节点；不新增危险方块表，不做风险检测或评分。
- 节点桶：`walkable / water（仅水面格）/ climbable / door`；深水内部没有节点（即不潜水）；`door` 只对可开的门/栅栏门成立，锁门仍是“不是节点”。
- 落预算 **3**：原版 `Mob.getMaxFallDistance()` = `floor(0 + 3)`（追击时按血量/难度放宽，不建模）。
- 跟随：推进容差 0.45 水平 / 1.0 垂直（原版 `PathNavigation.followThePath`）；卡住窗口 5 s（100 ticks），只上报不重规划。
- 搜索预算：区域 32 格、1024 节点、250 ms（原版是 `floor(followRange * 16)` 节点、`followRange + 8` 区域）。
- 参考边界：原版对岩浆/栅栏/闭门/冰面等由 `PathType` malus 排除，对火/甜浆果等是“可通行但有代价”；我们只保留“危险 → 不是节点”，其余不建模。
- 目标选择直接采用原版的“建目标 + 精度 0”；不在节点图上另做 BFS 目标选择。
- 非目标：风险检测/评分、每方块危险枚举、break/place/parkour/diagonal、潜水/waterline/氧气、第二套 Rules、跟随中重规划、路径质量指标。

### 4.3 桥与垫脚的策略边界

- 默认 `allowPlace=false`：高处不可达就 `item blocked` / `unreachable`，不自动改变世界。
- 只有 order/policy 显式授权时才允许 `Bridge`/`Pillar`，并把放置的材料、预算、失败原因写进结果。
- 桥/垫脚的完成条件是“支撑块读回可站”，不是“放置调用返回”。
- `Pillar` 在脚部高于目标格顶面后才发放置；跳起后立即放置会被服务端拒绝。失败后落地，按起跳状态重试，不向自己脚位重放。
- `Bridge`/`Pillar` 的 `cost` 只检查尚未放置的格；执行中复验使用当前层脚位，不把刚放下的块当障碍。

## 5. 规划器

### 5.1 搜索

- 节点：脚位格（`Cell`）。
- 起点身份 `standingCell(rules, pos)`：按真实脚高匹配节点的 `standInfo.feetY`，而不是用 `cell.y` 猜；下半砖（脚 63.5）、farmland（63.9375）等非整数脚高都归一到其上的脚格。中心列不可站时按 0.6 宽 AABB 的四角列兜底；水面仍归一到水面节点。搜索起点、`arrived`、执行器 `validPositions`/`recover` 共用这一个函数。
- 边：上面 Move Set 中 `cost < COST_INF` 的 Move；**物理不可行的边在规划期就不存在**。
- A*：`g = 已走代价`，`h = 切比雪夫距离`；每个邻居先构造 Move，再用同一套 `cost` 过滤。
- 预算：时间片（默认 5ms/步）+ 节点数（默认 20k）+ 总超时（默认 3s）；分片执行，不阻塞 tick/心跳。
- 取消：可中断；返回 `best-so-far`（部分路径）与原因；执行器只把前缀当前缀，不把前缀当到达。
- 缓存：每次搜索切片重新取一份 `MoveContext`（规则缓存按切片失效）；执行器在每个 tick 重新复验当前边。
- 默认使用自研 A*；no-path 只允许一次 vanilla fallback，随后不重试。

### 5.2 失败反馈

| 类别 | 例子 | 处理 |
|---|---|---|
| 模型缺口 | 规划说可行，执行说不可行 | 补规则/代价，加回归用例 |
| 瞬时变化 | 被推、方块更新、区块卸载、lag | 局部修复/从当前格重规划 |
| 执行器 bug | 起跳时机、朝向、输入时序 | 修执行器 |
| 确实不可达 | 目标被封闭/超出边界 | `unreachable`，上报 |

原则：**先局部修复，再全局重规划**；同一 `(move, 位置, 世界指纹)` 在当前运行内可临时拉黑，避免原地打转。

## 6. 执行器

### 6.1 逐 tick 校验

- 当前脚位不在 `validPositions`：在整个剩余路径上向前扫描，再向回扫描，命中即重同步（不只容忍 ±4 条边）；`Ascend` 的合法位置含 `src.above`/后方上一格，`Descend` 含 `dest.above`，`Fall/Downward` 含整段下落列。
- 真实 0.6×1.8 身体 AABB 与已加载方块的碰撞相交（半嵌、1 格高小窝）：规划前与到达后各检查一次，直接失败 `BODY_OVERLAP`，`observed.blockedBy` 列出 `{x,y,z,name}`；不对“从身体内部出发”的边反复规划。未加载/未知碰撞只进 `unknown`，不算 overlap。
- 精确到达（`arrival.kind === 'exact'`）的目标格必须可站；不可站直接 `GOAL_NOT_STANDABLE`（带 `reason`/`blockedBy`），不悄悄结束在下一层。
- 到达容差：干地水平 **0.45**（`0.75 − bbWidth/2`），水面 1.0；`arrived` 以 `standingCell` 的脚格 + `standInfo.feetY` 判定，只接受目标脚位，不使用“目标列内、下一层”的宽松回退。成功体带 `arrival{kind,policy,from,to,cell,feetY,at,movedDistance,elapsedMs}`。
- 当前 Move 的 `cost` 重新计算变成 `COST_INF`：中止 `UNREACHABLE`。
- 当前 Move 耗时超过“原代价 + 宽限”：中止 `TIMEOUT`。
- 无位移超过 `stallMs` 或离路径太远：中止 `STUCK`。
- 执行器在完成/失败/取消时都 `releaseAll()`；不把“移动调用返回”当成功。
- 取消时执行器按 `safeToCancel` 判断当前 Move 是否可立即释放；放置/搭桥已改变世界时不伪造“未发生”，按实际读回与 `canceled` 上报。

### 6.2 取消与清理

- 收到取消：请求停止 → 释放全部输入 → 停止挖掘/使用 → 回报 `canceled`。
- 停止不可确认：按现有 `STOP_UNCONFIRMED` 语义上报，不假装停稳。
- 暂停（服务器冻结）：冻结执行器，恢复后重读世界再继续；暂停不计失败。

## 7. 战斗

### 7.1 控制器

锁定目标后持续维护：

- `targetId`：当前目标；目标死亡/丢失/受保护时由 session 在允许集合内切到最近可用目标，见 `targets`。
- `attackCooldown`：由当前攻击速度属性的 **final value**（base + 物品 modifiers）计算，不用固定毫秒；如铁剑 1.6 → 625ms。
- `visible`：适配器视线/遮挡；看不到时不隔墙攻击。
- `distanceBand`：**眼→目标 AABB 最近点**距离；目标盒由适配器 `width/height` 构成（缺失按 0.6×1.8），眼睛高度 `height-0.18`。`reach` 来自 `attackReach?()`（玩家 `player.entity_interaction_range`，含物品 modifiers，默认 3）；带为 `[reach-0.8, reach-0.2]`，中值 `reach-0.5`，`tooClose=reach-1.4`。超出 `reach` 先接近（停距按 `desired + targetWidth/2`，不再固定 `reach-1`）；进入 `reach` 后按间距决策。
- `guard`：自血下降后进入 `GUARD_MS=1000ms` 的原地保护窗（每次掉血刷新；要求副手有盾）。窗口内移动 `hold`，但攻击和盾照常；`distance < tooClose` 仍 backoff，`distance > reach` 仍 approach。退出条件为计时到期、无盾、目标丢失/死亡/job 结束。
- `spacing`：`CombatSession` 每 50ms 用 `decideCombatMove` 选择 `approach/hold/backoff/strafe-left/strafe-right`；移动通过 `combatInput` 持久控制，body 保持到下一拍。目标不面向我们时不 strafe；同一方向保持 4 步后 `nextStrafeSide` 换向；连续 4 个攻击窗口无伤害时停止侧移，移动无进展只抑制侧移。持续 blocked 或 LOS 丢失时改用 `pathTo` waypoint 跟随。
- `targets`：`entityId + entityIds` 是允许集合；当前目标死亡/丢失/受保护时切到最近可用目标，记录 `targetSwitches`；不自行扩大集合。`chaseLeash` 限制从起点算的追击距离；target 超界记 `escaped`（engagement）或 `ATTACK_CHASE_LIMIT`（显式）。
- `LOS`：`canSee=false` 时向目标/最后可见位置短距重定位，`losRecoveryTicks` 预算内恢复；超过短预算时用 `pathTo` 规划 waypoint，再由 50ms tick 跟随；超时才 `ATTACK_NO_LINE_OF_SIGHT`。普通可见追击不使用阻塞 `moveTo`。
- `threat`：`threatCount`/`rangedThreat`/`explosionThreat` 只作观测，不自动 escape。`creeperBackpedal` 为 opt-in 短距 backoff，默认关闭；有盾时无额外生存收益，无盾时只方向性减少爆炸伤害。
- `movement safety`：`combat-input` provider 检查下一格的脚/头/支撑/液体/火/岩浆/仙人掌；允许 1 格上台阶（jump）和 1 格下台阶（`aheadBelow` 空气 + `aheadBelow2` 实体），2+ 格落差/坑仍 blocked；不安全返回 `COMBAT_INPUT_BLOCKED`，session 先 jump/短 detour，持续 blocked 时改用 `pathTo` waypoint，都不可达才 hold。1 格方向 + 每 tick 重新评估，不做 2 格 burst。
- `shield`：`offhandHold(true)` 持久保持副手盾；进入 `preShieldRange`（默认 12）提前举起。attack 不停止移动、不放下盾；stop/endWrite/epoch/suspended/death/disconnect 释放。适配器没有 `offhandHold` 时 `shield:false`，不退回 timed useItem。
- `auto-swap`：attack job 开头若副手为空且背包有盾，自动换盾；不替换非空副手，结果写 `shieldAutoEquip`。
- `recheck`：冷却结束后、真正发 `attack` 前重新读目标；等待期间移动、遮挡或死亡的目标不补刀。每次挥击前 `lookAt`；失败不取消攻击。
- `lostReason`：超出范围/卸载/死亡/失去视线。
- 当前不包含远程、暴击。

目标选择仍归 Agent；控制器只执行，不换目标。

### 7.2 证据

- `attacksIssued`：发出攻击次数。
- `damageObserved`：短窗口内观察到目标受伤，且能归因到本方攻击。
- `deathConfirmed`：观察到目标死亡（`entityDead`）。
- `targetLost`：超出跟踪范围/卸载/视线丢失。
- `rejectedSwings`：等待后的新鲜复核拦下的“本可发出”的挥击次数；只作证据，不改变终态。
- `shieldUses`：成功完成的 timed offhand `useItem` 次数。
- `shieldFailures`：timed offhand `useItem` 失败次数（不含 `lookAt` 失败）；本场失败后禁用 timed 举盾。
- `stanceRaises` / `stanceDrops` / `stanceReleaseFailures` / `shieldHeldMs`：持久 off-hand stance 的举起/放下/释放失败次数与累计持有时间。
- `guardWindows` / `guardExits`：hurt guard 的决策窗口数与按计时退出次数。
- `shieldAutoEquip`：attack driver 的自动换盾结果（`equipped`/`present`/`skipped`/`failed`/`no-shield`）。
- `combatMoves` / `moveFailures` / `noSafeCell` / `strafeMoves` / `backoffMoves`：Step 2 间距移动的次数与失败；只作证据，不改变 `state/code`。
- `shieldedSteps`：步进期间实际激活盾牌的 A-step 次数；`stepFallbacks`：上一层候选回退 C 的次数；`stepBlocked`：A-step 失败/无进展次数。
- `reach` / `reachSource`：本次交战采用的 eye→AABB reach 及其来源（`attribute`/`default`/`override`）。
- 只有死亡证据才报 `killed`；单纯从查询范围消失只能报 `targetLost` / `insufficient`。

## 8. 与 P2Mind 的接口

- `BodyApi.moveTo(target, opts)` 与 `attack(entityId)` 的输入语义不变。
- `move`/`attack` driver 只做：目标/约束/取消/结果。
- giver 可调用只读的 `isReachable` / `pathTo` 做站位筛选；它不执行、不产生 job。
- **最近可站查询收归 core**：`standCells` / `nearestStandCell`（`motion/search/stand.ts`）输入目标、`reach`（horizontal/vertical 包络）、可选业务谓词，输出按目标距离排序的可站格、每格 `feetY`、可达三态（`yes/no/unknown`）、`reason` 与 `coverage`。调用方只做排序/筛选策略，不复制半径、垂直窗口或 standability 判断。
  - 可达性用 `reachFrom`：与 A* 相同的 `motionNeighbors` + `Rules`，BFS 按步数；`complete=false`（节点预算耗尽）时未覆盖的格是 `unknown`，**预算不当作不可达**。未加载格与 A* 一样视为阻挡，因此 `complete` 的否定结论与执行器一致。
  - `approach` 用它选站位：无候选 → `APPROACH_NO_STAND`；有候选但全部证明不可达 → `APPROACH_NO_PATH`；窗口未加载 → `APPROACH_UNKNOWN`（可重试）。
  - `pickup` 用它选拾取格，AABB/可拾取/合并/过期仍留在 pickup 层；谓词拿到真实 `feetY`，半砖上的掉落物按真实支撑高度处理，不用格底近似。
  - `pickup` 不把 item 位置当移动目标：只走 core 证明可站/未知的候选格；已证明不可达的格只作为证据。无候选时 `observed.standQuery.requiredDig` 给出 `Rules.standInfo` 的 `blockedBy`（`support/feet/head` + 方块名）；有候选但全部不可达时给 `unreachableReason:"path-blocked"` + `candidateCells`，不逐格重试 `GOTO_NO_PATH`。
  - `pickup` 的候选格还要求**双向连通**：`standCells` 只证明 `起点→候选`，pickup 在进入前用同一套 move 边做有界 A* 证明 `候选→起点`（512 节点；A* 而不是 BFS，因为平地 BFS 在 4 格外就会耗尽预算）。证明不了 → `returnReason:"no-return"`，预算耗尽 → `returnReason:"return-unknown"`；两者都不进入，报 `PICKUP_NO_RETURN` / `COLLECT_NO_RETURN`，`candidateCells[].returnable` 给出每格判定。1×1×2 与 2×2×2 坑底只能“掉进去”，属于该拒绝路径。
  - `Rules.standInfo` 的 `no` 结果带可选 `blockedBy`（支撑/脚/头格 + 方块名），供 approach/pickup/place 直接给出“清哪格”。
  - `givers/common.nearestStandable/farthestStandable`、`escape.nearestCoveredStandable` 也走同一查询。
- `moveTo` 始终走运动执行器；显式 `unstickDig` 作为 core break 白名单，不存在 `goto` 路径。
- `MotionRun` 接管未加载目标：沿直线推进最多 16 格到已加载可站前缀（`activeTarget`），执行前缀后重新解析；最终目标仍由 `finalGoal` 判定。
- `placement` 的可达性偏好使用 core `reachableCells`（与 A* 相同 Move 边/Rules，96 节点有界 hint），不维护局部 BFS。
- `traverse` order 委托 motion 的 `moveTo { allowPlace, material }`；provider 不提供 `pillarUp`/`pillar`。**致命退出**（lava/void/lethal_fall）由 Agent 层 `fatal` driver 执行，不进入 A*。
- 所有对外结果包含：`state`、`reason`、`position`、`bestReachable`（如有）、`attempts`（如有）、`elapsedMs`。
- `observed` 保留 `from / target / at / pathStatus / bestReachable / path / candidates / actions / safeFallPass / healthBefore / healthAfter / elapsedMs`；`planner` 标识本次规划器；Agent 层 `fatal` 的结果由 driver 自己记录。
- 失败码保持可分类：`NO_PATH` / `UNREACHABLE` / `STUCK` / `TIMEOUT` / `CANCELED` / `STOP_UNCONFIRMED` / `PLACE_FAILED` / `BODY_OVERLAP` / `GOAL_NOT_STANDABLE` / `OBSERVATION_UNAVAILABLE` / `APPROACH_NO_STAND` / `APPROACH_NO_PATH` / `APPROACH_UNKNOWN`。

## 9. 非目标

- 客户端 mod、mod 内容、跨版本/多加载器矩阵。
- 自动搭桥/垫脚（除非 order/policy 显式授权）。
- 水桶、冰面、Elytra、岩浆行走、完整跑酷矩阵。
- 潜水/水下节点/waterline 控制器/氧气/溺水；气泡柱、水流。
- 脚手架/树干攀爬（脚手架只作为支撑/放置方块）。
- 第二个控制器、第二个调度器、第二套规则。

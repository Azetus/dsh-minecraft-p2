# 运动模块（Motion）

> 状态：P0–P4 已实现；1.21.1 与 26.1 均用真实服务端 + 当前适配器跑通移动矩阵；方块语义优先读服务端 block tags。
> 范围是**原版兼容环境**：不安装、不依赖任何客户端 mod；P2 通过当前唯一适配器接入，执行基线为原版移动与战斗规则。
> 本文只描述运动模块自身的契约与实现边界，不记录外部参考项目的名称或代码。

## 1. 目标与边界

运动模块负责两件事：

1. **移动**：把“从 A 到 B”变成一条可执行、可验证、可取消的路径。
2. **战斗**：围绕一个已锁定的目标，持续完成接近、停步、攻击、走位与撤退。

它不负责：选择目标、决定任务、生成 order、修改计划、扩大任务范围。目标仍由 Agent 决定，P2Mind 只提交目标、约束和取消请求，接收进度与结果。

### 1.1 分层

```text
P2Mind（order / plan / tree / giver / tracker）
        │  ClientPort.moveTo / attack（现有语义不变）
        ▼
src/motion/mineflayer（适配器：世界、实体、tick、输入、动作）
        │
src/motion/model / search / execute / combat（纯 TS，不 import 适配器）
```

- `src/motion` 核心只依赖自己的 `MotionWorld` 接口，不 import 具体客户端库。
- 适配器负责把客户端的状态、tick、输入和动作映射到 `MotionWorld`。
- `src/mind/drivers/move.ts` 与 `attack.ts` 退化为薄包装：提交目标/约束/取消，接收结果。
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
| 固体 | collision 非空 | `solid` / legacy 名表 |

约束：

- `minecraft:replaceable` 只表示“可被放置替换”，**不等于可穿过**；行走仍以 collision 为准。
- 上锁门用 `doors && !openable` 判定，未识别的新红石门不会被误开。
- tag 缺失或未知时，危险结论保持 `unknown`，不得默认安全。
- `pale_oak_door` 在 26.1 由 `wooden_doors`/`mob_interactable_doors` 自动识别；1.21.1 数据没有该方块。

### 2.2 共享谓词

规划器与执行器必须使用**同一组**谓词：

- `canWalkThrough(cell)`：脚部/头部可通过。
- `canWalkOn(cell)`：可作为支撑面。
- `canPlaceAgainst(cell)`：可作为放置参照。
- `isDoorPassable(cell, side)`、`isGatePassable(...)`。
- `isHazard(cell)`：岩浆、火、仙人掌、甜浆果、泡沫柱等。
- `isClimbable(cell)`、`isWater(cell)`、`isLava(cell)`。
- `standable(cell)`：2 格净空 + 支撑 + 非危险。

谓词返回三态时，未知一律按“不可用”处理，不能折成可用。所有谓词使用同一份规则快照；`RuleSet.invalidate()` 在每个执行 tick 开始时清缓存。

### 2.3 约束

`MotionConstraints` 把“这次移动允许什么”集中传入：

```ts
type MotionConstraints = {
  profile: 'walk' | 'sprint' | 'parkour' | 'descend' | 'ascend'
  allowBreak: boolean          // 默认 false
  allowPlace: boolean          // 默认 false；搭桥/垫脚必须显式授权
  allowParkour: boolean        // 默认 false
  allowDiagonal: boolean       // 默认 false（先直线）
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
- `update` 是逐 tick 的：设置输入、看向、放置、挖掘、等待；返回状态。它读取 `MoveContext`（世界、规则、约束、自身、tick），便于同一状态机在纯测试和实机间复用。
- `safeToCancel` 决定能否在移动中途切换路径；放置/搭桥过程中通常不允许。
- `toBreak`/`toPlace` 是“这条边需要先改变的世界”，不是目标选择。

### 3.2 状态

`prepping`（先破块/先转视角/先放支撑）→ `waiting`（等待条件）→ `running`（逐 tick 执行）→ `success` / `unreachable` / `failed` / `canceled`。

- `unreachable`：世界在规划与执行之间变化，当前边已不可执行。
- `failed`：执行器自身无法完成（输入无效、动作被拒、超时）。
- `canceled`：收到取消，已释放输入。

## 4. Move Set

先做原版地面移动的最小集；桥/垫脚必须显式授权。

| Move | 状态 | 前置 | 逐 tick | 完成 | 主要失败 |
|---|---|---|---|---|---|
| `Traverse` | P1 已实现 | 同层、目标可站、净空、非危险 | 朝向 + forward，必要时开门 | 到达目标脚位 | 卡住、被推离、方块变化 |
| `Ascend` | P1 已实现 | 目标高 1、头顶净空、可站 | 接近后跳 | 站上目标 | 跳早/跳晚、撞头 |
| `Descend` | P1 已实现 | 目标低 1、落点可站 | 走出边缘/走落 | 到达低层 | 落点变化、被推下 |
| `Fall` | P1 已实现 | 落差 ≤ maxFall、落点安全 | 走出边缘、落地 | onGround + 目标脚位 | 落点危险、超深、掉液体 |
| `Downward` | P1 已实现（保守） | 正下方可站、脚下支撑已消失 | 走落/下降 | 到达 | 落点变化 |
| `Bridge` | P3 已实现 | 同层、缺支撑、allowPlace、材料 | 潜行接近边缘、放置、读回、前进 | 支撑块读回可站 | 放置失败、读回不符、被推下 |
| `Pillar` | P3 已实现 | 原地、allowPlace、材料 | 跳起、脚下放置、读回、落上 | 到达高度 | 放置被拒、读回不符 |
| `Diagonal` | P3 已实现，默认关闭 | 两相邻角都可走/可站 | 斜向移动 | 到达 | 角落卡住、支撑不足 |
| `Parkour` | P3 已实现，默认关闭 | 冲刺跳 2 格、起跳/落点检查 | 起跳、空中、落地 | 到达对岸 | 起跳点偏、落点变化、撞头 |

阶段：

- **P1**：`Traverse / Ascend / Descend / Fall / Downward`。
- **P2**：自研分片 A*，替换现有搜索。
- **P3**：`Bridge / Pillar / Diagonal / Parkour`（搭桥/垫脚需授权）。
- 水桶、冰面、Elytra、岩浆行走、parkour place 不在当前范围。

### 4.1 桥与垫脚的策略边界

- 默认 `allowPlace=false`：高处不可达就 `item blocked` / `unreachable`，不自动改变世界。
- 只有 order/policy 显式授权时才允许 `Bridge`/`Pillar`，并把放置的材料、预算、失败原因写进结果。
- 桥/垫脚的完成条件是“支撑块读回可站”，不是“放置调用返回”。

## 5. 规划器

### 5.1 搜索

- 节点：脚位格（`Cell`）。
- 边：上面 Move Set 中 `cost < COST_INF` 的 Move；**物理不可行的边在规划期就不存在**。
- A*：`g = 已走代价`，`h = 切比雪夫距离`；每个邻居先构造 Move，再用同一套 `cost` 过滤。
- 预算：时间片（默认 5ms/步）+ 节点数（默认 20k）+ 总超时（默认 3s）；分片执行，不阻塞 tick/心跳。
- 取消：可中断；返回 `best-so-far`（部分路径）与原因；执行器只把前缀当前缀，不把前缀当到达。
- 缓存：每次搜索切片重新取一份 `MoveContext`（规则缓存按切片失效）；执行器在每个 tick 重新复验当前边。
- P2 起默认使用自研 A*；现有搜索只作为**一次** no-path fallback，随后不再重试。

### 5.2 失败反馈

| 类别 | 例子 | 处理 |
|---|---|---|
| 模型缺口 | 规划说可行，执行说不可行 | 补规则/代价，加回归用例 |
| 瞬时变化 | 被推、方块更新、区块卸载、lag | 局部修复/从当前格重规划 |
| 执行器 bug | 起跳时机、朝向、输入时序 | 修执行器 |
| 确实不可达 | 目标被封闭/超出边界 | `unreachable`，上报 |

原则：**先局部修复，再全局重规划**；同一 `(move, 位置, 世界指纹)` 在当前运行内可临时拉黑，避免原地打转。

## 6. 执行器

### 6.1 逐 tick 校验（已实现）

- 当前脚位不在 `validPositions`：向前/向后寻找可接上的位置，重置中间 Move。
- 当前 Move 的 `cost` 重新计算变成 `COST_INF`：中止 `UNREACHABLE`。
- 当前 Move 耗时超过“原代价 + 宽限”：中止 `TIMEOUT`。
- 无位移超过 `stallMs` 或离路径太远：中止 `STUCK`。
- 执行器在完成/失败/取消时都 `releaseAll()`；不把“移动调用返回”当成功。
- 取消可立即释放；放置/搭桥的 `safeToCancel` 留给 P3 的前置阶段。

### 6.2 取消与清理

- 收到取消：请求停止 → 释放全部输入 → 停止挖掘/使用 → 回报 `canceled`。
- 停止不可确认：按现有 `STOP_UNCONFIRMED` 语义上报，不假装停稳。
- 暂停（服务器冻结）：冻结执行器，恢复后重读世界再继续；暂停不计失败。

## 7. 战斗

### 7.1 控制器（近战已实现）

锁定目标后持续维护：

- `targetId`：不换目标。
- `attackCooldown`：由当前攻击速度属性计算，不用固定毫秒。
- `visible`：适配器视线/遮挡；看不到时不隔墙攻击。
- `distanceBand`：超出 `reach` 先接近；进入 `reach` 后停步攻击。
- `lostReason`：超出范围/卸载/死亡/失去视线。
- 走位、盾牌、远程、暴击仍后置未实现。

目标选择仍归 Agent；控制器只执行，不换目标。

### 7.2 证据（已实现）

- `attacksIssued`：发出攻击次数。
- `damageObserved`：短窗口内观察到目标受伤，且能归因到本方攻击。
- `deathConfirmed`：观察到目标死亡（`entityDead`）。
- `targetLost`：超出跟踪范围/卸载/视线丢失。
- 只有死亡证据才报 `killed`；单纯从查询范围消失只能报 `targetLost` / `insufficient`。

### 7.3 阶段

- 战斗整体排在**移动模块全部完成并通过验收之后**；先做近战：接近 → 停步 → 视线检查 → 冷却就绪 → 攻击 → 重复。
- 走位/盾牌/远程/暴击更后置。

## 8. 与 P2Mind 的接口

- `ClientPort.moveTo(target, opts)` 与 `attack(entityId)` 的输入语义不变。
- `move`/`attack` driver 只做：目标/约束/取消/结果。
- giver 可调用只读的 `isReachable` / `pathTo` 做站位筛选；它不执行、不产生 job。
- `moveTo` 始终走运动执行器；显式 `unstickDig` 作为 core break 白名单，不再回落到 legacy `goto`。
- `MotionRun` 接管未加载目标：沿直线推进最多 16 格到已加载可站前缀（`activeTarget`），执行前缀后重新解析；最终目标仍由 `finalGoal` 判定。
- `placement` 的可达性偏好使用 core `reachableCells`（与 A* 相同 Move 边/Rules，96 节点有界 hint），不再维护局部 BFS。
- `traverse` order 已委托 motion 的 `moveTo { allowPlace, material }`；provider `pillarUp`/`pillar` 已删除。**致命退出**（lava/void/lethal_fall）由 Agent 层 `fatal` driver 执行，不进入 A*。
- 所有对外结果包含：`state`、`reason`、`position`、`bestReachable`（如有）、`attempts`（如有）、`elapsedMs`。
- `observed` 保留 `from / target / at / pathStatus / bestReachable / path / candidates / actions / safeFallPass / healthBefore / healthAfter / elapsedMs`；新增 `planner` 标识本次规划器；Agent 层 `fatal` 的结果由 driver 自己记录。
- 失败码保持可分类：`NO_PATH` / `UNREACHABLE` / `STUCK` / `TIMEOUT` / `CANCELED` / `STOP_UNCONFIRMED` / `PLACE_FAILED` / `OBSERVATION_UNAVAILABLE`。

## 9. 测试与验收

- **验收只认真实游戏**：真实服务端 + 当前适配器；不使用“编造行为”的假执行器作为验收。
- **移动矩阵**：平地、+1 台阶、1 格缺口、门、2 格落差、搭桥、垫脚；每个 Move 有实机用例。
- **运动模块验收不使用 7×7 建造**：建造涉及 stage/stance/放置状态机，会干扰移动结论；建造回归另行安排。
- **轨迹记录**：planned path、actual path、每个 Move 的完成/失败原因；实机失败变成回归用例。
- **纯函数测试**：代价、状态转移、开集、边界条件；标注“非验收”。
- **版本校准**：每个 pin 的客户端/适配器版本重跑移动矩阵；编译通过不等于行为不变。
- **当前证据（P1/P2）**：真实服务端 + 当前适配器，平地/台阶/门/2 格落差通过，实际脚位与目标格一致；1 格缺口按 P1/P2 预期返回 `GOTO_NO_PATH`（Parkour 在 P3）。
- **当前证据（P3）**：真实服务端 + 当前适配器，1 格缺口（Parkour）、2 格搭桥（放置读回）、2 级垫脚、对角移动通过；搭桥/垫脚的放置格读回为授权材料。
- **当前证据（P4）**：真实服务端 + 当前适配器，锁定目标在 `entityHurt`/`entityDead` 证据后报 `killed`；被移出查询范围的目标报 `targetLost` 且 `killed=false`。
- **当前证据（tags）**：1.21.1 实机 `tagsReady=true`，184 个 block tag、1003 个方块；26.1 实机 `tagsReady=true`，248 个 tag、1104 个方块。`oak_door`/`pale_oak_door` 带 `doors/mob_interactable_doors/wooden_doors`，`iron_door` 只有 `doors`，`oak_fence_gate` 带 `fence_gates`，`ladder` 带 `climbable`。
- **26.1 实机**：同一套矩阵在 26.1 服务端通过 P1/P2、P3、P4；`pale_oak_door` 由 tags 自动识别，未使用名字特判。26.1 世界种子不同，但矩阵自建场地，几何结论不依赖原世界生成。
- **当前纯测试**：模型/规则、Move 状态机、执行器恢复、A* 开集与预算、攻击冷却/证据；均标注“非验收”。

## 10. 阶段与删除

### P0：模型与测试场（已完成）

- `MotionWorld` 接口、`Rules`、`Constraints`、`Move` 接口。
- 移动矩阵测试场；只记录 planned vs actual，不改行为。

### P1：执行器优先（已完成）

- `Traverse / Ascend / Descend / Fall / Downward` + `PathExecutor`。
- 先用现有搜索当规划器；目标是“规划出来的路能走完”。
- 失败分类与诊断。

### P2：自研搜索（已完成）

- 分片 A*、预算、取消、best-so-far、缓存失效。
- 替换现有搜索；保留一个周期的 fallback。

### P3：移动能力补齐（已完成）

- `Diagonal / Parkour` 已有 Move 与 A* 邻居，默认关闭；需要显式约束开启。
- `Bridge / Pillar` 已实现；桥/垫脚必须显式授权。
- 移动矩阵覆盖到位，移动模块验收完成。

### P4：战斗控制器（近战已完成）

- **只有移动模块完成并通过验收后才开始**。
- 近战连续控制、冷却、可见性、距离带、证据。
- 走位/盾牌/远程后置。

### 删除清单

新模块通过验收后删除被取代的实现：旧搜索适配、旧分段逻辑、固定攻击间隔、基于“消失即死亡”的判定。不保留新旧双路径。

## 11. 非目标

- 客户端 mod、mod 内容、跨版本/多加载器矩阵。
- 自动搭桥/垫脚（除非 order/policy 显式授权）。
- 水桶、冰面、Elytra、岩浆行走、完整跑酷矩阵。
- 第二个控制器、第二个调度器、第二套规则。

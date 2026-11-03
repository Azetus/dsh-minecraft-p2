# 契约（P2Mind）

> 设计背景见 [P2Mind](runtime/P2MIND.md)。本文只列可实现的接口与不变量。

## 1. 边界

| 边界 | 传输 | 形状 |
|---|---|---|
| bridge ↔ body | JSON-lines stdio | `RequestEnvelope / ResponseEnvelope`（`src/contracts/protocol.ts`） |
| body ↔ 游戏 | `ClientPort` | 纯数据；不传库对象 |
| content ↔ 运行时 | 注册表 + JSON | `content/plans/*.json`；树定义在 `src/mind/trees.ts` |

**不变量**

1. **单写者**：任一时刻只有一个 Driver 持有写令牌；令牌不匹配的写操作在 ClientPort 层被拒绝并记 `stale-write`。
2. **结果三态**：`confirmed / refuted / insufficient`；`insufficient` 不得算成功。
3. **进度可重建**：能从世界重建的优先重建；不能重建的写意图日志。
4. **树不产坐标**：树只选 giver；目标由 giver 选；driver 不得自行推导目标。

## 2. ClientPort

```ts
type Vec3 = { x: number; y: number; z: number }
type BlockInfo = {
  name: string
  state?: Record<string, string>
  loaded: boolean
  collision?: number[][]
  /** Adapter-only server block tags; not serialized to the bridge. Undefined = tags not ready. */
  serverTags?: ReadonlySet<string>
  material?: string
  diggable?: boolean
  hardness?: number
  harvestTools?: string[]
}
type Item = { slot: number; name: string; count: number }

interface ClientPort {
  // 查询
  self(): { pos: Vec3; yaw: number; pitch: number; health: number; food: number; onGround: boolean; inWater: boolean; inLava: boolean }
  blockAt(p: Vec3): BlockInfo | null           // null = 未加载
  blocksIn(box: { min: Vec3; max: Vec3 }, filter?: string[]): BlockInfo[]
  inventory(): Item[]
  entities(box: { min: Vec3; max: Vec3 }): EntityInfo[]
  screen(): ScreenInfo | null                  // 未支持时 null + capability 缺失
  time(): { timeOfDay: number; worldAge: number }

  // 动作（写）：必须持令牌
  beginWrite(token: WriteToken): void
  endWrite(token: WriteToken): void
  moveTo(target: Vec3 | Landmark, opts?: { range?: number; timeoutMs?: number }): ActResult
  lookAt(p: Vec3): ActResult
  lookYaw?(yaw: number): ActResult               // 定向放置（床 head 方向）；可选能力
  dig(p: Vec3): ActResult
  place(p: Vec3, face: Face, item: string): ActResult
  craft(item: string, count?: number): ActResult
  useItem(): ActResult
  useOn(p: Vec3): ActResult
  attack(entityId: string): ActResult
  sleep(bed: Vec3): ActResult
  say(text: string): void                      // 独立限流通道，不受写令牌约束

  // 事件
  on(event: 'blockUpdated' | 'inventoryChanged' | 'screenOpened' | 'damaged' | 'died' | 'chat'
    | 'provider.suspended' | 'provider.resumed' | 'move.started' | 'move.progress' | 'move.no_path'
    | 'move.stuck' | 'move.finished' | 'entityHurt' | 'entityDead', cb: (payload: unknown) => void): void

  capabilities(): Capability[]                // 'navigate' | 'interact' | 'observe.screen' | 'combat'
  /** 暂停是挂起，不是失败；缺省表示适配器不报告。 */
  suspension?(): SuspensionState
  /** 视线/遮挡；缺省表示适配器不能判断，调用方不得当作可见。 */
  canSee?(entityId: string): boolean
  /** 当前攻击速度（次/秒，来自玩家/物品属性）。 */
  attackSpeed?(): number
}

type WriteToken = { runId: string; jobId: string; seq: number }
type ActResult = { state: 'ok' | 'failed' | 'unknown'; code?: string; observed?: unknown; elapsedMs: number }
```

**语义**

- `blockAt` 返回 `null` 表示未加载，**不等于空气**。
- `BlockInfo.harvestTools` 是适配器给出的“可掉落工具”名称列表；`[]` 表示手即可。缺省表示适配器不知道，不能当作“需要任何工具”。
- `dig` order 接受 `params.purpose: "clear" | "harvest"`（默认 `harvest`）：
  - 单格：`{x,y,z}` 保持旧语义；`harvest` 要求背包中有 `harvestTools` 内的工具，否则快速失败 `TOOL_INSUFFICIENT`；`clear` 没有合适工具时可以徒手尝试，但不可破坏方块返回 `BLOCK_UNBREAKABLE`；
  - 体积：`{shape:"box"|"line", from:{x,y,z}, to:{x,y,z}, height? 1–8, only?:string[], preserveFloor? 默认 true, maxBlocks? 1–64 默认 24}`。`line` 要求恰好一个轴不同；超过 `maxBlocks` 直接 `DIG_VOLUME_TOO_LARGE`，不静默截断；
  - 逐格 `approachBlock` → 装备 → 挖 → 两次读回；不可达/未加载/被 `only` 过滤/会挖到自己脚下或身体的格进 `observed.skipped`，不整体失败；部分完成返回 `failed` + `DIG_PARTIAL` + `observed.partial{dug,skipped,stoppedAt}`，不自动重试；
  - `harvest` 在整批结束后统一拾取一次（中心点）；单格 `harvest` 仍在挖后立即拾取；
  - driver 在挖掘前装备所选工具，挖掘后两次读回空气；`harvest` 会走到掉落物处拾取并读回背包增量；掉落已存在但不可达 → `PICKUP_UNREACHABLE`，走到后仍未拾取 → `PICKUP_NOT_COLLECTED`。pickup 只走 `standCells` 的可站/未知候选格，绝不把 item 自身坐标当 `moveTo` 目标；无候选时 `observed.standQuery.requiredDig` 指向要清的支撑/脚/头格，有候选但全部不可达时给 `unreachableReason:"path-blocked"` 与 `candidateCells`。
- `go` 目标只接受已选择的坐标；若已知目标不可站立，giver 会在 2 格内找最近可站立格，找不到则 hold `GO_NO_STAND`。目标未加载时交给 move driver，向前 16 格推进到已加载前缀后再重规划。`go.params.range`（0–8）透传到 move job，不再固定为 1。旧的 `moveTo.approach` 死参数已删除；站位调整只由 giver 的 standability/nearestStandable 完成。
- `p2_order` 的 accepted 结果带 `queue` 摘要：`{active, queued, blockedBy?, holdsActiveSlot?, queuedBehind?, release?}`。`hold` 是占住 active 位的 barrier，不是清空队列；`blockedBy`/`release` 直接指出被哪个 hold 堵住、如何释放。`p2_orders` 的 `queueBlockedBy` 保持同一语义。
- `hold.params.durationMs` 可选，1000–3_600_000；从 hold **成为 active** 的时刻起算，到期由 body 置为 `succeeded` 并带 `observed.expired:true`，队列恢复。不带 duration 的 hold 是永久 barrier，只能 cancel。
- `move` driver 按 ≤30s 分段推进，总预算 120s；失败时使用 provider 的 `bestReachable` 前缀继续，不把前缀当完成。
- `dig`/`check`/`craft` 在交互前先接近目标方块附近的可站立格；近处没有可站立格时返回 `APPROACH_NO_STAND`。
- `place` 的 stance 先按真实身体 AABB 过滤：目标格落在自身脚/头格时不再移动过去。`PLACE_BLOCKED_BY_SELF` 失败体带 `blockedBy:"self"` 与 `adjacent`（core `standCells` 给出的相邻可用站位），不靠反复 order 试错。
- provider `place` 也按人类逻辑选支撑：先试请求的 `face`，其参照格不是实心/流体时继续扫描 up/down/north/south/east/west；任意一面有实心参照即可放置，成功体带实际使用的 `face`。只有六面都没有实心参照才报 `PLACE_UNSUPPORTED`，并在 provider details 与 driver failure 中带 `supports` 六面事实。
- `craft` 先刷新背包模型，再按“无桌配方优先、找不到才用附近桌子”的顺序解析配方；`observed` 带 `before/after/attempted/crafted/produced` 与 `usedTable/requiresTable/recipeCount`。配方结果不足时返回 `CRAFT_INCOMPLETE`（不再报 `CRAFT_NO_INGREDIENTS`），由上层按 `crafted/attempted` 决定继续或停止；`CRAFT_INCOMPLETE` 不自动重试。
- `attack` 锁定 `entityId`：有界追击最多 8 次（每次 ≤5s），最多 24 次攻击/40s；目标丢失、受保护或名字变化立即失败，绝不换目标。攻击间隔按 `attackSpeed` 计算；`entityHurt` 记 `damageObserved`，只有 `entityDead` 才报 `killed`。目标从查询范围消失只报 `ATTACK_TARGET_LOST`，不得报 `killed`。
- `material.gather` 使用有界区域索引：半径 32，16×16 列分块，每次求值最多取 2 块；命中缓存在内存，`blockUpdated` 直接增删条目，不触发全量重扫。中心移动 >8 格、垂直变化 >4 或缓存超过 15s 时重建并标记 stale。
- `mind.status.metrics` 是进程内 run metrics：已接受的 order 数、order 终态分布、job 计数/重试/抢占、hold 次数与原因、失败码计数、完成率、最近失败诊断。它只从事件派生，不读世界、不产生额外写入。
- **Duty（D1/D2）**：`p2_duty {action:"start", duty:{kind:"gather",item,quota,radius?,maxJobs?,maxWallMs?}}` 启动常驻任务；`mind.status.duty` 显示状态。duty 只在没有 active order、没有 active plan 时运行；显式 order/plan 会暂停它，结束后恢复。配额达到 → completed；无来源/超时/job 预算 → blocked；`p2_duty stop` → stopped。只支持单物品 gather 配额，不自行选新目标。
  - D2 将 duty 状态写入 journal 同目录的 `duty.json`（sidecar，含 worldId/characterId）。start、每次 job start、terminal 时落盘。
  - body 重启时只恢复 `state=active`、identity 匹配、deadline 未过的 duty；`collected` 从当前背包重算，`jobs` 从文件恢复。completed/blocked/stopped 不复活。
  - 过期 duty 恢复为 `blocked`，`lastError=DUTY_DEADLINE`，不自动继续；恢复后由主树继续工作，显式 order/plan 仍优先。
- `ActResult.state = 'unknown'` 表示“请求已发出但效果未确认”，调用方不得当成功，也不得立刻重放。
- 超时（`ACT_TIMEOUT` / `ACT_UNCONFIRMED`）和停止（`STOP_UNCONFIRMED`）必须携带 port 证据：`layer`、`actId`、`epoch`、`elapsedMs`、`effect`、`retrySafe`、`lastPoll`、`controlState`、`controlRelease`、`providerCode`。非 move 动作的超时与 move 同规：释放以 `controlState === idle` 或 provider 取消回执为准，未确认即 `STOP_UNCONFIRMED`，不得硬编码成已释放；driver 返回失败时必须保留 `ActResult.observed`，让 `job.terminal.observed` 能定位到 port/provider。语义拆分：
  - `ACT_TIMEOUT`：预算内无终态且释放已确认，动作可安全重试（当前为 `moveTo` / `lookAt` / `equip`）；重试仍受 driver 的有界重试约束。
  - `ACT_UNCONFIRMED`：动作可能已到达服务端，效果未知；不得重放，driver 必须先读回/观察，再由上层决定；不自动重试。
  - `ACTION_DENIED`：仅当同一 act 窗口内的服务端聊天/系统消息明确拒绝（权限、保护、adventure）时使用；`observed.serverMessages` 保留原文，`observed.denial` 指向命中项；没有命中就不猜。
  - `STOP_UNCONFIRMED`：停止/释放无法确认，保持 tracker fault。
  - `CLIENT_TIMEOUT`：旧码，仅用于历史会话/metrics 映射，当前端口不再发出。
- 能力缺失时返回 `{state:'failed', code:'CAPABILITY_MISSING'}`，不做静默降级。

### 2.1 移动与站位

- `collision` 是方块局部坐标中的 AABB 列表（`[minX,minY,minZ,maxX,maxY,maxZ]`）；空数组表示无碰撞，省略表示未知，不能用非空气代替碰撞形状。
- `serverTags` 是适配器层的服务端 block tags（`ReadonlySet<string>`），不序列化到 bridge；`undefined` 表示 tags 尚未就绪，不是“没有 tag”。
- `moveTo` 目标为脚下路径格坐标，按格取整；`range` 默认 1、范围 0–8，使用三维格距离。容差内只接受已加载、有安全支撑及身体净空的格；半砖按真实支撑高度完成读回。
- `moveTo` 可带显式移动授权 `allowParkour / allowDiagonal / allowPlace / material`；没有授权时不得搭桥/垫脚。所有普通移动和授权 `unstickDig` 都走 motion；不再有 `motion` 开关或 legacy `goto`。
- `unstickDig` 是显式 break 白名单：只允许列出的坐标/方块名，核心先挖掘并读回，再执行移动；没有列出的块不可挖。
- 成功需要角色实际落地到有效终点，并重新检查站位。路径计算成功、`isMoving=false`、走到 partial 前缀都不是成功。成功体带 `arrival{kind,policy,from,to,cell,feetY,at,movedDistance,elapsedMs}`；干地水平容差 0.45，水 1.0。
- `BODY_OVERLAP`：真实 0.6×1.8 AABB 与已加载方块碰撞相交（半嵌、1 格高小窝）。规划前与到达后 fail-fast，`observed.blockedBy` 给出 `{x,y,z,name}`，不重试；自动清格不在 motion 内实现，Agent 用 `go {unstickDig}` 显式授权。
- `GOAL_NOT_STANDABLE`：`exact` 到达的目标格经 `Rules.standInfo` 证明不可站；带 `reason/blockedBy` 直接失败，不把“下一层”当目标。执行器在身体离开 `validPositions` 时按整条剩余路径前后重同步，不再只扫描 ±4 条边。
- **唯一例外**：`traverse scaffold` 的 `moveTo` 可带 `allowUnsupportedGoal:true`；只有同时 `allowPlace:true` 时 motion 才跳过 exact 目标的初始可站预检，让 `Pillar` 先垫脚。普通 `go exact` 不传该参数，仍严格拒绝不可站目标。
- `GOTO_INVALID_TARGET`：容差内没有安全站位；`GOTO_TARGET_UNLOADED`：站位观测不完整；`GOTO_NO_PATH`：当前已加载世界、动作策略和搜索范围内无路；均不能推断整个世界永远不可达。
- `GOTO_STUCK`：位移看门狗及有限恢复失败。`GOTO_SEARCH_TIMEOUT` / `GOTO_SEARCH_LIMIT` / `GOTO_TIMEOUT` 返回 `unknown`，不能当作无路。
- `observed` 保留起点、目标、当前位置、路径状态、阻挡观测、候选站位、最佳前缀终点、耗时、节点数、重规划及恢复次数。`nearbyCandidates` 仅是安全站位建议，未证明可达，不能据此擅自更换目标。
- 移动事件：`move.started / move.progress / move.no_path / move.stuck / move.finished`；经 `p2_events` 可读，进度最多每秒一次；旧令牌进度不再发布。门与局部挖掘另有 `move.door / move.unstick-dig`。
- 停止必须清理路径、goal、按键、定时器与事件监听；`STOP_UNCONFIRMED` 不得被普通取消/旧令牌错误覆盖。终态同样需要释放确认，tracker 未确认则冻结新调度。强制收尾统一执行 `stopDigging` / `deactivateItem` / `closeWindow` / `clearControlStates` / 清 dig 目标 / 背包重同步；一次停止在 `releaseFaultIntervalMs` 内仍无法确认记一次 fault，连续 `releaseFaultLimit` 次由 provider 主动断开连接，交给 body 既有的 fault/rebuild 路径重建 epoch。
- **安全下落预算**：普通路径禁止脚部 >2 格落差；第一遍无路且目标更低时，motion 第二遍按 `health - 6 + 3` 允许安全下落。落点必须已加载、可站立、支撑非水/岩浆/危险，下落列无阻挡；否则不生成边。
- **显式危险允许**：`policy.hazards.allow` 只能是 `void / lethal_fall / lava`，默认空。这部分**不在 motion 核心**：`go` 把显式 lava/void 目标，以及目标低于当前 >2 格且允许 `lethal_fall` 的请求交给 Agent 层 `fatal` driver；driver 做受控 step-off，只有真实 `died` 才成功；`unloaded` 永不允许。
- 终态 `observed` 包含 `safeFallPass / safeFall / healthBefore / healthAfter`；致命边由 `fatal` driver 的 `died` 证据判断。
- **`traverse` order**：Agent 显式下发的临时通行辅助，不是 `build` 最终几何：
  - `mode:"bridge"`：同高、正方向、1 格宽直线；driver 校验几何/材料后委托 `moveTo { motion, allowPlace, material }`，由 motion `Bridge` 执行；
  - `mode:"scaffold"`：垂直垫脚柱——必须同 x/z 列，向上 `dy` 级，最多 8 级；driver 校验列/材料后委托 motion `Pillar`；provider `pillarUp`/`pillar` 已删除;
  - 需要 `item`、材料计数、`maxBlocks`；占用/无支撑/材料不足/对角 bridge/水平或向下 scaffold 均失败；
  - 只由 Agent 下单，P2 不自主搭桥/垫脚；不自动清理，`observed.temporary=true`，清理是后续 Agent order。

## 3. Job

```ts
type Job = {
  driverId: string
  target?: Target
  params: Record<string, unknown>       // 已通过 driver.schema
  orderId?: string
  workItemId?: string
  runId: string
  issuedAt: number
  budget: { maxTicks: number; maxWallMs: number }
}
```

- `runId` 在每次尝试时新生成；旧 `runId` 的结果只对账。
- 失败计数键 = `(orderId|workItemId|driverId)`。
- 失败终态的 `observed.failure` 是统一投影，字段为 `{layer, phase, code, facts, diagnosis, cause, recovery}`：
  - `facts` 只来自同一份观测快照，白名单复制（pos/cell/target/blockedBy/requiredDig/skipped/partial/support/lastAction 等），不重新查世界；
  - `facts.snapshot` 是失败时的有界同快照：`self/target` 各含 feet/head/support，`targetNeighbors` 四邻，`bodyOverlap` 最多 4 格，另带 `pathStatus`/`bestReachable`；每格为 `{cell:[x,y,z], name, loaded}`，最多 16 个去重格，不含 path/candidates/visited；
  - `PLACE_UNSUPPORTED` 的 `facts` 额外带 `supports` 六面布尔（up/down/north/south/east/west）与最多 3 个 `suggestedCells`（`{cell,support}`，指附近已有实心参照面、可实际放置的候选目标格，不是站位）；
  - `diagnosis` 是闭合枚举，一条失败最多一个：`HEAD_BLOCKED`、`SUPPORT_MISSING`、`TARGET_UNLOADED`、`START_EMBEDDED`、`NO_STAND_CELL`、`EFFECT_UNCONFIRMED`、`RELEASE_UNCONFIRMED`、`TOOL_MISSING`、`DENIED`、`UNKNOWN`；事实不足就是 `UNKNOWN`，不生成动作；
  - `recovery` 是契约级字符串：`retry` / `replan` / `reobserve` / `wait` / `restart` / `none`，不是具体动作；
  - `cause` 是 `{kind: "provider"|"world"|"authority"|"budget"|"unknown", code}`，不是自然语言；
  - 失败体不再包含 `suggestions` / `action` / `params`；具体下一步选项由静态 skill 表或 Agent 决策，P2 不预测后续世界。
- 没有专门失败体的 driver 由 body 在 `job.terminal` 处补一个通用投影，保证每个失败终态都能回答“在哪、为什么、下一步”。

## 4. WorkGiver

```ts
interface WorkGiver {
  id: string
  requires?: Capability[]
  score?(ctx: EvalCtx, world: WorldView): number
  find(ctx: EvalCtx, world: WorldView): Candidate | Handoff | Hold | null
}
type Candidate = { driverId: string; target: Target; params: object; keys: string; orderId?: string; workItemId?: string }
type Handoff = { driverId: string; target: Target; params: object; reason: string; orderId?: string }
type Hold = { kind: 'hold'; reason: string; notify?: boolean }
```

- `null`：让出选择（正常，继续看后续分支）。
- `Hold`：保留意图，不产生 job，停止下降；`notify: false` 用于 `hold` order 这类已知的等待。
- `Handoff`：先做前置工作（清障/补支撑/站位），完成后重新 `find`。
- `keys`：续做键；与 `DriverHandle.continuationKey()` 相同即“延续”，不重启。

## 5. Driver

```ts
interface Driver {
  id: string
  schema: JSONSchema
  requires?: Capability[]
  defaults: { budget: Budget; interrupt: 'constant-only' | 'never' | 'any'; suspendable: boolean }
  validate(job: Job, world: WorldView): { ok: true } | { ok: false; code: string }
  start(job: Job, ctx: DriverCtx): DriverHandle
}

interface DriverHandle {
  tick(): void
  requestStop(): void
  stopStatus(): 'stopping' | 'stopped' | 'unconfirmed'
  result(): { state: 'running' | 'succeeded' | 'failed' | 'interrupted'; code?: string; observed?: unknown }
  continuationKey(): string
}
```

- `tick()` 必须有界；异步动作以句柄表示，**未结束不得重复启动**。
- `requestStop()` 后进入 `stopping`；`unconfirmed` 超过阈值 → tracker 记 `fault`。
- 读回是稳定性观察，不是服务端接受的证明；强证据走独立观测。

## 6. JobTracker

```
idle ─offer─► starting ─► running ─terminal─► idle
running ─preempt─► stopping ─stopped─► idle
stopping ─超时/不可确认─► fault ─► 冻结新 dispatch + 上报
```

接口：

```ts
interface JobTracker {
  offer(candidate: Candidate | null): void
  tick(): void
  current(): { job: Job; driverId: string } | null
  state(): 'idle' | 'starting' | 'running' | 'stopping' | 'fault'
  fault(): { code: string; since: number } | null
}
```

规则：

1. 续做：`candidate.keys === current.continuationKey()` → 只续期。
2. 切换：`seq++`（旧令牌失效）→ `requestStop()` → 等 `stopped` → 起新 job。
3. 迟到：`runId` 不匹配的结果只记 `stale-result`。
4. 失败：按 `(orderId|workItemId|driverId)` 计数；超限上报 `blocked`。原始 order 的 retry/one-shot 见 RUNTIME §5；中间 retry 的 `job.terminal` 带 `retry: true`，不产生 completion wake。

## 7. 树与谓词注册表

树定义在代码中（`src/mind/trees.ts`），节点形状如下；加载/启动期仍校验注册项、深度和环：

```ts
{ type: 'priority', children: [] }
{ type: 'sorter',   children: [] }
{ type: 'when', predicate: 'isNight', onUnknown: 'skip', then: {}, else: {} }
{ type: 'subtree', ref: 'NightGuard' }
{ type: 'sequence', children: [] }
{ type: 'giver',    ref: 'plan.work' }
```

- 谓词注册项：`{ id, schema, fn(ctx, world): true | false | 'unknown' }`。
- giver 注册项：`{ id, factory }`；树只能引用已注册 id，未知 id 在加载期报 `DefinitionError`。
- 求值结果：`Job | NoWork | Hold | NeedObservation | DefinitionError`。
- 一次求值使用**同一份** `WorldView`；谓词不得自行查询。

## 8. Plan / WorkItem

```ts
type PlanInstance = {
  planId: string
  orderId: string
  template: string
  templateVersion: number
  origin: Vec3                       // 内空最小角（地板层）
  size: [number, number, number]     // 内空尺寸
  materialPolicy: Record<string, { auto: boolean; maxBudgetTicks?: number }>
  workItems: WorkItem[]
  verify: VerifySpec
}

type VerifySpec =
  | { kind: 'sealed-room'; min: Triple; max: Triple }
  | {
      kind: 'usable-room'
      min: Triple; max: Triple
      door?: Triple   // 门下半格，相对 origin
      bed?: Triple    // 床格，相对 origin
    }

type WorkItem = {
  id: string
  kind: 'clear' | 'prepare' | 'place' | 'enter' | 'hold'
  at: [number, number, number]                        // 相对 origin
  expected?: { name: string; state?: Record<string, string> }
  after?: string[]
}

type WorkState =
  | { kind: 'satisfied' }
  | { kind: 'executable'; driverId: string }
  | { kind: 'blocked'; reason: 'NO_SUPPORT' | 'NO_STAND' | 'NO_MATERIAL' | 'UNREACHABLE' | 'CONFLICT' }
  | { kind: 'unknown' }
```

- 匹配用 `name + state 子集`，不用 `block.name === item`。
- WorkGiver 遍历**全部**工作项，返回任一 `executable`。

## 9. 意图日志（恢复用）

```jsonc
{"at": 1793..., "kind": "order.accepted", "order": {...}}
{"at": 1793..., "kind": "plan.instantiated", "planId": "...", "templateVersion": 1, "origin": {...}}
{"at": 1793..., "kind": "workItem.terminal", "planId": "...", "workItemId": "w7", "state": "satisfied"}
{"at": 1793..., "kind": "action.pending", "runId": "...", "driverId": "place", "target": {...}}
{"at": 1793..., "kind": "order.terminal", "orderId": "...", "state": "succeeded", "evidence": {...}}
```

恢复：尾部半行丢弃；`action.pending` 只对账不重放；已取消 order 不复活；重启时 **queued order 与 active hold** 置 `abandoned`（`observed.reason:"RESTART"`），不自动继续；active 非 hold order 仍按 pending/plan 恢复；版本不匹配拒绝恢复。

## 10. 错误码

| 码 | 含义 |
|---|---|
| `CAPABILITY_MISSING` | 端口不具备所需能力 |
| `STALE_WRITE` | 写令牌不匹配（旧实例） |
| `ACT_TIMEOUT` | 动作在预算内无终态，释放已确认，且动作可安全重试（move/look/equip） |
| `ACT_UNCONFIRMED` | 动作可能已生效但无终态；不重放，先读回/观察 |
| `ACTION_DENIED` | 同一 act 窗口内有服务端消息明确拒绝（权限/保护/adventure）；带 `serverMessages`/`denial` 证据 |
| `CLIENT_TIMEOUT` | 旧码，当前端口不再发出；仅历史数据映射 |
| `NO_MATERIAL` / `NO_SUPPORT` / `NO_STAND` / `UNREACHABLE` / `CONFLICT` | 工作项不可执行 |
| `DRIVER_FAULT` | driver 内部错误 |
| `STOP_UNCONFIRMED` | 停止无法确认 → tracker fault |
| `DEFINITION_ERROR` | 树/模板/注册表定义错误 |
| `INSUFFICIENT_EVIDENCE` | 验证证据不足（不等于失败） |
| `TOOL_INSUFFICIENT` | `harvest` 没有可用工具 |
| `BLOCK_UNBREAKABLE` | 方块不可破坏 |
| `DIG_NO_BLOCK` | 目标是空气/没有方块 |
| `PICKUP_UNREACHABLE` | 掉落物存在但无法走到 |
| `CRAFT_INCOMPLETE` | 合成已开始但未达到请求数量；`observed.crafted/attempted` 如实记录 |
| `DIG_PARTIAL` | 体积挖掘部分完成；`observed.dug/skipped/partial` 如实记录，不自动重试 |
| `DIG_VOLUME_TOO_LARGE` | 体积超过 `maxBlocks`，未开始挖掘 |
| `GOAL_NOT_STANDABLE` | `exact` 目标格不可站；带 `reason/blockedBy` |
| `PICKUP_NOT_COLLECTED` | 已到达掉落物附近，背包仍未增加 |

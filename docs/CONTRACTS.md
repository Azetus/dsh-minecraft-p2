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
  dig(p: Vec3): ActResult
  place(p: Vec3, face: Face, item: string): ActResult
  craft(item: string, count?: number): ActResult
  useItem(): ActResult
  useOn(p: Vec3): ActResult
  attack(entityId: string): ActResult
  sleep(bed: Vec3): ActResult
  say(text: string): void                      // 独立限流通道，不受写令牌约束

  // 事件
  on(event: 'blockUpdated' | 'inventoryChanged' | 'screenOpened' | 'damaged' | 'died' | 'chat', cb: (payload: unknown) => void): void

  capabilities(): Capability[]                // 'navigate' | 'interact' | 'observe.screen' | 'combat'
}

type WriteToken = { runId: string; jobId: string; seq: number }
type ActResult = { state: 'ok' | 'failed' | 'unknown'; code?: string; observed?: unknown; elapsedMs: number }
```

**语义**

- `blockAt` 返回 `null` 表示未加载，**不等于空气**。
- `BlockInfo.harvestTools` 是适配器给出的“可掉落工具”名称列表；`[]` 表示手即可。缺省表示适配器不知道，不能当作“需要任何工具”。
- `dig` order 接受 `params.purpose: "clear" | "harvest"`（默认 `harvest`）：
  - `harvest` 要求背包中有 `harvestTools` 内的工具，否则快速失败 `TOOL_INSUFFICIENT`；
  - `clear` 没有合适工具时可以徒手尝试，但不可破坏方块返回 `BLOCK_UNBREAKABLE`；
  - driver 在挖掘前装备所选工具，挖掘后两次读回空气；`harvest` 会走到掉落物处拾取并读回背包增量；掉落已存在但不可达 → `PICKUP_UNREACHABLE`，走到后仍未拾取 → `PICKUP_NOT_COLLECTED`。
- `go` 目标只接受已选择的坐标；若已知目标不可站立，giver 会在 2 格内找最近可站立格，找不到则 hold `GO_NO_STAND`。目标未加载时交给 move driver，向前 16 格推进到已加载前缀后再重规划。
- `move` driver 按 ≤30s 分段推进，总预算 120s；失败时使用 provider 的 `bestReachable` 前缀继续，不把前缀当完成。
- `dig`/`check`/`craft` 在交互前先接近目标方块附近的可站立格；近处没有可站立格时返回 `APPROACH_NO_STAND`。
- `attack` 锁定 `entityId`：有界追击最多 8 次（每次 ≤5s），最多 24 次攻击/40s；目标丢失、受保护或名字变化立即失败，绝不换目标。目标消失视为完成，并回读 `attacks/killed`。
- `ActResult.state = 'unknown'` 表示“请求已发出但效果未确认”，调用方不得当成功，也不得立刻重放。
- 能力缺失时返回 `{state:'failed', code:'CAPABILITY_MISSING'}`，不做静默降级。

### 2.1 移动与站位

- `collision` 是方块局部坐标中的 AABB 列表（`[minX,minY,minZ,maxX,maxY,maxZ]`）；空数组表示无碰撞，省略表示未知，不能用非空气代替碰撞形状。
- `moveTo` 目标为脚下路径格坐标，按格取整；`range` 默认 1、范围 0–8，使用三维格距离。容差内只接受已加载、有安全支撑及身体净空的格；半砖按真实支撑高度完成读回。
- 成功需要角色实际落地到有效终点，并重新检查站位。路径计算成功、`isMoving=false`、走到 partial 前缀都不是成功。
- `GOTO_INVALID_TARGET`：容差内没有安全站位；`GOTO_TARGET_UNLOADED`：站位观测不完整；`GOTO_NO_PATH`：当前已加载世界、动作策略和搜索范围内无路；均不能推断整个世界永远不可达。
- `GOTO_STUCK`：位移看门狗及有限恢复失败。`GOTO_SEARCH_TIMEOUT` / `GOTO_SEARCH_LIMIT` / `GOTO_TIMEOUT` 返回 `unknown`，不能当作无路。
- `observed` 保留起点、目标、当前位置、路径状态、阻挡观测、候选站位、最佳前缀终点、耗时、节点数、重规划及恢复次数。`nearbyCandidates` 仅是安全站位建议，未证明可达，不能据此擅自更换目标。
- 移动事件：`move.started / move.progress / move.no_path / move.stuck / move.finished`；经 `p2_events` 可读，进度最多每秒一次；旧令牌进度不再发布。门与局部挖掘另有 `move.door / move.unstick-dig`。
- 停止必须清理路径、goal、按键、定时器与事件监听；`STOP_UNCONFIRMED` 不得被普通取消/旧令牌错误覆盖。终态同样需要释放确认，tracker 未确认则冻结新调度。
- **安全下落预算**：普通路径禁止脚部 >2 格落差；第一遍无路且目标更低时，第二遍按 `health - 6 + 3` 允许安全下落（3 格摔落伤害约 0–1，保留至少 3 颗心）。落点必须已加载、可站立、支撑非水/岩浆/危险，下落列无阻挡；否则不生成边。
- **显式危险允许**：`policy.hazards.allow` 只能是 `void / lethal_fall / lava`，默认空。`lethal_fall` 在安全预算之外再开一遍搜索；`void/lava` 只接受 6 格内的致命目标，执行受控 step-off，死亡后 order 以 `DIED_IN_ALLOWED_HAZARD` 终止，不伪装成功、不重试。`unloaded` 永不允许。
- 终态 `observed` 包含 `hazards / hazardPass / safeFallPass / safeFall / healthBefore / healthAfter`；致命边以真实 `died` 事件为准。
- **`traverse` order**：Agent 显式下发的临时通行辅助，不是 `build` 最终几何：
  - `mode:"bridge"`：同高、正方向、1 格宽直线，逐块 `place → readback → move`；
  - `mode:"scaffold"`：垂直垫脚柱——必须同 x/z 列，向上 `dy` 级；每级跳起、在脚底放 1 个 `item` 方块、落上去，最多 8 级；由 provider 的 `pillarUp` 执行，driver 不做 1:1 楼梯；
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

## 4. WorkGiver

```ts
interface WorkGiver {
  id: string
  requires?: Capability[]
  score?(ctx: EvalCtx, world: WorldView): number
  find(ctx: EvalCtx, world: WorldView): Candidate | Handoff | Hold | null
}
type Candidate = { driverId: string; target: Target; params: object; keys: string; orderId?: string }
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

恢复：尾部半行丢弃；`action.pending` 只对账不重放；已取消 order 不复活；版本不匹配拒绝恢复。

## 10. 错误码

| 码 | 含义 |
|---|---|
| `CAPABILITY_MISSING` | 端口不具备所需能力 |
| `STALE_WRITE` | 写令牌不匹配（旧实例） |
| `CLIENT_TIMEOUT` | 动作超时，效果未确认 |
| `NO_MATERIAL` / `NO_SUPPORT` / `NO_STAND` / `UNREACHABLE` / `CONFLICT` | 工作项不可执行 |
| `DRIVER_FAULT` | driver 内部错误 |
| `STOP_UNCONFIRMED` | 停止无法确认 → tracker fault |
| `DEFINITION_ERROR` | 树/模板/注册表定义错误 |
| `INSUFFICIENT_EVIDENCE` | 验证证据不足（不等于失败） |
| `TOOL_INSUFFICIENT` | `harvest` 没有可用工具 |
| `BLOCK_UNBREAKABLE` | 方块不可破坏 |
| `DIG_NO_BLOCK` | 目标是空气/没有方块 |
| `PICKUP_UNREACHABLE` | 掉落物存在但无法走到 |
| `PICKUP_NOT_COLLECTED` | 已到达掉落物附近，背包仍未增加 |

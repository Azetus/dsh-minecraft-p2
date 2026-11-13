# 契约（P2Mind）

> **当前实现**：Combat 只有一个实现——50ms tick 的 `CombatSession`，由 `CombatSessionHandle` 的 `DriverHandle.tick()` 驱动。移动用 `combatInput` 持久控制、盾用 `offhandHold` 持久 stance；attack 不停止移动、不放下盾。

> 设计背景见 [P2Mind](runtime/P2MIND.md)。本文只列可实现的接口与不变量。

## 1. 边界

| 边界 | 传输 | 形状 |
|---|---|---|
| bridge ↔ body | JSON-lines stdio | `RequestEnvelope / ResponseEnvelope`（`src/contracts/protocol.ts`） |
| body ↔ 游戏 | `BodyApi` / `MineflayerBody` | 纯数据；不传库对象 |
| content ↔ 运行时 | 注册表 + JSON | `content/plans/*.json`；树定义在 `src/mind/trees.ts` |

**不变量**

1. **单写者**：任一时刻只有一个 Driver 持有写令牌；令牌不匹配的写操作在 `MineflayerBody` 层被拒绝并记 `stale-write`。每次 Driver 执行拿到的是**绑定该 run 的 BodyApi 视图**：撤权后视图上的写方法一律返回 `STALE_WRITE` 且不触达 provider，读方法不受影响；已进入 provider 的异步链在每个副作用之前复查同一权限。旧执行实例无法借用新实例的权限。
2. **结果三态**：`confirmed / refuted / insufficient`；`insufficient` 不得算成功。
3. **进度可重建**：能从世界重建的优先重建；不能重建的写意图日志。
4. **树不产坐标**：树只选 giver；目标由 giver 选；driver 不得自行推导目标。

### 1.1 结果语义分层

| 层 | 成功含义 | 失败含义 |
|---|---|---|
| `BodyApi` / provider | `ActResult.state='ok'`：动作效果被观测到，只是证据 | `failed`/`unknown`：动作未成功或效果未知 |
| Driver | `DriverResult.state='succeeded'`：该 verb 的可验证后置条件已成立 | `failed`：无法确认结果；**动作可能已生效或只完成一部分** |
| JobTracker / metrics | 只把 driver 的 `succeeded` 计为完成 | `failed` 计入失败；按失败键重试/blocked |

- driver **不得**因为 provider 返回 `ok` 就直接 `succeeded`；必须完成该 verb 的读回/确认。
- `failed` 不等于“什么都没发生”。动作已生效、部分完成、效果未知都要用同一份 `observed` 证据（`partial`、`dug`、`crafted`、`effect` 等）表达。
- Verifier 的 `confirmed / refuted / insufficient` 是独立的只读验证轴，不与 driver 的 `succeeded / failed` 混用。

## 2. BodyApi

`src/body/api.ts` 的纯类型接口；唯一实现是 `src/provider` 的 `MineflayerBody`。消费者只 `import type`，不 import mineflayer。

```ts
type Vec3 = { x: number; y: number; z: number }
type BlockInfo = {
  name: string
  state?: Record<string, string>
  loaded: boolean
  collision?: number[][]
  serverTags?: ReadonlySet<string>
  material?: string
  diggable?: boolean
  hardness?: number
  light?: number
  skyLight?: number
  harvestTools?: string[]
}
type Item = { slot: number; name: string; count: number }
type WriteToken = { runId: string; jobId: string; seq: number }
type ActResult = { state: 'ok' | 'failed' | 'unknown'; code?: string; observed?: unknown; elapsedMs: number }

type BodyApi = {
  // 查询
  self(): SelfInfo
  identity(): { worldId: string; characterId: string }
  blockAt(p: Vec3): BlockInfo | null           // null = 未加载
  biomeAt(p: Vec3): BiomeInfo | null
  blocksIn(box: { min: Vec3; max: Vec3 }, filter?: string[]): BlockInfo[]
  findBlocks(query: { near: Vec3; radius: number; names: string[]; count: number }): BlockInfo[]
  inventory(): Item[]
  offhand?(): Item | undefined
  entities(box: { min: Vec3; max: Vec3 }): EntityInfo[]
  entityByName?(name: string): EntityInfo | undefined
  entityById?(id: string): EntityInfo | undefined
  playerOnline?(name: string): boolean
  time(): { timeOfDay: number; worldAge: number }
  suspension?(): SuspensionState

  // 动作（写）：必须持令牌
  beginWrite(token: WriteToken): void
  endWrite(token: WriteToken): void
  moveTo(target: Vec3 | Landmark, opts?: MoveOptions): Promise<ActResult>
  /**
   * Persistent combat movement controls (forward/back/left/right) and facing.
   * The body keeps them until the next input or endWrite.
   */
  combatInput?(opts: {
    face: Vec3
    forward?: boolean
    back?: boolean
    left?: boolean
    right?: boolean
  }): Promise<ActResult>
  lookAt(p: Vec3): Promise<ActResult>
  lookYaw?(yaw: number): Promise<ActResult>
  dig(p: Vec3): Promise<ActResult>
  place(p: Vec3, face: Face, item: string): Promise<ActResult>
  useItem(opts?: { durationMs?: number; offhand?: boolean }): Promise<ActResult>
  /**
   * Persistent off-hand stance: true holds the item across acts, false
   * releases it. Released on false, endWrite, a write-epoch change or reset.
   */
  offhandHold?(active: boolean): Promise<ActResult>
  equip(item: string, destination?: 'hand' | 'offhand'): Promise<ActResult>
  unequip?(destination?: 'hand' | 'offhand'): Promise<ActResult>
  craft(item: string, count?: number): Promise<ActResult>
  useOn(p: Vec3): Promise<ActResult>
  attack(entityId: string): Promise<ActResult>
  sleep(bed: Vec3): Promise<ActResult>
  containerAt(p: Vec3): Promise<ContainerCheckResult>
  containerTransfer(p: Vec3, action: ContainerTransferAction, item?: string, count?: number): Promise<ActResult>
  fatalStep(target: Vec3): Promise<ActResult>
  say(text: string): void

  // 事件
  on(event: BodyEvent, cb: (payload: unknown) => void): void
  off?(event: BodyEvent, cb: (payload: unknown) => void): void

  canSee?(entityId: string): boolean
  attackSpeed?(): number
  attackReach?(): number
}
```

- 只有 `suspension`/`offhand`/`entityByName`/`entityById`/`playerOnline`/`canSee`/`attackSpeed`/`attackReach`/`offhandHold`/`combatInput`/`lookYaw`/`unequip`/`off` 是可选方法，调用方必须能回退；这是为了兼容不完整 fake，不是多 provider 协商。
- 写门在 `src/provider/control.ts`（`WriteGate`），令牌由 `JobTracker` 发放；没有 capability/action 表。`JobTracker` 用 `src/mind/scope.ts` + `src/mind/scoped-body.ts` 给每个 run 发一个绑定的视图：`beginStop` 先撤销视图再 `endWrite`，所以撤权与下一实例接管之间没有可插入写的窗口。`containerAt` 开窗属于写，同样受权限约束。视图拒绝写时记 `job.write-after-stop`（每个 run 至多一次）。
- `src/provider` 是唯一允许 import mineflayer 的目录；body bundle 动态 import `lib/provider/minecraft.mjs`。

**语义**

- `blockAt` 返回 `null` 表示未加载，**不等于空气**。
- `findBlocks` 只返回已加载方块，未加载区块跳过且不折成空气；按 `near` 到 cell 的欧氏距离返回最近 `count` 个匹配，未知方块名返回空数组。它是只读查询，不取写令牌、不产生 job，也不判断可达性。适配器内部用 block id 数组查询，不使用函数匹配器或整盒逐格扫描；可交互距离由上层判断（方块 4.5 格、实体 3.0 格），find 命中不等于够得到。
- `BlockInfo.harvestTools` 是适配器给出的“可掉落工具”名称列表；`[]` 表示手即可。缺省表示适配器不知道，不能当作“需要任何工具”。
- `dig` order 接受 `params.purpose: "clear" | "harvest"`（默认 `harvest`）：
  - 单格：`{x,y,z}` 使用目标格语义；`harvest` 要求背包中有 `harvestTools` 内的工具，否则快速失败 `TOOL_INSUFFICIENT`；`clear` 没有合适工具时可以徒手尝试，但不可破坏方块返回 `BLOCK_UNBREAKABLE`；
  - 体积：`{shape:"box"|"line", from:{x,y,z}, to:{x,y,z}, height? 1–8, only?:string[], preserveFloor? 默认 true, maxBlocks? 1–64 默认 24}`。`line` 要求恰好一个轴不同；`maxBlocks` 是实际挖掘预算，先按 `only`/空气/脚下保护过滤再检查，超过才 `DIG_VOLUME_TOO_LARGE`，不静默截断；原始体积另有 4096 扫描硬上限；
  - 隧道：`{shape:"tunnel", to:{x,y,z}, height? 1–3 默认 2, preserveFloor? 默认 true, maxBlocks? 默认 24/上限 64}`。起点是当前脚格，`to` 只允许一个水平轴向、至多一次 y±1 台阶，不做竖井；逐格清脚/头、前进、两次读回，返回 `path`（含起点）与 `returnable`。每挖一格前检查目标格和行进方向后一格，遇水/岩浆、未加载或不可破坏立即停止，返回 `failed DIG_PARTIAL` + `stoppedAt` + `reason`（`fluid`/`unloaded`/`unbreakable`/`tool`/`dig`/`readback`/`move`/`equip`），不挖穿、不猜；
  - 逐格 `approachBlock` → 装备 → 挖 → 两次读回；`dig` 的 promise resolve 不是成功证据，目标格读回才是。不可达/未加载/被 `only` 过滤/会挖到自己脚下或身体的格进 `observed.skipped`，不整体失败；部分完成返回 `failed` + `DIG_PARTIAL` + `observed.partial{dug,skipped,stoppedAt}`，不自动重试；
  - 自动选最佳工具（`chooseTool`）并 `equip`；最近一次显式 `equip` 成功后，下一次 `dig`/`attack`/`clear`（中间可有 `go`/`place`/`use`）不自动切换，动作启动后恢复自动（one-action override）。
- `equip` order 参数：`{item?, destination?: "hand"|"offhand", unequip?: boolean}`；`item` 与 `unequip:true` 二选一，`destination` 缺省 `hand`。**hand** 成功（包括 hand unequip）设置 one-action override；offhand equip/unequip 不压制主手自动换武器。offhand 已空时 unequip 算成功；`UNEQUIP_FAILED`/`UNEQUIP_READBACK_UNKNOWN`/`UNEQUIP_READBACK_MISMATCH` 只影响该 order。
  - `harvest` 在整批结束后统一拾取一次（中心点）；单格 `harvest` 仍在挖后立即拾取；
  - driver 在挖掘前装备所选工具，挖掘后两次读回空气；`harvest` 会走到掉落物处拾取并读回背包增量；掉落已存在但不可达 → `PICKUP_UNREACHABLE`，走到后仍未拾取 → `PICKUP_NOT_COLLECTED`，只能单向进入（可捡但回不来）→ `PICKUP_NO_RETURN`。pickup 只走 `standCells` 的可站/未知候选格，绝不把 item 自身坐标当 `moveTo` 目标；候选格还必须是**双向连通**的：`standCells` 已证明 `起点→候选`，pickup 在进入前再用同一套 move 边证明 `候选→起点`（有界 A*，512 节点）；证明不了就不进入并报 `PICKUP_NO_RETURN`，预算耗尽只算 `unknown`，同样不进入。无候选时 `observed.standQuery.requiredDig` 指向要清的支撑/脚/头格，有候选但全部不可达时给 `unreachableReason:"path-blocked"` 与 `candidateCells`，有候选但全部无法返回时给 `returnReason:"no-return"|"return-unknown"` 与 `candidateCells[].returnable`。
- `collect` order 是**一次有界的已观测掉落物拾取**：`{radius? 1–16 默认 8, item?, maxDrops? 1–16 默认 8, timeoutMs? 1000–90000 默认 30000}`。job 启动时以身体位置为球心读取一次 item 实体，按 AABB 距离近到远处理，最多 `maxDrops`；`item` 精确匹配 adapter 解析的 `entity.item.name`。每个实体只做一 pass（`standCells` 可站候选 → 双向连通检查 → `moveTo` → 背包总计数增量 → 按 entity id 复查询），不挖、不战斗、不预测落点；超出 `maxDrops` 的实体进 `skippedByCap`，不算失败，本次不追。终态：无匹配掉落 → `succeeded` + `drops:0`；全部确认收集 → `succeeded`；`timedOut>0` → `failed COLLECT_TIMEOUT`；`full>0` → `failed COLLECT_INVENTORY_FULL`；`unreachable>0` → `failed COLLECT_UNREACHABLE`；`noReturn>0` → `failed COLLECT_NO_RETURN`；其余 `missed>0` → `failed COLLECT_INCOMPLETE`。`collected` 是物品数（背包增量），`collectedDrops` 是确认收集的实体数；`collectedDrops + missed + unreachable + noReturn = drops`（`missed` 含 `gone/merged/full/partial/timedOut`，`unreachable`、`noReturn` 各单独一桶）。collect 是 primitive 但一次性，失败不进入 order 重试；被抢占后恢复的新 pass 以当时背包为 baseline。
- `go` 目标只接受已选择的坐标；若已知目标不可站立，giver 会在 2 格内找最近可站立格，找不到则 hold `GO_NO_STAND`。目标未加载时交给 move driver，向前 16 格推进到已加载前缀后再重规划。`go.params.range`（0–8）透传到 move job；站位调整只由 giver 的 standability/nearestStandable 完成，不使用 `moveTo.approach` 参数。
- `p2_order` 的 accepted 结果带 `queue` 摘要：`{active, queued, blockedBy?, holdsActiveSlot?, queuedBehind?, release?}`。`hold` 是占住 active 位的 barrier，不是清空队列；`blockedBy`/`release` 直接指出被哪个 hold 堵住、如何释放。`p2_orders` 的 `queueBlockedBy` 保持同一语义。
- `hold.params.durationMs` 可选，1000–3_600_000；从 hold **成为 active** 的时刻起算，到期由 body 置为 `succeeded` 并带 `observed.expired:true`，队列恢复。不带 duration 的 hold 是永久 barrier，只能 cancel。
- `move` driver 按 ≤30s 分段推进，总预算 120s；失败时使用 provider 的 `bestReachable` 前缀继续，不把前缀当完成。
- `dig`/`check`/`craft` 在交互前先接近目标方块附近的可站立格；近处没有可站立格时返回 `APPROACH_NO_STAND`。
- `place` 的 `{x,y,z}` 是**目标方块所占格**，不是支撑/参照格。driver 先预检：目标已是期望方块 → `succeeded` + `observed.alreadyPlaced:true`，不发包不装备；空气/流体/server tag `replaceable` 可放；其他不可替换方块 → `PLACE_TARGET_OCCUPIED`，不移动、不 `ensureHeld`、不发包。没有“自动下移一格”的语义。
- `place` 的 stance 先按真实身体 AABB 过滤：目标格落在自身脚/头格时不移动到该格。`PLACE_BLOCKED_BY_SELF` 失败体带 `blockedBy:"self"` 与 `adjacent`（core `standCells` 给出的相邻可用站位），不靠反复 order 试错。
- `place` 的显式 `stands` 等于当前脚格时不再发 `moveTo`（同一位置不是移动）；这是建造站位复用的前提。显式 `stands` 仍会按顺序尝试，某个 face 不可用时会尝试下一个 stance，而不是把整个 job 判失败。
- `place` 每次只发一个 face 的包：显式 `face` 必须可用；省略时 driver 按 `up → down → north → south → east → west` 选第一个“有碰撞支撑 + 眼到面 ≤4.5 + 视线未挡”的面。provider 只执行请求的 face，不做六面 fallback。
- 一次物品消耗最多一次 placement packet：provider 的失败体带 `retrySafe`（仅“服务端明确 refusal + 物品数不变 + 无新方块”为 true），只有 `retrySafe:true` 时 driver 才换下一个 face；超时/未知/`PLACE_OFF_TARGET`/`PLACE_ITEM_CONSUMED` 直接终态，`EQUIP_NO_ITEM`/`PLACE_NO_ITEM` 立即终态。
- provider 在发包前后快照 3×3×3 邻域与物品数量；成功/失败都带 `placedAt/placedCells/changedCells/itemCountBefore/itemCountAfter/itemConsumed`。target 未变但邻域出现方块 → `PLACE_OFF_TARGET`；物品减少且无落点 → `PLACE_ITEM_CONSUMED`。support 已是期望方块只作 `supportMatchesExpected`/`suggestedTarget` hint，不自动下移。
- provider 在 `bot.placeBlock` 期间按原状态设置 sneak、结束后恢复：工作台/箱子/熔炉等交互方块的普通右键会打开界面而不是放置，必须 sneak 才能把方块放到其相邻格。
- `craft` 先刷新背包模型，再按“无桌配方优先、找不到才用附近桌子”的顺序解析配方；`observed` 带 `before/after/attempted/crafted/produced` 与 `usedTable/requiresTable/recipeCount`。配方结果不足时返回 `CRAFT_INCOMPLETE`，由上层按 `crafted/attempted` 决定继续或停止；`CRAFT_INCOMPLETE` 不自动重试。
- `attack` 锁定 `entityId`，可选 `entityIds` 扩展为允许的目标集合；`threat.fight` 以 `engagement:true` 传入一次 engagement 的集合，`attack` order 保持单目标严格 kill。追击距离由可选 `chaseLeash`（从 order 起点算的水平距离）限制；战斗由 50ms tick `CombatSession` 独占，`CombatSessionHandle` 的 `DriverHandle.tick()` 驱动；`attack` driver 只做一次 auto-equip/选武器 prep，然后返回 tick handle，没有 async fallback。攻击间隔按 `attackSpeed`；`entityHurt` 记 `damageObserved`，只有 `entityDead` 才报 `killed`；目标从查询范围消失只报 `ATTACK_TARGET_LOST`。显式 order 传 `allowAny:true`；自动 fight 仍做玩家/被动/中立保护。攻击距离按眼→目标 AABB 最近点计算；`reach` 来自 `attackReach?()`，带为 `[reach-0.8, reach-0.2]`、`tooClose=reach-1.4`。
- `attack` driver 在第一次挥击前用 `chooseWeapon` 自动切换最强剑/斧：按材质等级，同材质优先剑，不选弓/弩；无武器则空手。最近一次显式 `equip` 成功后，下一次 `attack`/`dig`/`clear` 使用手动手持，不自动切换；动作启动后恢复自动。
- **CombatSession（唯一实现）**：每 50ms tick 读取 self/target/health/cooldown，维护 `entityId + entityIds` 允许集合；只在集合内选主目标，当前目标死亡/丢失/受保护时切到最近可用目标，带 `targetSwitches` 证据，不自行扩大集合。移动用 `combatInput` 持久控制，盾用 `offhandHold` 持久 stance。attack/lookAt 是短动作，**不停止移动、不放下盾**；`lookAt` 失败不取消攻击。
- **LOS 恢复**：`canSee=false` 时不立即失败；向目标/最后可见位置短距重定位，`losRecoveryTicks`（默认 40）预算内恢复视线；丢失超过短预算时用 `pathTo` 规划 waypoint，按 50ms tick 跟随；超时才报 `ATTACK_NO_LINE_OF_SIGHT`。
- **威胁反馈**：`threatCount`/`rangedThreat`/`explosionThreat` 仅作观测；Combat 不自动 escape。creeper backpedal 是 opt-in 的短距 backoff（`creeperBackpedal:true`），默认关闭。
- **engagement 终态**：`threat.fight` 在无存活目标时以 `ATTACK_TARGETS_RESOLVED` 结束；`killed` 仍只认 `entityDead`，creeper 爆炸记 `neutralized`（有 evidence 时）或 `lost`（兜底），不混入 killed。显式 `attack` 单目标仍要求 killed；neutralized 报 `ATTACK_TARGET_NEUTRALIZED`，但带 `resolution:'neutralized'`/`resolved:true`/`retryable:false`，避免 Agent 误重试。`chaseLeash` 超界：target 记 `escaped`（engagement）或 `ATTACK_CHASE_LIMIT`（显式）。
- **LOS/长距离**：`combatInput` 是局部控制；`canSee=false` 超过短预算或持续 blocked 时，若 adapter 有 `pathTo`，用 `MotionSearch` 规划 waypoint，再由 50ms tick 逐点跟随；普通可见追击不使用阻塞 `moveTo`。路径仍不可达则 `ATTACK_NO_LINE_OF_SIGHT`/`ATTACK_NO_APPROACH`，不无限追。
- **观测**：`resolution`/`resolved`/`retryable`/`escaped` 与 `kills`/`neutralized`/`lostTargets` 分开；`killed` 只在全部目标都有 `entityDead` 时为 true。
- **guard**：自血下降时进入 1000ms 窗口；窗口内移动 hold（tooClose 仍 backoff），攻击/盾照常；计时到期、无盾、目标丢失/死亡/job 结束退出。
- **盾/开场**：副手有盾时 `offhandHold(true)` 持久保持，进入 `preShieldRange`（默认 12）提前举起；stop/endWrite/epoch/suspended/death/disconnect 释放。攻击不强制放下盾；若服务端行为拒绝，才做显式例外，不作为默认。
- **移动安全**：`combat-input` provider 对下一格的脚/头/支撑/液体/火/岩浆/仙人掌做本地检查；允许 1 格上台阶（jump）和 1 格下台阶（`aheadBelow` 空气 + `aheadBelow2` 实体），2+ 格落差/坑仍 blocked；不安全返回 `COMBAT_INPUT_BLOCKED`，session 先尝试 jump/短 detour，持续 blocked 时改用 `pathTo` waypoint，都不可达才 hold。
- **证据**：`inputTicks`/`inputBlocked`/`inputFailures`、`approachMoves`/`strafeMoves`/`backoffMoves`、`guardWindows`/`guardExits`、`stanceRaises`/`stanceDrops`/`stanceReleaseFailures`/`shieldHeldMs`、`preShieldRaises`、`targets`/`kills`/`neutralized`/`escaped`/`targetSwitches`/`lostTargets`、`resolution`/`resolved`/`retryable`、`threatCount`/`rangedThreat`/`explosionThreat`、`reach`/`reachSource`。
- `material.gather` 使用有界区域索引：半径 32，16×16 列分块，每次求值最多取 2 块；命中缓存在内存，`blockUpdated` 直接增删条目，不触发全量重扫。中心移动 >8 格、垂直变化 >4 或缓存超过 15s 时重建并标记 stale。
- `mind.status.metrics` 是进程内 run metrics：已接受的 order 数、order 终态分布、job 计数/重试/抢占、hold 次数与原因、失败码计数、完成率、最近失败诊断。它只从事件派生，不读世界、不产生额外写入。
- `mind.status.identity`（可选）是 provider 的恢复身份 `{worldId, characterId}`。它只读、不参与控制；bridge 用它给记忆/owner-session 分 scope。provider 没有 identity 时字段省略，调用方必须回退而不是猜测。
- `providerState.minecraftVersion`（可选）是**实际使用的 MC 版本**：显式配置时按配置值解析，`version: "auto"` 时是连接前按服务器通告协议号解析出的版本。它是 `minecraft-data` 的规范版本名，可能比服务器对外的版本字符串更粗（例如服务器 `26.1.2` 解析为 `26.1`）。它是诊断字段，不是控制输入；adapter 报不出时字段省略。
- `mind.status.worldTime` 是当前观测的时钟：`{day, timeOfDay, isNight, ticksToSunset}`。`day = floor(worldAge/24000)`；`timeOfDay` 归一化到 0–23999；`isNight` 为 13000–22999；`ticksToSunset` 在白天为 `max(0, 13000-timeOfDay)`，夜间为 0。它是观测值，不是控制输入。
- **Duty（gather）**：`p2_duty {action:"start", duty:{kind:"gather",item,quota,radius?,maxJobs?,maxWallMs?}}` 启动显式常驻任务；`mind.status.duty` 显示状态。duty 只在没有 active order、没有 active plan、没有常驻威胁时运行；显式 order/plan 会暂停它，结束后恢复。配额达到 → completed；无来源/超时/job 预算 → blocked；内部定义错误 → failed；`p2_duty stop` → cancelled。只支持单物品 gather 配额，不自行选新目标。
  - `p2_duty start` 会替换当前 duty：先校验新 spec（失败则现有 duty 不变），再把当前 active duty 置为 `cancelled` + `REPLACED_BY_NEW_DUTY`，停止当前 job，然后启动新 duty；返回 `{previousDuty,started}` 并发出 `duty.terminal`。tracker 的单写者门保证当前 job 停止确认前不会并行启动新 job。
  - duty 持久化到 journal 同目录的 `duty.json` v2（含 worldId/characterId、baseline、activeMs、pausedMs、jobs、state）。start、暂停/恢复、每次 job start、terminal 时落盘；v1 sidecar 可读一次并在下次写入时迁移。
  - body 重启时只恢复 `state=active`、identity 匹配的 duty；`collected = max(0, 当前背包 - baseline)`，`activeMs` 从文件恢复（宕机时间不计入 active）；completed/blocked/failed/cancelled 不复活。过期/超出 job 预算的 duty 恢复为 `blocked`（`DUTY_DEADLINE` / `DUTY_JOB_BUDGET`）。
  - duty 被 order/plan/常驻威胁暂停时 `paused:true`，`activeMs` 不增长；`blocked/failed` 后 base activity 保持 inactive，等 Agent 处理。
- **Base activity**：`p2_base_activity {action:"set"|"status", activity?:{kind:"idle"|"wandering"|"escort", radius?, target?, distance?}}`。默认 `idle`；`wandering` 半径 1–8（默认 8），不接受 `center`；escort 的 target 是玩家名/实体名，distance 1–8（默认 3），不 teleport。escort 通过 `EvalCtx.focus` 跟随已知目标，**没有客户端最大距离**；目标格在方块快照内时选精确站位，快照外直接 `move` 到目标点并用 `range=distance` 到达。
  - `state` 只有 `active | inactive`；escort 目标在 2s 内不可见时保持 `active`、追最后位置，超过 2s 才 `waitingReason:"TARGET_LOST"`，不自动切换。
  - **不持久化**：body 重启后回到 `idle`；Agent 需要重新设置 `wandering`/`escort`/半径。
  - `wandering` 的 anchor 只在 base 接管时记录（启动、order/plan/duty/hold 结束、flee/fight 结束、Agent 在 active 时切换），固定不随身体漂移；`duty`/`hold` 暂停 base。
  - `mind.status.activity` 报告当前生效层：`{layer:"constant"|"order"|"duty"|"base", kind, state:"active"|"waiting"|"paused", pausedBy}`。order/plan 在跑时 layer=order；blocked/failed duty 报 layer=duty、state=waiting；base 被更高层暂停时不改变 activity 的 layer。
- **Reaction policy**：`p2_policy {action:"set"|"reset"|"status", reaction?:{fight?, selfCare?}}`；body 级、process-local、不持久化，重启回只 flee。
  - `fight` 缺省 = 不自动攻击；存在时必须显式写 `allowedTargets`（`[]` = 所有 adapter 判定的 hostile），并支持 `retreatHealth`（0–20，默认 8）、`radius`（1–16，默认 8）、`leash`（1–32，默认 12，且 ≥ radius）。
  - 自动 fight 默认不选玩家、被动/中立、neutral 名单（enderman、spider、cave_spider、piglin、zombified_piglin）和 auto-avoid（creeper、wither、ender_dragon、warden）。`allowedTargets` 显式包含这些名称时校验失败；需要打它们时使用显式 `attack` order。
  - `mind.status.reaction` 返回 `{source:"default"|"agent", mode:"flee"|"allowlist"|"all-hostiles", fight, selfCare}`。`selfCare` 默认启用 `eat`/`unstuck`，`retreat` 只作为血量门槛。
  - 显式 `attack` order 期间自动 fight 关闭；常驻树只保留岩浆/深水等致命环境反射，不因敌对、低血、饥饿或卡住而打断。
- `ActResult.state = 'unknown'` 表示“请求已发出但效果未确认”，调用方不得当成功，也不得立刻重放。
- **事件负载**：`entityHurt` 为 `{entityId, source?}`；`damaged` 为 `{health, source?}`。`source` 是 `{id, name?, username?, type?}`，来自服务端 `damage_event`（1.20+，`sourceCauseId` 对应的实体）；字段缺失表示环境伤害（摔落/岩浆/溺水）或 adapter 无法解析，不能当作“无伤害来源”猜测。`damaged` 只在同一伤害窗口（500ms）内附带来源，避免把旧来源算给环境伤害。归因是观测事实，不改变任何写权限或目标选择权。
- provider 动作依赖物理 tick；区块未加载、死亡或传送中时 `await` 可能没有终态。所有动作都有硬超时，超时按 `ACT_TIMEOUT` / `ACT_UNCONFIRMED` 返回，不重放。
- 超时（`ACT_TIMEOUT` / `ACT_UNCONFIRMED`）和停止（`STOP_UNCONFIRMED`）必须携带 port 证据：`layer`、`actId`、`epoch`、`elapsedMs`、`effect`、`retrySafe`、`lastPoll`、`controlState`、`controlRelease`、`providerCode`。非 move 动作的超时与 move 同规：释放以 `controlState === idle` 或 provider 取消回执为准，未确认即 `STOP_UNCONFIRMED`，不得硬编码成已释放；driver 返回失败时必须保留 `ActResult.observed`，让 `job.terminal.observed` 能定位到 port/provider。语义拆分：
  - `ACT_TIMEOUT`：预算内无终态且释放已确认，动作可安全重试（当前为 `moveTo` / `lookAt` / `equip`）；重试仍受 driver 的有界重试约束。
  - `ACT_UNCONFIRMED`：动作可能已到达服务端，效果未知；不得重放，driver 必须先读回/观察，再由上层决定；不自动重试。
  - `ACTION_DENIED`：仅当同一 act 窗口内的服务端聊天/系统消息明确拒绝（权限、保护、adventure）时使用；`observed.serverMessages` 保留原文，`observed.denial` 指向命中项；没有命中就不猜。
  - `STOP_UNCONFIRMED`：停止/释放无法确认，保持 tracker fault。
  - `CLIENT_TIMEOUT`：兼容输入的超时码；provider 不产生该码，bridge/driver 收到后按“超时/效果未确认”处理，不重放。
- 不存在 capability 协商：`BodyApi` 没声明的方法调用方必须自己回退或报错。

### 2.1 目标身份解析（L3）

- 可选方法：`entityByName?(name)`、`entityById?(id)`、`playerOnline?(name)`。它们不是范围查询：返回 adapter 当前追踪集合里的那一个实体，**没有客户端距离上限**；服务器实体追踪范围是唯一的可见性限制。
- 玩家走 tab list 索引（O(1)）；其它命名实体遍历 adapter 的追踪集合（O(entities)）。缺失的 adapter 回落到 L2 快照的 15 格实体盒。
- `mind` 每 tick 从当前意图（escort target / attack order entityId）解析一次，放进 `EvalCtx.focus`；它不进入 `SnapshotWorld`，也不产生缓存或 TTL。目标消失后由使用方（escort）按 2s 迟滞判定 `TARGET_LOST`。
- `p2_status.mind.focus` 只做诊断：`tracked / online-out-of-range / offline / unknown`，不是决策输入。

### 2.2 移动与站位

- `collision` 是方块局部坐标中的 AABB 列表（`[minX,minY,minZ,maxX,maxY,maxZ]`）；空数组表示无碰撞，省略表示未知，不能用非空气代替碰撞形状。
- `serverTags` 是适配器层的服务端 block tags（`ReadonlySet<string>`），不序列化到 bridge；`undefined` 表示 tags 尚未就绪，不是“没有 tag”。
- `moveTo` 目标为脚下路径格坐标，按格取整；`range` 默认 1、范围 0–8，使用三维格距离。容差内只接受已加载、有安全支撑及身体净空的格；半砖按真实支撑高度完成读回。
- `moveTo` 可带显式移动授权 `allowParkour / allowDiagonal / allowPlace / material / sprint`；没有授权时不得搭桥/垫脚，也不得冲刺。`sprint` 默认关闭，只作用于平地直线（`Traverse`），在 `food <= 6` 时被 move driver 丢弃，`risky`（vanilla planner）忽略它；`go.params.sprint` 是唯一来源。所有普通移动和授权 `unstickDig` 都走 motion；不存在独立的 `motion` 开关或 `goto` 路径。
- `unstickDig` 是显式 break 白名单：只允许列出的坐标/方块名，核心先挖掘并读回，再执行移动；没有列出的块不可挖。
- 成功需要角色实际落地到有效终点，并重新检查站位。路径计算成功、`isMoving=false`、走到 partial 前缀都不是成功。成功体带 `arrival{kind,policy,from,to,cell,feetY,at,movedDistance,elapsedMs}`；干地水平容差 0.45，水 1.0。
- `BODY_OVERLAP`：真实 0.6×1.8 AABB 与已加载方块碰撞相交（半嵌、1 格高小窝）。规划前与到达后 fail-fast，`observed.blockedBy` 给出 `{x,y,z,name}`，不重试；自动清格不在 motion 内实现，Agent 用 `go {unstickDig}` 显式授权。
- `GOAL_NOT_STANDABLE`：`exact` 到达的目标格经 `Rules.standInfo` 证明不可站；带 `reason/blockedBy` 直接失败，不把“下一层”当目标。执行器在身体离开 `validPositions` 时按整条剩余路径前后重同步，不只扫描 ±4 条边。
- **唯一例外**：`traverse scaffold` 的 `moveTo` 可带 `allowUnsupportedGoal:true`；只有同时 `allowPlace:true` 时 motion 才跳过 exact 目标的初始可站预检，让 `Pillar` 先垫脚。普通 `go exact` 不传该参数，仍严格拒绝不可站目标。
- `GOTO_INVALID_TARGET`：容差内没有安全站位；`GOTO_TARGET_UNLOADED`：站位观测不完整；`GOTO_NO_PATH`：当前已加载世界、动作策略和搜索范围内无路；均不能推断整个世界永远不可达。
- `GOTO_STUCK`：位移看门狗及有限恢复失败。`GOTO_SEARCH_TIMEOUT` / `GOTO_SEARCH_LIMIT` / `GOTO_TIMEOUT` 返回 `unknown`，不能当作无路。
- `observed` 保留起点、目标、当前位置、路径状态、阻挡观测、候选站位、最佳前缀终点、耗时、节点数、重规划及恢复次数。`nearbyCandidates` 仅是安全站位建议，未证明可达，不能据此擅自更换目标。
- 移动事件：`move.started / move.progress / move.no_path / move.stuck / move.finished`；经 `p2_events` 可读，进度最多每秒一次；非当前令牌的进度不发布。门与局部挖掘另有 `move.door / move.unstick-dig`。`Traverse` 在需要时开门，并在身体离开门格后由 executor 自动关门；关门不会在身体仍处于门格时执行。
- 停止必须清理路径、goal、按键、定时器与事件监听；`STOP_UNCONFIRMED` 不得被普通取消或非当前令牌错误覆盖。终态同样需要释放确认，tracker 未确认则冻结新调度。强制收尾统一执行 `stopDigging` / `deactivateItem` / `closeWindow` / `clearControlStates` / 清 dig 目标 / 背包重同步；一次停止在 `releaseFaultIntervalMs` 内仍无法确认记一次 fault，连续 `releaseFaultLimit` 次由 provider 主动断开连接，交给 body 既有的 fault/rebuild 路径重建 epoch。
- **安全下落预算**：普通路径禁止脚部 >2 格落差；第一遍无路且目标更低时，motion 第二遍按 `health - 6 + 3` 允许安全下落。落点必须已加载、可站立、支撑非水/岩浆/危险，下落列无阻挡；否则不生成边。
- **显式危险允许**：`policy.hazards.allow` 只能是 `void / lethal_fall / lava`，默认空。这部分**不在 motion 核心**：`go` 把显式 lava/void 目标，以及目标低于当前 >2 格且允许 `lethal_fall` 的请求交给 Agent 层 `fatal` driver；driver 做受控 step-off，只有真实 `died` 才成功；`unloaded` 永不允许。
- 终态 `observed` 包含 `safeFallPass / safeFall / healthBefore / healthAfter`；致命边由 `fatal` driver 的 `died` 证据判断。
- **`traverse` order**：Agent 显式下发的临时通行辅助，不是 `build` 最终几何：
  - `mode:"bridge"`：同高、正方向、1 格宽直线；driver 校验几何/材料后委托 `moveTo { motion, allowPlace, material }`，由 motion `Bridge` 执行；
  - `mode:"scaffold"`：垂直垫脚柱——必须同 x/z 列，向上 `dy` 级，最多 8 级；driver 校验列/材料后委托 motion `Pillar`；provider 不提供 `pillarUp`/`pillar`；
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

- `runId` 在每次尝试时新生成；非当前 `runId` 的结果只对账。
- 失败计数键 = `(orderId|workItemId|driverId)`。
- 失败终态的 `observed.failure` 是统一投影，字段为 `{layer, phase, code, facts, diagnosis, cause, recovery}`：
  - `facts` 只来自同一份观测快照，白名单复制（pos/cell/target/blockedBy/requiredDig/skipped/partial/support/lastAction 等），不重新查世界；
  - `facts.snapshot` 是失败时的有界同快照：`self/target` 各含 feet/head/support，`targetNeighbors` 四邻，`bodyOverlap` 最多 4 格，另带 `pathStatus`/`bestReachable`；每格为 `{cell:[x,y,z], name, loaded}`，最多 16 个去重格，不含 path/candidates/visited；
  - `PLACE_UNSUPPORTED` 的 `facts` 额外带 `supports` 六面布尔（up/down/north/south/east/west）与最多 3 个 `suggestedCells`（`{cell,support}`，指附近已有实心参照面、可实际放置的候选目标格，不是站位）；
  - `diagnosis` 是闭合枚举，一条失败最多一个：`HEAD_BLOCKED`、`SUPPORT_MISSING`、`TARGET_UNLOADED`、`TARGET_OCCUPIED`、`START_EMBEDDED`、`NO_STAND_CELL`、`EFFECT_UNCONFIRMED`、`RELEASE_UNCONFIRMED`、`TOOL_MISSING`、`DENIED`、`UNKNOWN`；事实不足就是 `UNKNOWN`，不生成动作；
  - `recovery` 是契约级字符串：`retry` / `replan` / `reobserve` / `wait` / `restart` / `none`，不是具体动作；
  - `cause` 是 `{kind: "provider"|"world"|"authority"|"budget"|"unknown", code}`，不是自然语言；
  - 失败体只包含 `failure` / `observed` 等证据字段，不包含 `suggestions` / `action` / `params`；具体下一步选项由静态 skill 表或 Agent 决策，P2 不预测后续世界。
- 没有专门失败体的 driver 由 body 在 `job.terminal` 处补一个通用投影，保证每个失败终态都能回答“在哪、为什么、下一步”。

## 4. WorkGiver

```ts
interface WorkGiver {
  id: string
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

### 5.1 Driver 成功定义

`state:'succeeded'` 只表示下表的后置条件已确认；`state:'failed'` 表示无法确认结果（动作可能已生效、部分完成或效果未知），必须保留同一份 `observed` 证据。

| driver / 分支 | `succeeded` 的后置条件 | `failed` 时必须保留的证据 |
|---|---|---|
| `move`（`prepare`/`enter` 复用） | 实际到达有效站位；`arrival` + `standingCell`/`onGround` 读回成立 | `pathStatus`、`bestReachable`、`blockedBy`、`bodyOverlap`、`failure.facts.snapshot` |
| `place` | 目标格（含 `cells` 多格）全部读回为期望方块；已在目标 → `alreadyPlaced:true` | `attempts`、`target/face`、`placedAt/placedCells`、`itemConsumed/retrySafe`、`supports`、`suggestedCells` |
| `dig` 单格 `clear` | 目标格连续两次读回空气 | `block`/`target`、`standQuery`、`blockedBy` |
| `dig` 单格 `harvest` | 目标格为空气，且该分支约定的掉落/背包增量已确认 | `dropDelta`、`pickup`、`standQuery.requiredDig`、`partial`（若有） |
| `collect` | 已选中的每个掉落物实体都确认收集；无匹配掉落时 `drops:0` 也算成功 | `collected/collectedDrops/missed/unreachable/inventoryDelta/items/failure` |
| `dig` `box`/`line` | 所有计划格清除；部分完成只能是 `DIG_PARTIAL` | `dug`、`planned`、`skipped`、`stoppedAt`、`partial` |
| `dig` `tunnel` | 所有计划格清除且到达终点、`returnable:true` | `path`、`dug/planned`、`stoppedAt`、`reason`、`partial` |
| `craft` | `produced >= requested`（不是 `crafted` 操作次数） | `attempted`、`crafted`、`produced`、`before/after`、`CRAFT_INCOMPLETE` |
| `traverse` bridge/scaffold | 到达目标站位（`moveTo` 的 arrival 成立） | `observed.result`、motion `failure`/`snapshot` |
| `equip` | 目标槽位实际为请求物品（hand 用 `held`，offhand 用 `equipped`） | `EQUIP_*`、`item`、`destination`、provider observed |
| `unequip` | 目标槽位读回为空 | `UNEQUIP_*`、`item`、`destination`、provider observed |
| `check` | 查询完成并拿到容器/熔炉结果 | `kind:"container"`、provider error/observed |
| `container` | 传输后目标容器/背包读回符合请求 | `action/item/count`、`containerTransfer` observed |
| `use` | 对应分支的 effect 已确认（sleep / use-on / use-item） | `kind`、`target/item`、provider observed |
| `attack` | 目标 `entityDead` | `entityId`、`damageObserved`、`rejectedSwings`、`shieldUses`、`shieldFailures`、`shieldAutoEquip`、`ATTACK_TARGET_LOST` |
| `fatal` | 真实 `died` 事件或 health 归零 | `target`、`health`、`HAZARD_*` |
| `clear` | 目标格连续两次读回空气 | `block`、`READBACK_UNSTABLE` |

读回要求：

- `craft` 以 `produced >= requested` 为成功；provider 按配方产出数计算所需操作次数，driver 也接受 provider 早停但产出已足够的 `CRAFT_INCOMPLETE`。
- `equip` 读 provider 的目标槽位回执：hand 用 `held`，offhand 用 `equipped`；缺失或错物分别报 `EQUIP_READBACK_UNKNOWN` / `EQUIP_READBACK_MISMATCH`。`unequip` 要求目标槽位 `equipped` 为空，否则 `UNEQUIP_READBACK_MISMATCH`；缺失回执报 `UNEQUIP_READBACK_UNKNOWN`，槽位本来就空算成功。写动作前关闭已打开窗口；`held` 未确认前不得继续放置。
- `container` 读玩家/容器前后计数；缺失计数报 `CONTAINER_READBACK_UNKNOWN`，计数未移动/未达请求量报 `CONTAINER_INCOMPLETE`。
- 任何 `state:'unknown'` 的动作只能以 `failed + ACT_UNCONFIRMED` 收尾，不得升格为 `succeeded`。

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
2. 切换：`seq++`（当前令牌失效）→ `requestStop()` → 等 `stopped` → 起新 job。
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
  deferredWorkItems?: string[]       // 临时入口，最后阶段
  entranceInside?: Vec3
  safeExits?: Array<{ cell: Vec3; exterior: boolean }>
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
- WorkGiver 遍历**全部**工作项，返回任一 `executable`；plan.work 先按 stage（优先级标签）/y/距离排序，再用站位覆盖贪心选锚点，一个 job 仍只放一个 work item。
- stage 是优先级/报告标签，不是硬屏障；支撑、材料、可站立位和 access 谓词决定当下可放前沿；deferred 入口最后。
- `safeExits` 在 plan 实例化时冻结（起始格/入口外/入口内/有界搜索；排除蓝图最终实心格；`exterior` 按 `interiorBounds`）。place 前把该项格子当作实心 overlay，从锚点用有界 A* 检查能到达任一 exit；`unknown` 不通过；最终入口只能从 `exterior` 参考点从室外封。
- plan 结束时 `plan.blocked`/`plan.terminal` 带 `summary { total, satisfied, failed, skipped, unknown, codes, stopReason }` 与有界 failed items；plan 项逐格 place job 失败不唤醒 Agent，只发一条回执；整体成功仍由 verifier 判定。
- `usable-room` 的 `door` 要求门下半两侧在**同一高度**有可站立格；抬高地板/空中平台需在门外提供同高度台阶/门廊，建造器不自动补。

## 9. 意图日志（恢复用）

```jsonc
{"at": 1793..., "kind": "order.accepted", "order": {...}}
{"at": 1793..., "kind": "plan.instantiated", "planId": "...", "templateVersion": 1, "origin": {...}}
{"at": 1793..., "kind": "workItem.terminal", "planId": "...", "workItemId": "w7", "state": "satisfied"}
{"at": 1793..., "kind": "action.pending", "runId": "...", "driverId": "place", "target": {...}}
{"at": 1793..., "kind": "order.terminal", "orderId": "...", "state": "succeeded", "evidence": {...}}
```

恢复：尾部半行丢弃；`action.pending` 只对账不重放；已取消 order 不复活；重启时 **queued order 与 active hold** 置 `abandoned`（`observed.reason:"RESTART"`），不自动继续；active 非 hold order 仍按 pending/plan 恢复；身份/模板版本不匹配 → 归档到 `.p2/archive/journal.jsonl`（覆盖旧档）并发 `journal.archived`，空 journal 启动；JSON 损坏/版本不兼容仍拒绝恢复。

## 10. 错误码

| 码 | 含义 |
|---|---|
| `STALE_WRITE` | 写令牌不匹配（非当前实例） |
| `ACT_TIMEOUT` | 动作在预算内无终态，释放已确认，且动作可安全重试（move/look/equip） |
| `ACT_UNCONFIRMED` | 动作可能已生效但无终态；不重放，先读回/观察 |
| `ACTION_DENIED` | 同一 act 窗口内有服务端消息明确拒绝（权限/保护/adventure）；带 `serverMessages`/`denial` 证据 |
| `CLIENT_TIMEOUT` | 兼容输入的超时码；provider 不产生，按超时/效果未确认处理 |
| `NO_MATERIAL` / `NO_SUPPORT` / `NO_STAND` / `UNREACHABLE` / `CONFLICT` | 工作项不可执行 |
| `DRIVER_FAULT` | driver 内部错误 |
| `STOP_UNCONFIRMED` | 停止无法确认 → tracker fault |
| `DEFINITION_ERROR` | 树/模板/注册表定义错误 |
| `INSUFFICIENT_EVIDENCE` | 验证证据不足（不等于失败） |
| `TOOL_INSUFFICIENT` | `harvest` 没有可用工具 |
| `EQUIP_READBACK_UNKNOWN` | provider 报告 equip 成功，但没有当前手持物读回；按结果契约不得算成功 |
| `EQUIP_READBACK_MISMATCH` | provider 报告 equip 成功，但读回的手持物不是请求物品 |
| `OFFHAND_HOLD_UNSUPPORTED` | 适配器没有 `offhandHold`；调用方回退到 timed shield |
| `OFFHAND_EMPTY` | 尝试持有空副手 |
| `CONTAINER_READBACK_UNKNOWN` | provider 完成传输但没给玩家/容器前后计数；不得算成功 |
| `CONTAINER_INCOMPLETE` | 传输动作已执行，但玩家/容器计数未达到请求数量 |
| `BLOCK_UNBREAKABLE` | 方块不可破坏 |
| `DIG_NO_BLOCK` | 目标是空气/没有方块 |
| `PICKUP_UNREACHABLE` | 掉落物存在但无法走到 |
| `PICKUP_NO_RETURN` | 掉落物只能经单向入口到达（可捡但拾取后无路返回）；未进入该站位 |
| `COLLECT_NO_RETURN` | collect 观测到的掉落物只有单向可达的拾取站位；未进入 |
| `CRAFT_INCOMPLETE` | 合成已开始但 `produced < requested`；`observed.crafted/attempted/produced` 如实记录 |
| `DIG_PARTIAL` | 体积挖掘部分完成；`observed.dug/skipped/partial` 如实记录，不自动重试 |
| `DIG_VOLUME_TOO_LARGE` | 体积超过 `maxBlocks`，未开始挖掘 |
| `GOAL_NOT_STANDABLE` | `exact` 目标格不可站；带 `reason/blockedBy` |
| `PICKUP_NOT_COLLECTED` | 已到达掉落物附近，背包仍未增加 |

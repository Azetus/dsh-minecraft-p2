# operation / provider 契约改造方案（typed contract）

> 状态：**设计定稿，未实施**（2026-10-30）。本文只定契约与分层，不改动当前 0.2.5 代码。
> 关联：[Minecraft 接入决策](../MINECRAFT-INTEGRATION-OPTIONS.md) §1.2、[operation 能力绑定与发布](../OPERATIONS-AND-RELEASE.md) §2–§3、[契约总览](../CONTRACTS.md) §5.2。

## 1. 目标与不变式

1. **provider 是实现，不是接口**。P2 core、behavior、act、guard、kernel 只依赖 operation 契约；不出现 Mineflayer 的类型、对象、事件或插件句柄。
2. **类型由 P2 自己定义**。契约层持有领域类型与语义；provider 只做映射（anti-corruption layer）。契约层**零外部依赖**，不得 import provider 或任何游戏库。
3. **agent 仍可在运行时扩展 operation**，扩展物必须通过同一份契约的运行时校验；不因为"是 agent 写的"就绕过。
4. **不做 MROS、不做缺失降级**。能力缺失即明确失败（沿用 `CAPABILITY_MISMATCH` / `CAPABILITY_MISSING`），不做语义猜测；迁移的完整性由类型 + 校验 + 契约断言保证。
5. **不承诺热替换**：provider 更换需要新 binding。

## 2. 类型与依赖方向

```text
contracts/domain.ts + contracts/ops/*.ts      ← 零依赖（仅 TS 标准库）
        ↑                       ↑
providers/*/ops/*.ts        nav/ · crafting/ · behaviors · controller
（只 import contracts）      （只 import contracts，不 import provider）
```

- `contracts/**` 的 import 图里出现 `mineflayer`、`minecraft-protocol`、`vec3` 或 `providers/**` 即视为契约破坏；用脚本在 `npm run check` 中检查（计划新增 `scripts/check-contract-boundary.mjs`）。
- 领域类型示例（语义而非底层形状）：

```ts
export type ItemName = string & { readonly __brand: 'ItemName' }
export type BlockName = string & { readonly __brand: 'BlockName' }
export interface Vec3 { x: number; y: number; z: number }

export interface EntityRef {
  id: number
  name: string                                  // 原始名：'creeper' / 'item'
  kind: 'hostile' | 'passive' | 'other'         // 适配层负责消除 name/type 歧义
  isItem: boolean                               // 掉落物判定收敛到这里
  position: Vec3
  distance: number
}
```

## 3. 分层：原语在 provider，闭环在上层

| 层 | 内容 | 依赖 |
| --- | --- | --- |
| **SensePort** | position / health（含 oxygen、food、saturation）/ inventory / block / blocks / entities / time / windowSnapshot | provider |
| **ActPort** | look / setMovement(intent, durationMs) / dig / place / attack / equip / use / interact / sleep | provider |
| **WindowPort** | openWindow / clickSlot / closeWindow | provider |
| **Nav（上层，语义接口）** | goto、上浮、脱困的**语义**（进度、失败证据、期限、停止结论） | 先定接口；算法可暂留在 adapter |
| **Crafting（上层，语义接口）** | craft(item,count) 的**语义**（配方可用性、失败证据、超时、产物校验） | 先定接口；算法可暂留在 adapter |
| **behavior / act / guard / controller** | 策略与组合 | 仅上层与原语 |

判定原则：**能在上层用原语组合出来的，不放进 provider**。但"上移"分两步，不要捆绑成一次重写：

- **第一步（本期）**：只定 **Nav / Crafting 的语义接口**——调用方拿到进度、失败证据、期限与停止结论；首个 adapter 仍可内部使用 `mineflayer-pathfinder` / 现有合成实现。这样上层不再依赖其具体实现，但不需要立刻重写算法。
- **第二步（另立项）**：把导航/合成算法真正移到上层（通用原语组合）。它需要碰撞、流体、运动规则等额外信息，不能由"十几个方法"推导出来；不完成这一步也能迁移 provider。
- 因此：`goto`/`craft` 仍是当前 adapter 的能力，但**对外只暴露语义结果**；`GOTO_NO_PATH` 这类结果码要逐步替换为带证据的失败（`no-path: head-blocked@x,y,z`），能给出证据就给，给不出就明确写"未知原因"，不得编造。

## 4. 接口与结果类型（必须有读回语义）

```ts
export interface DigOps {
  mine(pos: BlockPos): Promise<DigResult>
}
export interface DigResult {
  blockBefore: BlockName
  blockAfter: BlockName          // 必须来自读回；"成功但没挖掉"无法表达
  dropsSeen: ItemStack[]         // 手持物错误导致的零掉落在此暴露
}
export interface PlaceOps {
  place(pos: BlockPos, item: ItemName): Promise<PlaceResult>
}
export interface PlaceResult { at: BlockPos; blockAfter: BlockName }

export interface EquipOps {
  equip(item: ItemName): Promise<EquipResult>   // 找不到物品必须抛错
}
export interface EquipResult { equipped: ItemName }
```

规则：

- **成功必须由读回证明**，禁止"调用返回 void/true 即成功"。
- 失败一律抛带 `code` 的 `P2Error`；错误码属于契约（见 `docs/CONTRACTS.md` §6），不得由 provider 自创同义码。
- 可选字段（如 `oxygen?: number`）只能表达"该实现确实观测不到"，读取处**必须**有分支；无分支读取按错误处理。

## 5. agent 扩展 operation 的运行时约束

`act`/`behavior` 是沙箱 JS（禁止 import），因此拿不到编译期类型。对 agent 产物采用**同一份契约的运行时校验**：

1. op manifest 增加 `implements: <InterfaceName>`（如 `DigOps`）与既有 `opKind`。
2. `p2_check` 用契约的 type guard 校验：
   - 声明的接口名存在且类别（query/control）匹配；
   - `parameters` / `result` 形状与接口一致；
   - control op 必须实现 `start/update/stop/cleanup` 生命周期并有释放结论。
3. `p2_check` 对 act 的 `queryOps`/`controlOps` 求值：这些名字必须被当前 binding 的 provider（或已激活的 portable op）覆盖，缺一即 `PROVIDER_INCOMPLETE: <interface>.<method>`，拒绝激活。
4. 新增 op 若声明 `implements` 且实现完整，可替代 provider 同名实现；同名覆盖须记录在 `p2_status.devOps`（现有语义）。

## 6. 版本与能力

- 契约带 `opContractVersion`；provider manifest 引用它（沿用[能力绑定文档](../OPERATIONS-AND-RELEASE.md) §2 的定义），版本不匹配即拒绝启动。
- 能力集合仍由 provider 静态声明 + 连接握手核验；握手不一致返回 `CAPABILITY_MISMATCH`，不静默降级。
- binding 记录 provider 指纹（packageId/version/digest + 契约版本 + 能力摘要）。

## 7. 迁移流程（新 provider）

1. 实现三组原语（SensePort / ActPort / WindowPort）+ `capabilities()`。
2. 通过该实现跑各组契约断言（每接口 3–5 条，见 §8）。
3. `p2_check` 全部 act，`PROVIDER_INCOMPLETE` 会精确指出缺失方法。
4. 逐步补齐上层依赖（Nav/Crafting 不需要 provider 改任何代码）。
5. 用回归脚本（`camp-status` op + 三个 act 的最小闭环）作为迁移验收证据。
6. 记录新的 binding 与 provider manifest 摘要。

## 8. 契约断言（迁移门槛）

每组接口配 3–5 条语义断言，跑在真实实现上，不进生产路径。首批断言应覆盖已知语义陷阱：

| 断言 | 期望 |
| --- | --- |
| `equip` 不存在的物品 | 抛 `ITEM_NOT_FOUND`（当前实现静默成功） |
| `mine` 手持非正确工具挖石 | 不得返回"成功且无掉落"；应为明确失败或 `dropsSeen` 与规则一致 |
| `entities` 过滤掉落物 | `name='item'` 命中；`type='item'` 不成立 |
| `place` 目标格被植物占据 | 明确失败码，且不消耗物品 |
| `place` 水中放置 | 明确失败或按契约置换，二者择一并写死 |
| `blocks` 的 `exposed` 语义 | 未加载区块返回 null，不得当作空气 |
| `mine` 的读回 | `blockAfter` 与 `blocks` 查询一致 |
| control 停止 | `stop` 后释放结论为 idle 或 `unconfirmed`，不得谎报 released |

> 这些断言在当前实现上预期有红项；红项即下一个版本的修复清单，而不是契约失败。

## 9. 落地阶段

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| 0 | `contracts/domain.ts` + 三组接口 + type guards + 依赖方向检查 | 边界脚本通过，接口可被 TS 引用 |
| 1 | provider 实现三组接口；act 改调用接口 | `implements` 编译通过；契约断言首批通过 |
| 2 | Nav / Crafting **语义接口**落地（算法仍留在 adapter） | 调用方只依赖语义结果；失败带证据或明确"未知原因" |
| 2b | （另立项）导航/合成算法上移为通用实现 | 独立验收，不与 provider 迁移绑定 |
| 3 | 补齐其余接口组 + 每组断言 | 每组断言绿 |
| 4 | 新 provider（通用客户端）实现原语 | §7 回归脚本通过 |

# P2Controller M0–M3 实现报告

> 分支 `P2Controller`，版本 **0.2.6**，日期 2026-10-30。设计基线：[P2CONTROLLER.md](P2CONTROLLER.md) v2；契约：[OP-PROVIDER-CONTRACT.md](OP-PROVIDER-CONTRACT.md)。
> **后续（M4）**：Controller 已接入 body，并新增 `strategy` artifact 载体；见 [P2CONTROLLER-BODY-WIRING.md](P2CONTROLLER-BODY-WIRING.md)。本报告保留 M0–M3 的实现记录。
> 结论：M0–M3 的 fake/单测出口全部满足，`npm run check` 全绿（47 文件 / 471 tests）。**本阶段未连接真实游戏、未打包、未启动 body。**

## 1. 结论与范围

| 里程碑 | 出口条件 | 证据 |
| --- | --- | --- |
| M0 动作地基 | 停止后不再发旧操作；未确认释放 → `control-fault`；迟到结果不产生控制 | `test/controller-lease.test.ts`（9）、`test/provider-stop-release.test.ts`（5） |
| M1 骨架闭环 | 危险可抢占；承诺 suspended；脱险后重新核验再继续；`blocked` 可解释 | `test/controller-m1.test.ts`（6）、`test/controller-observe.test.ts`（7） |
| M2 策略替换 | 目标与进度保留；旧版本不再发动作；已安装 ≠ 已接管可观测；跨版本重新核验 | `test/controller-m2.test.ts`（3） |
| M3 复用验证 | 第二个任务 + 第二类危险；新增内容主要是策略；核心零改动 | `test/controller-m3.test.ts`（4，含静态边界断言） |

不在本轮范围内：Controller 接入 body 调度、策略沙箱/artifact 载体、Nav/Crafting 算法上移、实机长跑。

## 2. 改动清单

### 新增：Controller 核心（provider 无关）

| 文件 | 内容 |
| --- | --- |
| `src/controller/types.ts` | 动作请求/结果、租约、交接阶段、故障、槽位与危险类序 |
| `src/controller/lease.ts` | 唯一动作租约 + 交接 FSM（revoke→stop→confirm→grant→start）、generation fencing、`control-fault` |
| `src/controller/observation.ts` | 事实总线（known/unknown、sampledAt、validUntil、scope、evidenceId、coherenceWindow、freshSince、作用域失效） |
| `src/controller/memory.ts` | 有界行动记忆（危险区域、失败目标、逃生阶段、重试预算） |
| `src/controller/commitment.ts` | 承诺仓库、baseline、证据、完成判定（count-delta / fact-equals / standing） |
| `src/controller/strategy.ts` | 策略端口、版本/attempt 注册表、boundary/interrupt 安装 |
| `src/controller/slots.ts` | S0–S3 固定骨架与冲突矩阵（类序 > 槽序 > 注册序） |
| `src/controller/controller.ts` | 常驻 tick：接管 → 交接 → 观测刷新 → 评估/承诺 → 仲裁 → dispatch |
| `src/controller/strategies/*` | harvest（采集）、water-escape（水中逃生）、creeper-escape（苦力怕）、follow-owner（跟随/standing） |
| `src/controller/index.ts` | 公开入口 |

### 修改：provider 停止语义（M0，直接作用于现有 body 路径）

`src/provider/mineflayer.ts`：

- `stop()` 只发停止请求；`cancelled` 改为**释放已观察**才置位，新增 `refreshRelease()/releaseObserved()`。
- 释放证据：pathfinder `isMoving()`（懒停止）、`targetDigBlock`、craft 链是否仍在跑、`isSleeping`、残留 control state；观察抛错 → `unknown`。
- `craftRepeatedly` 在每次配方前后、重试前与等待窗口检查取消；`waitForItemCount`/`waitUntilGrounded`/pillar 循环加入取消检查与可中断等待。

### 新增测试

`test/controller-lease.test.ts`、`test/controller-m1.test.ts`、`test/controller-observe.test.ts`、`test/controller-m2.test.ts`、`test/controller-m3.test.ts`、`test/provider-stop-release.test.ts`、`test/controller-harness.ts`（fake world/actuator）。

### 文档

- `docs/runtime/P2CONTROLLER.md`：状态改为已实施；§6 补充 S0 `unknown`/`emergency-running` 口径；§12 回填默认值与未决项；新增 §13 实现映射（状态/字段/原因码/错误码）。
- `docs/CONTRACTS.md` §6：补充 `LEASE_REQUIRED` 与承诺类错误的处理归属。
- 本报告。

## 3. 契约偏离

未发现必须偏离**控制权/交接语义**的事项，未新增 §12 "偏离"条目。以下为实现细节/澄清：

1. **S0 的 `unknown` 不算危险在场**。设计文档的"保守分支"若理解为"S0 缺观测即压制任务"，会在缺少 `oxygen` 等可选观测时永久冻结任务；实现把 S0 的 `propose/recover/blocked/running` 视为危险在场，`unknown` 只记 `degraded`。已写入 §6。
2. **`recover` 判定可携带 `action`**。设计类型中 `recover` 只有 `reason`/`leasePriority`；没有动作就无法执行恢复步骤，故增加可选 `action` 与 `hazardClass`。
3. **`ActionRequest` 增加 `holder`/`attemptId`**，用于单一动作槽归属与跨版本 attempt 隔离。
4. **`PostCondition` 增加 `standing`**，表达"standing 承诺没有自然成功终态"；task 承诺禁止使用该类型。
5. **Controller 未接入 body**。§3.3 要求同一 body 只启用一种控制模式，策略执行载体（§12.1）未定；本轮以库 + 端口落地，接线另行安排（§13.7）。

## 4. 风险与未决问题

| 风险/未决 | 说明 | 建议 |
| --- | --- | --- |
| 未实机验证 | 所有 Controller 行为只经 fake；provider 停止语义仅单测 | 先按 §5 做实机定向验证，再决定是否接线 |
| pathfinder 释放判定 | 以 `isMoving()` 为准；服务器卡 tick 时可能迟迟不释放 | 观察 `RELEASE_UNCONFIRMED` 比例；必要时 provider 增加 `path_stop` 事件确认 |
| craft 取消粒度 | 取消发生在配方之间；已发出的 `bot.craft` 不能在事务中途撤回 | 实机观察"停止后是否多产出一个"；若出现，需在 provider 层记录已发出事务 |
| 观测默认值 | TTL/窗口/刷新/blocked 期限均为保守值，未实测 | 实机采集事实年龄分布与 `blocked` 原因再调 |
| 无 owner 唤醒 | `blocked` 目前只写状态/事件，不推送给 DSH owner | 接线时把 `commitment-blocked` 事件接入现有事件通道 |
| 策略沙箱 | 当前策略是受信代码模块；agent 现场编写需沙箱 | 另立项；在此之前不要开放运行期任意策略 |
| 计划外行为 | 四槽仅 S0/S2 有真实内容；S1/S3 无内置策略 | 需要维护/待机策略时按 M3 方式加内容 |

## 5. 实机测试建议（给人类）

### 5.1 本轮可直接验证（不需要 Controller 接线）

1. **goto 懒停止**：发起一个长距离 `goto`，在移动中途 `stop`。
   - 观察 `provider.liveStatus().controlState` 在停止后是否仍短暂为 `active`，直到路径真正清空才变 `idle`；`controlRelease` 不得在仍移动时返回 `confirmed`。
   - 失败判定：stop 后机器人继续移动且 `controlState` 已报 `idle`。
2. **合成取消**：`craft` 数量 8，在第一件完成后停止。
   - 期望 `act` 结果为 `cancelled`，背包只增加 1 件；失败判定：停止后继续产出。
3. **睡眠/挖掘停止**：`sleep` 后 `stop`，`isSleeping` 必须变 false 才释放；`dig` 停止后 `targetDigBlock` 必须清空。
4. **既有回归**：act 冒烟与 watch 不变。

### 5.2 Controller 接线后要看的指标

| 指标 | 采集点 | 期望/失败判定 |
| --- | --- | --- |
| `t_detect` | 事实 `sampledAt` → S0 判定 | 与 S0 判定节拍同量级；持续 >1s 需查观测刷新 |
| `t_release` | `stop-request` 事件 → `release-confirmed` | 默认 2s 内；超时即 `control-fault` |
| `t_effective` | `granted` → 首个动作成功 | 与 act 启动开销同量级 |
| 重复危险 | `memory.hazards` 同名 hazard 60 分钟内重复进入 | 目标 0；>0 查逃生后的重核验 |
| 假成功 | 承诺 `succeeded` 且 `evidence` 为空/过期/baseline 缺失 | 目标 0；出现即阻止发布 |
| 误抢占 | `action-preempted` 后 10s 内回到原动作且无保护效果 | 观察 S0 阈值 |
| `blocked` | `commitment.blocked.reason/missing/since` | 原因必须可归入：缺观测/控制故障/策略失败/期限 |

### 5.3 判定失败的硬条件

- 无租约仍出现新动作（`LEASE_REQUIRED` 未生效）或 `control-fault` 期间仍 dispatch。
- 承诺 `succeeded` 但 `evidence` 为空、`freshSince` 之前的样本、或 baseline 缺失。
- 停止后仍发出旧 generation 的动作（provider 停止语义回退）。
- `blocked` 无 `missing`/`diagnostics`，或长期 `unknown` 不转 `blocked`。

## 6. M4 实机冒烟结果（2026-10-30，VANILLA 1.21.1 @127.0.0.1:25575）

环境：body 0.2.6、`P2_Bot`、controller 模式，测试位置基地附近（y=72 草地）。

### 6.1 通过项

| 检查 | 证据 |
| --- | --- |
| enable → install → commit | `mode=active`；`strategies[].activeVersion` 与 `attemptId` 递增；承诺 `active` |
| act dispatch + 租约身份 | `action-started` → `action-completed`；act 以 `runId=controller`、递增 `actInstanceId/generation` 执行 |
| 完成判定（baseline + 收尾后证据） | `probe-pickup-2`：捡起掉落的 dirt 后 `commitment-succeeded`，evidence `sampledAt` 晚于动作结束、`baseline=0/observed=1` |
| 无假成功 | 挖掉脚下草方块后掉落物未入包，承诺保持 `active` 直到走到掉落物；未提前成功 |
| 策略替换 | v1→v2→v3→v4 boundary 接管；`installedVersion` 与 `activeVersion` 分离；`strategy-taken-over` 事件；旧 attempt 不再驱动 |
| 动作失败可解释 | `GOTO_NO_PATH` 记录为 `action-completed: failed` + `memory.failures`，承诺不被伪造成成功 |
| 中途停止 | 长距离 goto 进行中 `controller.cancel`：`action-started` → `commitment-cancelled` → `action-completed: cancelled`，provider `controlState=idle/controlRelease=confirmed` |
| 承诺期限 | 超时承诺 `failed: COMMITMENT_DEADLINE`，不重试旧步骤 |
| 模式互斥 | Controller active 时 `p2_switch` 返回 `CONTROL_MODE_CONFLICT`；disable 后同一请求返回 `ARTIFACT_NOT_ACTIVE`（仅剩产物校验） |
| disable | `mode=off`，无租约/动作；provider idle |

### 6.2 实机发现并修复的问题

1. **跨 realm 异常显示为 `[object Object]`**：vm 抛出的错误不是宿主 `Error` 实例，诊断只拿到字符串化对象。修复：`messageOf` 读取对象 `message` 字段；新增契约测试。重打包后诊断可读。
2. **`lastOutcome` 跨承诺/跨 attempt 泄漏**：同一次策略尝试下，上一个承诺的动作结局会让新承诺的策略误判“已完成/已到达”（实机表现为新 walk 不发起动作）。修复：`commit()` 与策略接管时清空 `lastOutcome`/`lastCompletionAt`；M1/M2 各加回归测试。
3. 默认 `nearbyBlocks` 增加 `grass_block`（地表常见方块，掉落 dirt），便于采集策略直接使用。

### 6.3 未覆盖 / 后续

- S0 危险抢占（水中/苦力怕）未在实机触发：测试点附近无安全可控的水域/苦力怕；该路径仍只有 fake 覆盖。
- 实机探针策略把 bot 带到基地西侧约 14 格（僵尸/骷髅 5–10 格），已用 `p2_rescue action=tp` 回基地（审计 id `f75b4308-…`）。实机测试应限制行走目标在已知安全半径内，或先安装 S0 策略。
- 探针策略（`strategies/probe-*.js`）是测试内容，不属于产品；`probe-dig` 的“脚下挖掘”会在原地留下 1 格坑。

### 6.4 修复复测（第二次 `/p2 start` 后）

| 复测 | 结果 |
| --- | --- |
| 同一 attempt 连续两次承诺 | `reg-a` walk:-6 成功后 `cancel`；`reg-b` walk:-3 立即 `action-started` 并成功 —— 旧 `lastOutcome` 不再卡住新承诺 |
| 跨 realm 异常诊断 | 抛错策略的诊断显示 `Error: probe-error-boom`（不再是 `[object Object]`） |

遗留小项：vm 错误消息仍带 `Error: ` 前缀（`strategy-runtime` 的 `messageOf` 用 String 回退）；不影响可读性，作为下一次构建的清理项。

### 6.5 S0 受控水池测试（第三次实机）

受控 3×3 石台 + 中心水（cobblestone y=72，water -11,72,6）。S2 walk 目标为水池中心。

通过：
- `action-started` S2 walk → `commitment-suspended`（reason `preempted by water-escape`）→ S0 接管租约（holder `S0:water-escape`）→ decision `emergency-running`，S1–S3 被压制。
- S0 逃生动作以 `runId=controller`、S0 身份执行；S2 承诺保留 checkpoint。

发现并修复两个安全问题：
1. **disable 后仍 dispatch**：disable 只做了取消与撤销，但 tick 仍继续评估/仲裁；S0 逃生循环在 `mode=disabling` 下继续启动动作（20+ 次）。修复：`P2Controller.setAutonomy(false)` 在撤销前冻结评估与 dispatch；`enable` 恢复。新增 body 测试。
2. **S0 无界重试**：artifact S0 读不到任务承诺的 checkpoint，逃生失败会无限重启。修复：核心按 `holder|intent` 限 60s 内 3 次启动；超出 → `blocked`（`S0_RETRY_EXHAUSTED`），承诺 `blocked: EMERGENCY_BLOCKED`，不落回任务。新增测试。

内容问题（非核心）：`walk-back` 不能爬上 1 格石沿；水池逃生 act 应为跳跃/上浮类（例如先 `move direction=jump` 再后退），950ms 后退不足。测试后已 rescue 回基地，水域未再扩散。

### 6.6 安全修复复测（第四次实机）

| 复测 | 结果 |
| --- | --- |
| S0 有界重试 | S2 walk 进入水池 → `commitment-suspended`（preempted by water-escape）→ S0 恰好启动 3 次 `leave-water` → `commitment-blocked: EMERGENCY_BLOCKED`，诊断 `S0_RETRY_EXHAUSTED: started 3 times`；没有第 4 次动作 |
| disable 冻结 | `disable` 立即 `mode=off`、lease `released`；之后 2s 内 `controller.events` 无任何新事件（seq 停在 12），provider `controlState=idle/confirmed` |

测试后 bot 仍在浅水池中，已 rescue 回基地（(-9.5,72,12.5)，0 近身敌对，controller off）。水池仍留在基地北侧，后续可改为 jump/swim-up 逃生内容后复用。

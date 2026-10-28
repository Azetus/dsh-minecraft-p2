# M5 G2 验证记录

> 记录时间：2026-10-28（Asia/Hong_Kong）。本文件是 G2 的实测证据，不是设计承诺。
> 冻结内核：M5 G2 场景与验证脚本基线。该基线之后仅修改了场景内容与脚本，未修改 `src/core`、`src/contracts`、`src/runner` 语义。

## 1. 环境

| 项目 | 值 |
| --- | --- |
| 游戏 | Java Vanilla 1.21.1，LAN `127.0.0.1:25575`，生存模式，允许指令 |
| 角色 | `P2_Bot`（body 托管）、`P2_Operator`（已 op，用于搭场地与投放物品） |
| 场地 | 强加载区块 `96,96`–`128,128`；石台 `y=99`；空间 `y=100..104` 清空 |
| 世界 | peaceful、固定白天、`doDaylightCycle=false`、`doMobSpawning=false`、`keepInventory=true` |
| 入口 | 直接 body 协议（`lib/body/body.mjs`），不是 DSH 工具链；M4 已单独验证过 DSH 工具链 |
| 驱动 | `scripts/m5-g2.mjs <case>`；原始证据写入 `.m5-runs/<case>-<time>.json` |

运行前执行 `npm run build`，runner 入口为 `lib/runner.js`；body 守护 runner，harness 每 2s 发送 heartbeat。

## 2. 主轨迹结果

| 场景 | 结果 | 关键证据 | 原始文件 |
| --- | --- | --- | --- |
| S1 拾取最近掉落物 | **通过** | `succeeded`；最终背包 `apple=1`；投放 3 个、拾取后剩 2 | `s1-2026-10-28T05-31-50-747Z.json` |
| S2 持续巡逻 | **通过** | 有序到达 `A,B,C,A,B,C`（6 次）；运行中发 stop；终态 `cancelled` | `s2-2026-10-28T05-33-01-956Z.json` |
| S3 有限采集 | **通过** | `succeeded`；最终 `dirt=4`（初始 2，采 2 个目标） | `s3-2026-10-28T05-33-20-008Z.json` |
| S4 途中拾取再继续 | **通过** | 掉落在前往 B 途中生成；`pickupSeen`、`reached-B`、`reached-C` 依次发生；最后 stop → `cancelled` | `s4-2026-10-28T05-33-39-794Z.json` |

S4 的关键顺序满足规格：原移动被打断 → 收尾后拾取 → 重新前往**尚未到达的 B** → 到 C，未跳点。

## 3. 反例结果

| 反例 | 期望 | 实际 | 原始文件 |
| --- | --- | --- | --- |
| S1x 选中后目标消失 | `failed`，不得把实体消失当成功 | `failed / TARGET_GONE`；背包 0；目标实体已清除 | `s1x-2026-10-28T05-35-08-446Z.json` |
| S2x 前往 B 的路径被屏障阻断 | 整段失败，不跳点 | `failed / MOVE_TO_BLOCKED` | `s2x-2026-10-28T05-34-29-292Z.json` |
| S3x 资源不足（初始 2、仅 1 个目标、目标 4） | `failed / INSUFFICIENT_RESOURCE`，保留已取得成果 | `failed / INSUFFICIENT_RESOURCE`；背包 3 | `s3x-2026-10-28T05-35-55-213Z.json` |
| S4x 打断后目标消失 | 恢复到巡逻，继续到 B、C | 继续到达 B、C；仍 `running`；stop → `cancelled` | `s4x-2026-10-28T05-35-35-863Z.json` |

反例的 harness 结论字段为 `ok:false` 是预期：`ok` 只表示「终态为 succeeded/cancelled」，反例的预期终态是 failed。

## 4. G2 指标（初步）

| 指标 | 观察 |
| --- | --- |
| 核心稳定 | 冻结后未修改 `src/core`、`src/contracts`、`src/runner`；场景内容与脚本除外 |
| 策略归属 | 三个内置 act 都是单 op 包装（`move-to`、`mine-one`、`stop`），没有承包整个任务的 act；policy 只做选择与计数 |
| 取消责任 | behavior/policy 中没有停止标志或取消轮询；取消由 body 与 act 契约完成（S2/S4 的 stop） |
| 状态负担 | locals 均有业务含义（`leg`、`attempt`、`verdict`、`pick`），没有 `programCounter` 类状态 |
| 可读性 | **未完成**：还没有让独立读者仅看计划、接口说明和 status 回答 4 个问题 |
| 改动局部性 | **未完成**：四个策略变体 V1—V4 尚未运行 |

## 5. 与冻结集的偏差

以下在冻结前完成，记录为 G1 的一部分，不计入 G2 核心修改：

- 新增 `length` 表达式：S4 的 guard 需要判断「附近是否有掉落物」，没有它就是不可表达的。
- `entities` 查询增加 `objectType` / `name` 过滤：这是 provider 适配，不改变核心语义。
- 查询默认期限改为 1000ms、guard 复用新鲜证据、act 前完成条件检查、reactive 分支等待收尾、`fail` 节点：冻结集 F1—F7。

冻结后修改过、但属于场景内容的项：

- S1 behavior 增加「库存未增加则 `TARGET_GONE`」的验证分支。
- S3 的拾取等待从 500ms 调整为 900ms（物品拾取延迟）。
- harness 增加反例用例与物品名修正（Mineflayer 物品名是不带命名空间的 `apple`/`dirt`）。

## 6. 未完成项（G2 尚未收口）

1. **策略变体 V1—V4**：最远优先、往返巡逻、达标后返程、目标失效即失败。由于 `act` 与 `policy` 引用是确切 artifact，改 policy 需要新的 behavior artifact 指向它；这本身是 G2 应记录的成本。
2. **可读性 4/4**：需要一名非作者仅凭计划、接口说明与 `status` 回答四个问题。
3. **S3 的「启动时已达标直接成功」**：未单独运行。
4. **S1 的“不因其他物品变近而换目标”**：当前 S1 只选一次，未单独构造“另一物品更近”的动态反例。
5. **公共扰动组**：policy 等待中取消、取消与成功同批、unknown/过期、活动分支 policy 失败、清理失败。部分由单测覆盖（`test/runtime-fixes.test.ts`、`test/runner.test.ts`），尚未逐项对应到真实游戏。

## 7. 结论

四个主场景与四个业务反例在冻结内核上完成，计划与执行分层清楚，取消与收尾由平台承担。**尚不能给出 G3 结论**：变体与可读性未完成，公共扰动只做了软件层覆盖。

倾向性判断：小 IR + policy + act 能承载 S1—S4，未出现“真实计划逃离 IR”或“每场景都要改核心”的信号；但样本量仅四个场景，G3 前应补齐变体与独立读者检查。

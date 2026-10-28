# M5 G2 报告（G3 判定前）

> 2026-10-28。本报告汇总 G1 冻结后的 G2 实测、指标与遗留问题，供 G3 判定使用。**本报告不给出 G3 结论**。
> 详细证据见 [M5-G2-EVIDENCE.md](M5-G2-EVIDENCE.md) 与 `.m5-runs/`（本机，ignored）。

## 1. 范围与冻结

| 项 | 值 |
| --- | --- |
| 冻结内核 | M5 G2 场景与验证脚本基线 |
| 环境 | Java Vanilla 1.21.1，LAN 25575，生存、允许指令；`P2_Bot` + 已 op 的 `P2_Operator` |
| 场地 | 强加载区块 96–128；石台 `y=99`；空间 `y=100–104` 清空；peaceful、固定白天 |
| 入口 | body 协议（`lib/body/body.mjs`）+ 真实 provider + 隔离 runner（vm 基线） |

冻结后对 `src/core`、`src/contracts`、`src/runner` 的语义修改为 **0**；后续提交只改场景内容、harness 与文档。

## 2. 已完成用例

### 2.1 主轨迹

| 用例 | 结果 | 证据要点 |
| --- | --- | --- |
| S1 拾取最近掉落物 | 通过 | `succeeded`，背包 1；3 个投放剩 2 |
| S2 持续巡逻 | 通过 | `A,B,C,A,B,C` 六次有序到达；stop 后 `cancelled` |
| S3 有限采集 | 通过 | `succeeded`，`dirt=4`（初始 2） |
| S4 途中拾取再继续 | 通过 | 生成→拾取→到达 B→到达 C，最后 `cancelled` |

### 2.2 反例

| 用例 | 结果 |
| --- | --- |
| S1x 选中后目标消失 | `failed / TARGET_GONE`，背包 0 |
| S2x 路径被屏障阻断 | `failed / MOVE_TO_BLOCKED`，不跳点 |
| S3x 资源不足 | `failed / INSUFFICIENT_RESOURCE`，背包 3 |
| S4x 打断后目标消失 | 恢复巡逻，继续到 B、C，仍 running |

### 2.3 策略变体

| 变体 | 结果 |
| --- | --- |
| V1 最远优先 | 通过（终态 succeeded，距最远目标 0.07 格） |
| V2 往返巡逻 | 通过（`A,B,C,B,A` 后 stop → cancelled） |
| V3 达标后返程 | 通过（succeeded，背包 4，距 home 0.65 格） |
| V4 目标失效即失败 | 通过（确定性注入）：带超长 `PickupDelay` 的苹果不可拾取，拾取分支走完后库存验证失败 → `failed / TARGET_GONE` |

## 3. 指标观察

| 指标 | 观察 | 结论 |
| --- | --- | --- |
| 核心稳定 | 冻结后核心语义修改 0；只改场景/脚本 | 通过 |
| 策略归属 | act 全是单 op 包装；policy 只做选择/计数/距离；无巨型 act/policy | 通过 |
| 取消责任 | behavior/policy 无停止标志；S2/S4 的取消由平台完成 | 通过 |
| 状态负担 | `leg`、`dir`、`attempt`、`pick`、`verdict` 都有业务含义；无 programCounter | 通过 |
| 改动局部性 | V1/V2 只换 policy 指向但**仍需新 behavior artifact**（确切引用）；V3 只改计划与完成条件 | 部分（见 §4.1） |
| 可读性 4/4 | 独立 agent 复核：扩展 status 前 2/4（分支与目标不可区分）；加入 `activeNode`/`activeTarget` 后 **4/4** | 通过（非人类复核，见 §4.7） |
| 诊断成本 | status 能给出 activeAct/waiting/lastFailure；定位到具体节点仍需日志 | 部分 |

## 4. 发现与风险

### 4.1 精确引用带来的替换成本

`act`/`policy` 引用是确切 artifact，因此「只换 policy」在源码层面仍要新建一个 behavior artifact 指向新 policy。计划与 act 不变，但文件与检查次数增加。是否可接受，G3 需要回答：这是预期的版本化成本，还是可读性/编写成本的负担。

### 4.2 完成条件同时承担「循环出口」与「阶段切换」

V3 需要「配额达标后返程」，当前只能把返程写成循环内的幂等尾动作，靠完成条件在下一次 act 启动前拦截。它成立，但结构不直观；如果多数多阶段任务都这样写，说明小内核缺少「阶段推进/break」的表达，属于 G3 的核心增长信号。

### 4.3 隔离仍是基线

runner 使用 `node:vm`，没有做 S1—S7 的实测；`ISOLATION.md` 的证据表仍为空。G2 的 act/policy 都是本会话编写，不涉及 `imported`。真实对抗性逃逸未验证，不能宣称完整隔离。

### 4.4 共享 runner 的故障耦合

policy/act 共用 runner；G2 没有触发「policy 超时导致活动 act 中断」。契约已写明该语义，但没有实测。

### 4.5 真实游戏扰动覆盖不足

policy 等待中取消、取消与成功同批、unknown/过期、活动分支 policy 失败、清理失败：软件层已有单测，真实游戏未逐项注入。

### 4.6 V4 改为确定性注入

最初依赖「拾取前移除目标」的时序，三次尝试不稳定。最终改为投放一个 PickupDelay 极长的物品：目标存在但不可拾取，拾取分支的库存验证必然失败并触发 TARGET_GONE。它与「目标被移除」不是同一事件，但验证的是同一条声明失败路径，且可复现。

### 4.7 可读性复核（独立 agent，非人类）

- 第一轮：只给 activeAct/waiting，同一 move-to 同时用于 pickup 与 patrol，**2/4**（Q1 分支不可分、Q2 目标不可得）。
- 第二轮：status 增加 activeNode 与 activeTarget 后 **4/4**（Q1/Q2/Q3/Q4 全部精确）。
- 复核同时指出三处文档漂移：length 未列入 v1、query 条件的 result 绑定未定义、源码引用缺 artifactId 的解析规则未写清。三者已在 IR.md / CONTRACTS.md 修正。
- 残余细节：act 环境失败码未枚举、 timeoutMs=20000 与 30s 总上限的覆盖/叠加关系未定义、实体 uuid 不可得、快照无 act 已耗时。

## 5. 与 G3 判定相关的倾向

- **支持小 IR**：四个主场景、三个反例、三个变体在冻结内核上完成；没有任何场景要求修改执行器或新增节点/表达式（`length` 已在冻结前加入）。
- **保留意见**：V3 的多阶段写法暴露了完成条件承担的职责过重；公共扰动的真实游戏覆盖未完成。
- **不建议现在扩大 IR**：没有证据表明需要 `forEach`/`call`/集合算子；V1/V2 的替换成本来自确切引用，不是表达能力。

## 6. G3 前建议补齐

1. ~~V4 改为确定性注入并重跑~~（已完成）。
2. ~~可读性 4/4~~（已完成，独立 agent 复核；仍建议未来由人类复核一次）。
3. 真实游戏公共扰动至少各一次：policy 等待中取消、活动分支 policy 失败、清理失败。
4. 记录一次「多阶段任务」的编写成本（V3 已提供样本，可再取一个）。
5. 明确「精确引用导致换 policy 需新 behavior」是否算 G3 的核心增长信号，并在 G3 记录中给出判定。

## 7. 证据索引

- [M5-G2-EVIDENCE.md](M5-G2-EVIDENCE.md)
- `.m5-runs/s1-*.json`、`s2-*.json`、`s3-*.json`、`s4-*.json`
- `.m5-runs/s1x-*.json`、`s2x-*.json`、`s3x-*.json`、`s4x-*.json`
- `.m5-runs/s1v-*.json`、`s2v-*.json`、`s3v-*.json`
- 场景源码：`behaviors/m5-*.mjs`、`policies/*.mjs`、`acts/*.mjs`
- harness：`scripts/m5-g2.mjs`

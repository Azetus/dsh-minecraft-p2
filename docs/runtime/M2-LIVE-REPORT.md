# M2 实机测试报告（建造）

> 测试日期：2026-10-31（Asia/Hong_Kong）
> 代码：分支 `P2MindTree`，M2 阶段
> 验收目标（TODO M2）：工作项四态与一个冲突格不堵其他工作项；前置工作转派；
> 固定点建 3×3×2、打断后从世界恢复、单格失败不阻塞；sealed-room 三态验证。

## 1. 交付

| 任务 | 内容 |
| --- | --- |
| M2-01 Plan/WorkItem | 模板 Schema（id/version/size/materialPolicy/workItems/verify）；固定点实例化；`clear/prepare/place/enter/hold` 四态求值；`name + state 子集` 匹配；依赖 DAG 与循环检测 |
| M2-02 plan giver | 遍历全部工作项返回首个 executable；被 tracker 标记 blocked 的键跳过；只差距离时返回 `Handoff: move` 到工作项旁站位 |
| M2-03 建造 driver | `clear`（观察→挖→两次读回）、`place`（观察→选面→放置→两次读回，失败换面）、`prepare/enter`（走到工作项旁/内）；有界预算与停止 |
| M2-04 sealed-room verifier | 纯观测；内部必须空气、外壳必须实心；任何未加载格 → `insufficient`，缺口 → `refuted` |
| 运行时接入 | `shelter` order → 固定点 plan（`params.template`/`params.origin` 为开发测试钩子）→ plan giver → tracker → 工作项完成 → verifier → order 终态；取消 order 时中止当前 job |
| 演示计划/修复 | 清障+放置演示模板；转派站位改到工作项 2 格内；enter 完成判定允许步行误差；相应测试站位修正 |

`npm run check`：**207 passed / 1 skipped**。
新增测试：plan 8、plan giver 6、build drivers 8、plan loop 3、verifier 4、plan runtime 1。

## 2. 受控验收（3×3×2 固定点建造）

`test/mind-plan-loop.test.ts` 用真实 `Registry + plan giver + JobTracker + MindLoop`，驱动器替换为“一次成功并修改世界”的测试双：

- **建 3×3×2**：82 个 place 工作项（5×5 地板 + 2 层墙 + 5×5 屋顶）全部完成，`verifySealedRoom` = **confirmed**。
- **打断恢复**：3×3 挖掘计划完成 4/9 后重建 loop/tracker；新实例从世界看到已挖格为 satisfied，只挖剩余 5 格，总挖掘数仍为 9（无重复）。
- **单格失败不阻塞**：同一计划中一格持续失败，3 次后 tracker 标记 blocked，plan giver 跳过该键并完成另外两格。
- **四态/匹配**：`test/mind-plan.test.ts` 覆盖 satisfied/executable/blocked/unknown、`name+state` 子集、NO_MATERIAL/NO_SUPPORT/NO_STAND/UNREACHABLE/CONFLICT、以及一个冲突格不影响其他项。
- **验证器**：有意留缺口 → `refuted`；省略一格（未加载）→ `insufficient`；封好 → `confirmed`。

## 3. 实机：LAN 25575（固定白天）

### 3.1 3×3×2 挖掘房间（clear + enter）

- 通过 `p2_order {verb:"shelter", params:{template:"dig-room-3x3x2", origin:{x:-17,y:65,z:12}}}` 下达。
- 计划在 3×3 平坦草地（ground y=66）向下清出两层，18 个 clear 工作项逐个成功；随后 `enter`。
- **打断恢复**：测试期间 LAN 连接多次断开，body 自动重启了数次。最后一次重启后，新 body 从意图日志恢复该 order，从世界看到 18 格均已挖空，直接判定 order **succeeded** 并结束 plan——没有重复挖掘。
- 独立观察客户端复核：`x=-17..-15, y=65..66, z=12..14` 共 **18/18 格为 air**；`P2_Bot` 位于 `(-15.5,65,14.5)`，在房间内。
- 证据：`p2_events` 中 `plan.instantiated → 18×job.started/terminal(clear) → order.terminal(succeeded) → plan.terminal(succeeded)`；`.m5-runs/` 未另存日志（本机 session 可见）。

### 3.2 清障 + 放置演示（受限）

- 计划 `demo-clear-place`：先挖脚下草方块，再在其旁放置泥土。
- 实测：clear 成功（草方块 → air），随后 place 报 **NO_MATERIAL**，`plan.blocked` 事件按设计上报。原因是掉落的泥土距离当时 bot > 拾取半径，M2 没有 gather/补料（M3 才有）。
- 结论：**M2 的 place driver 由受控测试覆盖（含换面重试、两次读回、READBACK_UNSTABLE）；实机放置演示要等 M3 材料政策/采集**。

## 4. 已知限制

- **没有选址**：M2 用调用方给定的固定 origin（开发测试钩子）；`params.origin/template` 不属于面向操作员的正式词表，M3 planner 会取代。
- **没有材料补给**：`shelter-minimal`（82 块泥土）在生存下会 `NO_MATERIAL`；M3 的 materialPolicy + gather giver 负责。
- **enter 判定**：允许 1.5 格水平/1 格垂直误差（walk 的正常落点），否则 `goto(range=1)` 永远无法满足 exact-cell 判定；sealed-room 的严格性由 verifier 保证。
- **实机只是简化场景**：它证明了 clear/enter、plan 恢复和 order 终态；3×3×2 的**放置**与 sealed-room 通过受控测试验证，需等 M3 材料后再做完整实机 shelter。

## 5. 复现

```powershell
# body 运行后（/p2 start 或 p2_body start）
p2_order {verb:"shelter", params:{template:"dig-room-3x3x2", origin:{x:-17,y:65,z:12}}}
p2_status      # activeOrder / plan.satisfied
p2_events {sinceSeq:0}
# 结束后挖出 3x3x2 空间，order 应为 succeeded
```

# M1 实机测试报告（仲裁 / 基础维护）

> 测试日期：2026-10-31（Asia/Hong_Kong）
> 代码：分支 `P2MindTree`，M1 阶段
> 验收目标（TODO M1）：持续危险不重启同 job；新 order 1s 内生效；维护行为 60s 内至少一次；
> 无人值守 10 分钟：0 死亡、0 方块改变、游荡不出半径。

## 1. 交付

| 任务 | 内容 |
| --- | --- |
| M1-01 注册表 | predicate/giver/driver 稳定 id；JSON Schema 子集（type/properties/required/additionalProperties/enum/items/min/max）；未知 id 与越界 Schema 均 `DEFINITION_ERROR` |
| M1-02 树求值器 | 6 种节点；三态谓词（unknown 不进 else）；单快照；结果四类；子树存在/无环/深度≤8/节点≤500 加载校验 |
| M1-03 JobTracker | 续做（keys 相同只续期）、切换（seq++ / 结束旧令牌 / 等 stopped）、停止超时 fault、迟到 runId 围栏、失败键 3 次 blocked；move driver |
| M1-04 OrderStore | 单活动 order + 队列；JSONL 意图日志（accept/terminal + fsync）；尾部半行丢弃；取消不复活 |
| M1-05 基础 giver | escape（岩浆/深水/敌对 6 格）、goHome（>16 格回家）、wander（home 半径 8 内可站立点）；sensors 10Hz 快照；50ms mind loop 接入 body |
| 巡检工具 | `p2_status / p2_order / p2_orders / p2_cancel / p2_report / p2_events`；agent-scoped，只读或改 order，不直接操作世界 |
| 观察器 | `scripts/mind-observer.mjs`，独立玩家观察 P2_Bot 的位置/半径/方块/掉线 |

`npm run check`：**177 passed / 1 skipped**（跳过的只有默认关闭的 `port-live` 套件）。
新增测试：registry 6、tree 11、tracker 11、move driver 5、orders 10、givers 9、loop 5、integration 3、operator tools 5。

## 2. 实机：LAN 世界（25575，白天固定）

- 世界：`dsh-P2Mind-dev`（已被 M0 实机测试挖/放过几格）；`Human_Player` 旁观；`P2_Bot` 由插件工具 `p2_body start` 启动（epoch `8f91ad64…`），`P2_Observer` 观察 600s。
- 结果（`.m5-runs/m1-lan-observer.json`）：

| 指标 | 值 |
|---|---|
| 掉线/死亡采样 | 0 |
| 死亡日志 | 无 |
| 最大水平半径 | 5.81 格（home = (-9,68,8)） |
| 总移动距离 | 143.35 格 |
| 最长无移动间隔 | 35.07s（< 60s） |
| 方块变化 | 3 处，全部 `dirt → grass_block` |

- 3 处变化坐标 `(1,71,2)`、`(6,71,-1)`、`(7,72,-1)`：都是 M0 实机测试放置的泥土被草方块自然蔓延覆盖。
  M1 mind 只注册了 `move` driver，没有任何挖/放路径；因此 **bot 造成的方块改变 = 0**。
  该世界已复用多轮，正是“每轮 dev 验证应新建世界”的原因；干净世界复测见下。

## 3. 实机：全新 devworld（25566）

- 新建 `devworld` 后启动 dev 服务器，`P2_Bot` 由 `p2_body start` 启动，`node scripts/mind-observer.mjs 25566 600`。
- 结果（`.m5-runs/m1-dev-observer.json`）：**ok = true**

| 指标 | 值 |
|---|---|
| 掉线/死亡采样 | 0 |
| 最大水平半径 | 9.19 格 |
| 总移动距离 | 150.10 格 |
| 最长无移动间隔 | 35.04s |
| 自然变化 / bot 方块改变 | 0 / 0 |
| 未加载基线格 | 0 |

## 4. order 工具（1s 内生效）

在 LAN 的 body 上通过 DSH 工具执行：

1. `p2_order {verb:"wander",params:{radius:6}}` → `{"id":"ord-mvvylba9-1","state":"active"}`。
2. 紧接着 `p2_status` → `activeOrder = {id:"ord-mvvylba9-1",verb:"wander"}`；`p2_orders` 同样显示 active。
3. `p2_order {verb:"hold"}` → `state:"queued"`；`p2_cancel {ord-mvvylba9-1}` → `cancelled`，随后 active 变为 `ord-mvvyldeb-2`。
4. `p2_events {sinceSeq:0}` 返回 `order.accepted` / `order.terminal` / `job.started` / `job.terminal` 全序列。
5. `p2_report` 返回最近一次 `job.terminal` digest（本次为 `GOTO_NO_PATH`）。

order 的 enqueue → active 是 body 内同步完成的；下一工具调用即可见，满足“1s 内生效”。

## 5. 观察与已知限制

- **wander 目标可达性**：约 1/3 的 wander 目标返回 `GOTO_NO_PATH`（目标本身可站立，但路径被地形挡住）；同一目标键失败 3 次后进入 blocked，后续换点。不影响 M1 验收（仍有 60s 内维护行为），但 M3 分片选址/可达性检查应吸收这一点。
- **escape 没有实机触发**：白天固定、无敌对，测试期间没有岩浆/深水/敌对事件；escape 的三种分支只有受控输入测试覆盖。
- **order 还不产生工作**：M1 只有 OrderStore，没有 plan/giver；`shelter` 等 order 只会排队，等 M2。
- **意图日志**：`<cwd>/.p2/journal.jsonl`（gitignored）；body 重启会恢复未终结 order，取消的 order 保持取消。
- **停止语义**：JobTracker 切换时先结束旧写令牌再等 stopped；provider 的 `goto` 停止已在 M0 修复为 `stop + setGoal(null)`，实测 release 0ms。

## 6. 复现

```powershell
# 干净 devworld
cd E:\p2-dev\server
pwsh -File run.ps1
# 在 DSH 里
p2_body start
p2_status
node scripts/mind-observer.mjs 25566 600   # 需在仓库根执行
p2_body stop
```

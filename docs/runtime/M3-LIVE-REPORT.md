# M3-03 实机测试报告（place 尝试 / conflict / material）

> 测试日期：2026-10-31（Asia/Hong_Kong）
> 代码：`P2MindTree`；插件 tarball SHA-256 `B8F92CF2…2DA0578`
> 环境：LAN 25575，`P2Mind` body 由 `p2_body start` 启动（epoch `aee6868f…`）

## 1. 验证内容

### 1.1 require-all 缺料 → blocked

```json
p2_order {
  "verb": "build",
  "blueprint": {"blocks":[{"x":-21,"y":66,"z":18,"name":"diamond_block"}]}
}
```

结果：

```
plan.material-short required={diamond_block:1} needed={diamond_block:1}
missing={diamond_block:1} unsupported=["diamond_block"]
order.terminal state=blocked
```

没有发出 place job，目标格未被修改。默认 `require-all` 生效。

### 1.2 conflict clear：火把 → 泥土

目标格 `(-21,67,21)` 原有 `torch`。

```json
p2_order {
  "verb": "build",
  "blueprint": {"blocks":[{"x":-21,"y":67,"z":21,"name":"dirt"}]},
  "policy": {"conflict":{"mode":"clear"}}
}
```

事件序列：

```
plan.instantiated
clear handoff:clear:-21,67,21      succeeded
move  handoff:move:-22,67,21       succeeded
place b:-21,67,21                  succeeded
order.terminal succeeded
plan.terminal succeeded
```

观察复核：`(-21,67,21)` = `dirt`；下方 `(-21,66,21)` 仍是 `grass_block`；
被拆的火把进入背包（`torch × 1`）。

### 1.3 auto-gather 无来源 → blocked

目标 `oak_door`，`policy.materials.mode=auto-gather`：

```
plan.material-short missing={oak_door:1} unsupported=["oak_door"]
order.terminal blocked
```

没有 gather/place job。

## 2. 实机发现并修复的问题

第一次 conflict clear 选择了**地面格** `(-22,65,18)`：clear 成功后，plan 的“接近”Handoff
把 bot 站进了刚清出的目标格；随后 place 连续报 `PLACE_BLOCKED_BY_SELF`。

修复内容：

- `nearestStandable` 支持排除目标格；
- plan giver 的 unreachable/step-aside Handoff 不再站进 place 目标；
- 若 bot 已经在目标格/头位，先返回 `step aside` Handoff。

修复后用地面之上的火把目标重测，clear → place 成功。

## 3. 未覆盖

- **auto-gather 成功补料**只做了单测（草→泥土、预算、无源门 blocked）；实机未做，
  因为当前背包已有 29 泥土，构造大额缺料会触发多轮挖掘/拾取，超出本轮范围。
- place 入水、火把入水后被摧毁、沙子下落等“接受但失去”的场景仍是单测/设计覆盖；
  实机没有水边测试点。
- 火把/台阶/楼梯等朝向仍不可控（见 `docs/RUNTIME.md §10.1`）。

## 4. 结论

M3-03 的三条主路径在实机可观察：

- 缺料按 `require-all` 阻断，不先施工；
- `conflict clear` 能清障后放置，终态 verifier 通过；
- 无源材料按 `auto-gather` 策略 blocked。

`npm run check`：251 passed / 1 skipped。

## 5. M3-04 恢复实机（受控 pending）

- 插件构建包 SHA-256：`7DDABE90…BACC47682`。
- 做法：停止 body；向意图日志追加一条 `action.pending`
  （active order `ord-mvw4uxav-1`，place 目标 `b:-13,66,20`，世界中该格是 `gravel`
  而 expected 是 `dirt`）；重新启动 body。
- 结果：
  - `plan.instantiated` → `action.unreconciled`（带 basis：at/self/time）→ order `blocked`；
  - `action.settled` 写入 `state=unreconciled`；
  - 没有发出 place job，**没有重放** pending 动作；
  - 日志：`action.pending` 尾行 → 重启后 `action.settled(unreconciled)` + `order.terminal(blocked)`。
- 说明：这一轮先用受控 pending 注入验证恢复路径；随后在 §6 用 `crashAfterPending`
  做了真实 pending 窗口崩溃注入。

## 6. M3-04 真实崩溃注入

- 插件 tarball SHA-256：`DCCCEB63…1A02C5`。
- 在 `.p2/config.json` 临时设置 `crashAfterPending: true`，启动 body，下达单块 build order。
- body 在 `action.pending` 写入后由 `beforeStart` 钩子真实 `process.exit(1)`；DSH 检测到
  `process-exit`，自动重启到新 epoch `30835416…`。
- 重启后事件：

```text
plan.instantiated
action.unreconciled  actions=[run-2 place b:-25,67,18]  basis={...}
order.terminal       state=blocked
```

- 该 place 目标未被放置，**没有重放**；`action.settled(state=unreconciled)` 已落盘。
- journal 新增身份头：

```json
{"kind":"journal.identity","identity":{
  "worldId":"127.0.0.1:25575:overworld",
  "characterId":"5321c846-…",
  "defVersion":"747e3190…"
},"v":1}
```

- 测试后已移除 `crashAfterPending` 与 `crash-after-pending.done`，配置恢复干净。

## 7. auto-gather 正路径

- 背包 5 dirt，blueprint 6 块，`policy.materials.mode=auto-gather`。
- 实际事件：

```text
gather:dirt:-26,67,18  clear succeeded
gather:dirt:-26,66,18  clear succeeded
gather:dirt:-26,68,18  clear succeeded
6 × place              succeeded
order.terminal         succeeded
plan.terminal          succeeded
```

- 观察复核：6 个目标格全部为 dirt；背包剩余 1 dirt。auto-gather 成功从草地补料后完成建造。



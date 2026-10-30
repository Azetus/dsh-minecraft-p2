# artifact-strategy：P2Controller 策略编写规范

> 读者：编写/修改 `strategy` 产物的 subagent 或 owner。
> 契约：`docs/runtime/P2CONTROLLER.md` §14、`docs/CONTRACTS.md` §5.3。冲突时以代码与 CONTRACTS 为准。

## 1. 它是什么

`strategy` 是 P2Controller 的策略载体：**单文件、无 import、同步纯函数**。它只接收 JSON 事实并返回 JSON 判定；不能调用 op/act、不能持有句柄、不能 async、不能用定时器。**不要用 behavior 充当策略**（behavior 计划废弃，二者不兼容）。

```js
defineStrategy({
  manifest: {
    id: 'stone-harvest',          // definitionId = controller strategyKey
    version: '1',
    slot: 'S2',                   // S0 紧急 / S1 维持 / S2 承诺 / S3 待命
    facts: ['position', 'inventory', 'nearbyBlocks'],
    acts: ['goto', 'dig'],        // 只能提议这些 act
    description: 'mine N stone',
  },
  evaluate(ctx) {
    const facts = ctx.facts
    if (facts.unknown.length > 0) return { kind: 'unknown', missing: facts.unknown }
    if (!ctx.commitment) return { kind: 'idle' }
    // ...纯计算...
    return { kind: 'idle' }
  },
})
```

## 2. 可用输入

`ctx` 是 JSON 快照（每 tick 一份）：

| 字段 | 内容 |
| --- | --- |
| `now` / `slot` / `phase` / `attemptId` | 时间、槽位、`normal/verifying/recovering`、本次尝试 id |
| `facts.values` | 已知事实的键值 |
| `facts.facts` | `{ key, value, known, sampledAt, validUntil, scope, evidenceId }` |
| `facts.known` / `unknown` / `reasons` | 可用/不可用键与原因（`missing`/`expired`/`invalidated`/`stale-before-recovery`/`incoherent`） |
| `facts.coherent` / `coherenceGapMs` | 多事实是否落在同一一致性窗口 |
| `memory` | `{ hazards, failures, escapePhase, escapeSince?, escapeReason?, retries }`，只读快照 |
| `commitment` | `{ id, goal, state, post, baseline, checkpoint, suspendedAt?, suspendReason? }` |
| `activeAction` / `lastOutcome` | 当前动作与最近一次结束（含 attemptId/status/error） |

body 默认事实源：`position`（x/y/z/dimension/inWater）、`health`（health/food/oxygen）、`inventory`、`nearbyBlocks`（常见生存资源，半径 16/24 个，`exposed`）、`entities`（24 格内按距离）。

**永远不要**把 `unknown` 当成 false 或 0：显式返回 `{kind:'unknown', missing:[...]}`。

## 3. 可用输出

| 判定 | 含义 |
| --- | --- |
| `{kind:'idle'}` | 不适用/无事可做 |
| `{kind:'unknown', missing}` | 缺观测，不能猜 |
| `{kind:'propose', intent, act, args?}` | 提出下一步动作；`act` 必须已声明，host 会解析成确切 act artifact |
| `{kind:'running', intent, progress?}` | 当前动作仍在推进（通常用 `activeAction.intent` 判断） |
| `{kind:'wait', until, deadlineMs}` | 有期限的等待（不是 ping-pong） |
| `{kind:'recover', reason, leasePriority:'interrupt'\|'boundary', action?}` | 本任务局部恢复；interrupt 会撤销租约 |
| `{kind:'candidate-complete', evidence:['inventory']}` | 候选完成；`evidence` 是事实键，host 重新核验后才会成功 |
| `{kind:'blocked', missing, diagnostics:[{code,message,detail?}]}` | 解释为什么不能继续 |

任意判定可附加 `checkpoint`（JSON，≤16KiB）：host 写入当前承诺，跨 tick/跨动作保留。跨策略版本**默认不迁移**，不要依赖它做跨版本状态。

## 4. 完成判定

- 策略只能给候选，不能降低验收标准；post 由承诺定义（`count-at-least` / `fact-equals` / `standing`）。
- `count-at-least` 用 `fromBaseline:true` 时，承诺开始时的已有物品不算“新造”；baseline 缺失会 fail closed（等待到期后 blocked）。
- 候选完成后 host 要求**槽位空闲 + 证据新鲜**：不要在动作未结束时反复返回 candidate-complete 刷屏；一个 tick 一个判定即可。
- `standing` 承诺没有自然成功终态：不要返回 candidate-complete。

## 5. 工作流

1. 写文件（例如 `behaviors/` 同级或 `strategies/` 目录，必须在 owner 工程内）。
2. 依赖的 act 先 `p2_check` + `p2_activate`；策略检查时只接受**已启用**的 act。
3. `p2_check {sourcePath, artifactKind:'strategy'}` → 拿到 `artifactId`。
4. `p2_activate {artifactId}`。
5. `p2_controller action=enable`（要求无 active run、无 guard）。
6. `p2_controller action=install {artifactId, mode:'boundary'|'interrupt'}`。
7. `p2_controller action=commit {goal, strategyKey:<manifest.id>, post, baselineKeys, deadlineMs?}`。
8. `p2_controller action=status` / `p2_events` 观察；失败先看 `commitment.blocked`、`strategies`、`degraded`。

## 6. 自检清单（提交前逐条）

- [ ] 顶层只有 `defineStrategy`，没有 import/require/eval/Function/process/fetch/async/await/定时器。
- [ ] `manifest.facts` 全部是 body 已注册事实；`manifest.acts` 全部已检查并启用。
- [ ] S0 策略声明了 `hazardClass`；非 S0 不声明。
- [ ] `unknown` 分支显式列出缺失键；没有把未知当 0/false。
- [ ] 所有 `act` 都在 `manifest.acts` 内，`args` 是扁平 JSON。
- [ ] 完成候选使用 `evidence` 事实键，且该事实在 `manifest.facts` 中。
- [ ] 没有在动作进行中重复 propose 不同动作（同槽不中途换动作）。
- [ ] 对于会失败的动作，检查 `ctx.memory.failuresFor(...)` 或 `ctx.lastOutcome`，不要无限重试。

## 7. 常见陷阱

| 症状 | 原因/处理 |
| --- | --- |
| 策略一直 `unknown` | 事实未注册、已过期、或不同事实超出 coherenceWindow；看 `ctx.facts.reasons` |
| `ACT_UNDECLARED` | `act` 没写进 `manifest.acts` |
| `ACT_NOT_RESOLVED` | 声明了但检查时 act 未启用；先检查+启用 act 再 check 策略 |
| `EVIDENCE_UNDECLARED` | 完成证据用了未声明事实键 |
| `blocked: invalid verdict` | 返回了非 JSON 或未知 kind；检查是否返回了函数/Promise |
| 承诺永远不成功 | post 的 factKey/item/count 不匹配；baseline 缺失；请查 `commitment.blocked` |
| 紧急策略不触发 | S0 的 `facts` 缺 `position.inWater` / `health.oxygen`，或 `unknown` 被当成“无危险” |

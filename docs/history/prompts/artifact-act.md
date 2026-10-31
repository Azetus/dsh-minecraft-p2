# artifact 提示词 · act

> 交付给 subagent。目标：写/改一个 act —— 单个**离散动作**的语义封装。
> 契约见 `docs/BASELINE-OP-ACT-SMOKE.md` 与 `docs/CONTRACTS.md`；operation 契约见 `docs/runtime/OP-PROVIDER-CONTRACT.md`。

## 1. 什么该做成 act

- 一个动作、无策略：`goto`、`mine-one`、`place-block`、`equip-item`、`attack-target`、`furnace-load`。
- **不该**做成 act：寻路规划、合成决策、挖矿策略、战斗策略（这些属于 strategy 或上层 nav/crafting 模块）。
- act 必须**幂等**：重复调用不应造成二次破坏（例如重复 `place` 已占格应快速失败而非消耗物品）。

## 2. 必须的形态

```js
defineAct({
  manifest: {
    id: 'kebab-case-id',
    description: '一句话：做什么、成功条件是什么',
    queryOps: ['block'],                    // 用到的 query op（必须存在）
    controlOps: ['dig', 'stop'],            // 用到的 control op（必须存在）
    limits: { totalMs: 20000 },             // 必须有上限
    preconditions: [ /* 计划中：动作前否决条件 */ ],
  },
  create: function (args) {
    return {
      start(ctx) { /* 发起控制，返回 {kind:'running'} 或 {kind:'failed',error} */ },
      update(ctx, input) { /* 轮询句柄；返回 running/complete/failed */ },
      stop(ctx) { /* 请求停止；不要假定已释放 */ },
      cleanup() { /* 释放本地状态；幂等 */ },
    }
  },
})
```

- `stop()` 只表示"已请求停止"，**释放结论由控制面判定**；不要在 act 里宣称 released。
- 所有耗时路径受 `limits.totalMs` 约束；超时要返回明确错误码。
- 参数校验必须在 `start` 里完成，返回 `BAD_ARGS` 而不是抛异常。

## 3. 语义要求（这是 act 的价值所在）

1. **参数契约必须自洽**：错误信息描述的参数形状必须与实现一致。已知反例：`dig-stair-step` 实现读扁平 `{x,y,z}`，错误信息却写 `requires pos {x,y,z}` —— 新 act 不许重演。
2. **成功必须读回**：`mine` 要读回目标格是否变空气并报告掉落；`place` 要读回目标格方块；`equip` 要读回手持物。
3. **失败要具体**：`ITEM_NOT_FOUND`、`NO_SUPPORT`、`TARGET_OCCUPIED`、`OUT_OF_REACH`，不要统一 `FAILED`。
4. **不许静默降级**：手持物不对、物品不存在、工作台太远，都要明确失败（对应已知缺陷：`equip` 静默成功、`mine` 空手零掉落、`craft` 等 20s 才报错）。

## 4. 反例

| 反例 | 问题 |
| --- | --- |
| `start` 里发控制、`update` 里永不检查句柄 | run 永远 running，靠上限超时才结束 |
| `stop` 里直接返回 complete | 账本无法确认释放，可能触发 `STOP_UNCONFIRMED` |
| 成功判定用"控制返回 ok" | 底层 ok 只表示命令已受理 |
| 一个 act 里做三步组合（goto→挖→放） | 应拆成 strategy；否则中断粒度太粗 |

## 5. 自检清单

- [ ] `manifest` 四要素齐（id/description/queryOps+controlOps/limits）。
- [ ] 依赖的 op 名都真实存在（不然 `p2_check` 会拒绝）。
- [ ] 参数校验返回 `BAD_ARGS`，且错误信息与实现一致。
- [ ] 成功有读回；失败有具体码；无静默降级。
- [ ] `stop`/`cleanup` 幂等，不谎报释放。
- [ ] 无 import/async/定时器；耗时受 `limits.totalMs` 约束。

## 6. 交付格式

```
文件路径：
definitionId：
queryOps / controlOps：
成功判据（读回什么）：
失败码列表：
已知不确定点：
```


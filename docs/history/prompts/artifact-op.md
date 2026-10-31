# artifact 提示词 · operation（query / control op）

> 交付给 subagent。目标：补一个**语义缺口**，而不是把游戏逻辑塞进 op。
> 契约见 `docs/CONTRACTS.md` §5.2、`docs/runtime/OP-PROVIDER-CONTRACT.md`。

## 1. 什么时候才写 op

只有当"现有 query/act 组合不出这个语义"时才写。典型正确用途：

- 聚合观测（一次往返拿到位置/血量/背包/时间/敌对数）→ query op；
- 底层确实提供、但没有对应 act 的动作原语 → control op。

**不要**写：寻路、合成决策、战斗策略、任务编排——这些属于 nav/crafting/strategy。

## 2. 两类 op 的形态

```js
// query：纯读，不进控制账本，无副作用
defineOp({
  manifest: { schemaVersion: 1, kind: 'op', name: 'camp-status', opKind: 'query',
              parameters: {}, result: {}, limits: { totalMs: 2500 } },
  query: (ctx) => ({ /* 只用 ctx.provider.query(...) + ctx.now() */ }),
})

// control：会持续产生效果，必须有句柄生命周期
defineOp({
  manifest: { schemaVersion: 1, kind: 'op', name: 'hold-jump', opKind: 'control',
              parameters: {}, effects: 'active', limits: { totalMs: 10000 } },
  start: (ctx, args) => (/* 必须把句柄交回 broker，才能被记账 */),
})
```

- `query` 必须返回 JSON 可序列化值；耗时受 `limits.totalMs` 约束；失败抛带 `code` 的 `P2Error`。
- `control` 交回的句柄才会被账本跟踪；**直接调用 provider 而不交回句柄 = 该 run 的释放结论是 unknown**（契约明确要求）。
- control op 的 `stop`/`cleanup` 必须幂等，并让调用方能够判断"是否已停"。

## 3. 可移植性（计划中，写 op 时必须预留）

- `implements: <InterfaceName>`：声明它实现契约的哪一组接口（如 `SenseOps`/`DigOps`）。
- `portability: 'portable' | 'native'`：
  - `portable`：只用语义查询名（position/health/inventory/block/blocks/entities/time），换 provider 后仍应可用；
  - `native`：允许使用该 provider 私有能力，**禁止被 kernel/strategy 引用**，只在迁移/诊断时使用。
- 参数与返回必须与接口的 type guard 一致，否则 `p2_check` 拒绝。

## 4. 反例

| 反例 | 问题 |
| --- | --- |
| query op 里顺手做了控制（如顺手清个方块） | query 必须是纯读；副作用会破坏账本与守卫 |
| control op 不交回句柄 | 释放结论不可信，可能出现 `STOP_UNCONFIRMED` |
| op 里实现"合成配方选择/寻路" | 属于上层，塞进 op 后无法被复用与验证 |
| 返回结构随意（数组/对象混用） | 上层无法稳定消费；必须与契约 result schema 一致 |
| 无 limits | 一个挂死的 op 会拖住整个 run |

## 5. 自检清单

- [ ] 这个语义确实无法用现有 query/act 组合出来。
- [ ] query 纯读、无副作用、有 `limits.totalMs`。
- [ ] control 交回句柄，`stop`/`cleanup` 幂等。
- [ ] 参数/返回与契约（或 type guard）一致；错误码来自契约。
- [ ] 已声明 `implements` 与 `portability`（计划中字段；若尚未支持，在交付说明里标注）。
- [ ] 没有把寻路/合成/策略写进 op。

## 6. 交付格式

```
文件路径：
op name / opKind：
implements / portability：
参数与返回：
失败码：
是否需要 owner 在 p2_check 前激活其它依赖：
已知不确定点：
```


# artifact 提示词 · behavior

> 交付给 subagent。目标：写/改一个 behavior，通过 `p2_check`，并由 owner 激活。
> 契约见 `docs/BEHAVIOR.md`、`docs/BEHAVIOR-LIFECYCLE.md`；运行时规则见 `prompts/runtime-agent.md`。

## 1. 先做选择

- **continuous**：常驻策略，每 tick 观测→决策→执行一步（生存基线、巡逻、采矿循环）。不依赖 owner 在线。
- **finite**：一次明确任务（挖 N 格、建墙、取铁）。必须给出**可观测的完成判据**（postcondition）。
- 二选一写清；不要把 finite 任务写成 `while(true)`，也不要把 continuous 策略写成一次性脚本。

## 2. 必须遵守的形态

```js
defineBehavior({
  manifest: {
    id: 'kebab-case-id',
    description: '一句话，说明"什么时候用"',
    mode: 'finite',                       // 或 'continuous'
    parameters: {},                       // 参数要有类型与默认值
    dependencies: { acts: ['goto', 'mine-one'] },   // 声明全部依赖
  },
  *run(ctx) { /* 只用 ctx.*；一个 tick 一个动作 */ },
})
```

- 禁止 `import`/`require`/`async`/`await`/`setTimeout`/`fetch`/文件/网络。
- I/O 只能 `ctx.query` / `ctx.act` / `ctx.wait` / `ctx.progress` / `ctx.log` / `ctx.decide` / `ctx.fail` / `ctx.succeed`。
- 依赖里出现的每个 act 必须由 owner 先 `p2_check`+`p2_activate`，否则 `DEPENDENCY_NOT_FOUND`。

## 3. 决策与动作规则

1. **每个 tick 只做一步动作**，动作后 `ctx.wait(200–500)` 再重新观测；不要连续盲发。
2. **循环必须有退出条件**：次数上限、时间上限或状态收敛；禁止"直到成功"的死循环。
3. **不可达就跳过**：`goto`/`mine` 失败要记录并跳过该目标（维护 skip 表），不要反复重试同一坐标。
4. **观测是唯一事实源**：判断"挖到了/拿到了/建好了"必须重新查询，不能靠 act 的返回。
5. **失败要带码**：`ctx.fail(code, message)`，`code` 用大写短码（`NO_LOGS`/`NO_TABLE`/`LOW_IRON`），message 里给关键观测摘要。
6. **成功要有证据**：`ctx.succeed({...})` 里放可核对的计数与坐标，不要返回空对象。
7. **cleanup 责任**：会改变世界的任务（挖竖井、拆方块、放工作台）在失败/中止时应尽量恢复（填回、封口、收回），或在 evidence 里明确标注遗留物。

## 4. 反例（禁止重演）

| 反例 | 问题 |
| --- | --- |
| 造完工具直接 `succeed`，没查背包 | 产出可能为 0（`craft`/`equip` 都可能静默失败）→ 假成功 |
| 挖完立刻 `succeed` | 掉落物可能没拾取（`mine` 不会走近）→ 虚报物资 |
| `while(true)` 里 `goto` 同一坐标 | 卡死时无限重试，浪费整个白天 |
| 把 `hpBelow 8` 当唯一保护 | 滞后指标；溺水/苦力怕都在这个阈值之前就致命 |
| 在据点内竖直下挖 | 打穿地板与重生路径（owner 侧明确禁止） |
| 用 `ctx.wait(60000)` 代替状态机 | 期间无法被中断，run 与看门狗都可能误判 |

## 5. 自检清单（逐项确认后再交付）

- [ ] mode 与任务性质匹配，finite 有明确 postcondition。
- [ ] 所有依赖 act/query 都列在 `dependencies`，且名字与 `acts/*.mjs` 的 `definitionId` 一致。
- [ ] 每个循环都有上限；每种失败都有 `code`。
- [ ] 判定成功前有读回（inventory/blocks/entities/position）。
- [ ] 单 tick 动作粒度；等待用 `ctx.wait`，不阻塞其他中断。
- [ ] 没有引入文件/网络/定时器/async。
- [ ] 已知陷阱已规避：手持物先装备、掉落物要走过去拾取、`entities` 用 `name='item'`。

## 6. 交付格式

```
文件路径：
definitionId：
mode：
依赖（acts/queries）：
完成判据（postcondition）：
已知不确定点：
```

# strategies/: Controller 策略产物（示例/冒烟）

这些是 `artifactKind=strategy` 的单文件策略，用于实机冒烟与编写示例；不是产品内置策略（内置内容在 `src/controller/strategies/`）。

| 文件 | 槽 | 用途 |
| --- | --- | --- |
| `probe-dig.strategy.js` | S2 | 在脚下挖一块并走到掉落物，验证 baseline 增量与证据判定 |
| `probe-walk.strategy.js` | S2 | 按 `checkpoint.walk` 走到坐标，验证租约、路径停止与 cancel |

流程：

```text
p2_check {sourcePath, artifactKind:'strategy'} → p2_activate
→ p2_controller action=enable
→ action=install {artifactId}
→ action=commit {goal, strategyKey, post, baselineKeys, checkpoint?}
```

注意：

- 策略入参/返回值都是 JSON，没有 `ctx.propose()`/`ctx.saveCheckpoint()`；返回 `{kind:'propose', intent, act, args}`，checkpoint 作为返回字段。
- `lastOutcome` 只在当前承诺 + 当前 attempt 内有效；控制器在 commit/接管时清空。
- 实机测试时把行走目标限制在已知安全半径，或先安装 S0 策略。

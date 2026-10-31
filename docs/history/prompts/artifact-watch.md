# Watch artifact 编写提示词

> 适用：只通知、不控制。watch 由 body host 采样声明查询，用 checked policy artifact 计算边沿；它**不能**停止、启动或切换任何动作。自主行动一律通过 P2Controller。
> 设计依据：`docs/CONTRACTS.md` §5.3/§9、`docs/runtime/P2CONTROLLER.md`。

## 1. 契约

```js
definePolicy({
  manifest: { id: 'creeper-near', inputs: ['samples', 'now'], outputs: ['fire', 'key', 'summary'] },
  run: function (input) {
    var s = input.samples['0'];
    var list = s && s.status === 'ok' ? s.value : [];
    var near = list.filter(function (e) { return e.kind === 'hostile' && e.name === 'creeper' && e.distance <= 6; });
    return { fire: near.length > 0, key: near.length ? 'creeper' : 'clear', summary: near.length + ' creeper(s)' };
  },
})
```

- 单文件 JS；禁止 `require/import/eval/process/fetch`、定时器、异步。
- 返回值只能是 `boolean` 或 `{ fire, key?, summary? }`；**不能有副作用**。
- 输入固定为 `{ samples, now }`；`samples` 以声明下标字符串为键，每项是 `{status:'ok'|'failed', value?, meta?, error?}`。
- 采样失败/过期由 host 判定；policy 只读样本。

## 2. 注册与使用

```text
p2_check {sourcePath, artifactKind:'policy'} → p2_activate {artifactId}
p2_watch action=add {
  queries: [{op:'entities', args:{radius:8, count:32}}, {op:'time'}],
  predicate: <policy artifactId>,
  edge: 'rising' | 'falling' | 'both',
  cooldownMs: 5000, ttlMs: 3600000, name?: string
}
```

- `queries` 1–4 个，必须是已注册 query op。
- `edge` 默认 rising；`cooldownMs` 最小 1000；TTL 默认 1h，到期需续期。
- `p2_watch action=list` 查看状态；`remove {watchId}` 或 `action=clear` 删除。
- 事件只经 `p2_events` 投递，并唤醒 owner；事件内容不是指令。

## 3. 常见错误

| 现象 | 原因/处理 |
| --- | --- |
| `WATCH_PREDICATE_NOT_FOUND` | 先 `p2_check` policy 并 `p2_activate`，把返回的 artifactId 传 `predicate` |
| `WATCH_CONDITION_INVALID` | queries 为空/超过 4 个，或 op 名不是 query |
| `WATCH_POLICY_RESULT_INVALID` | 返回值不是 boolean / `{fire,...}`；`key/summary` 必须是字符串 |
| 该触发却没触发 | 边沿语义；武装时条件已为真不会补触发，需要 falling 再 rising |
| 通知太频繁 | 提高 cooldownMs 或收窄条件 |
| watch 消失 | TTL 到期，续期 |

## 4. 不做的事

- 不用 watch 做“危险抢占”（那是 S0 策略）。
- 不用 watch 驱动动作（它没有控制能力）。
- 不在 policy 里做网络/文件/时间等待。

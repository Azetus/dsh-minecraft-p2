# M3 G2 映射：P2 executor + Mineflayer act

> 2026-10-27。把 look/move/jump/stop 从原始 Mineflayer 探针映射到 P2 的 BehaviorExecutor/ActHandle。

## 实现

- `src/provider/mineflayer.ts`
  - `MineflayerProvider` 实现 QueryPort/ActPort：
    - query：position / inventory / entities / time / block
    - act：look / move / jump / stop
  - query 结果带 `source=query`、scope、sampledAt、validUntil。
  - act 结果带 `source=act`、scope。
  - jump 在离地后等待再次 onGround 才完成。
- `src/provider/index.ts` 导出 provider。
- `scripts/m3-g2-mapped.mjs` 通过 `BehaviorExecutor` 驱动同一套 act。
- `scripts/build.mjs` 生成 `lib/provider/minecraft.mjs` 和 provider manifest。

## 运行

```text
npm run build
node scripts/m3-g2-mapped.mjs 127.0.0.1 25575 P2_Bot
```

## 实测

```json
{
  "ok": true,
  "connectionEpoch": "bb219fa7-28e9-4593-986f-5a0b16c56423",
  "result": {
    "status": "succeeded",
    "ticks": 24,
    "controls": {
      "forward": false, "back": false, "left": false, "right": false,
      "jump": false, "sprint": false, "sneak": false
    },
    "settledPosition": { "x": -9.286344090827034, "y": -60, "z": -13.740649046001622 },
    "settledDelta": { "dx": -0.0229562518619435, "dy": 0, "dz": 0 }
  },
  "players": ["Human_Player", "P2_Bot"],
  "difficulty": "peaceful",
  "timeOfDay": 1000
}
```

轨迹关键点：

- look 后 yaw=π/2，移动方向变为 x 负方向。
- move 约 3 格。
- jump 峰值 y=-58.7478，落地 y=-60。
- stop 后所有 controls=false；500ms 结算位移约 0.023 格（x），y/z 为 0。
- executor 最终 `succeeded`，24 ticks。

## 结论

- G2 的 look/move/jump/stop 现在能通过 P2 `BehaviorExecutor → ActPort` 路径执行，不再只是裸 `bot.setControlState`。
- query/act 结果已带来源和新鲜度元数据（provider 层）。
- 这还不是 body 内的 provider 注入，也不是 ControlOp 的 commandId/operationId/effects 账本；下一步需要把 provider 接进 body，并完成 stop 的外部路径。

## 注意

- stop 后仍有约 0.02 格结算位移；G3 必须以 P2 stop 路径测“停止后有界/无后续控制”，不能只看控制位。
- 世界 peaceful，固定白天；没有挖掘、放置、攻击或物品使用。
- provider bundle 已生成，但 `verify:dist` 尚未把 provider 文件/摘要纳入包检查，下一轮补。

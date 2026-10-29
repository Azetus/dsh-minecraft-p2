# 实机测试清单（0.2.0 基础设施）

> 状态：**待执行**（2026-10-30 准备）。目标环境：Minecraft Java 1.21.1 LAN `127.0.0.1:25575`，body 用户名 `P2_Bot`。
> 本清单只验证 E/G/N/O 四块基础设施；**不把本清单当发布验收**，也不替代 `npm run check`。
> 当前安装 bundle：`0.2.0`（开发构建：`devBodyControl`/`devTrace`/`devAutoRestart` 已启用）。
> 安装结果要求 **重启 DSH** 后才加载新插件；未重启时仍是 0.1.1 实例，`p2_trace` 与自动重启不存在。

## 0. 前置与安全

| 项 | 要求 |
| --- | --- |
| 世界 | 已开启 LAN、允许作弊；建议先备份世界 |
| 角色 | `P2_Bot` 以独立玩家身份进入；不要用主玩家账号 |
| 其他玩家 | 测试期间避免他人处于危险区域；所有测试使用无害行为 |
| 配置 | `.p2/config.json`：`127.0.0.1:25575`、`1.21.1`、`serverIdleMs=1500`、`devOps=false` |
| fixture | 放在 `.m5-smoke/real-machine/`（已被 `.gitignore` 忽略），不提交 |
| 证据 | `.m5-runs/real-machine-<yyyyMMdd-HHmm>/`：status JSON、trace、事件、截图/日志摘要 |
| 顺序 | 基线 → E1/E2/E4 → G → N → O → E3 watchdog（破坏性，最后） |
| 失败处理 | 记录 `bodyEpoch`、`runId`、`artifactId`、status/events/trace 片段；先停行为再停止 body |

每个用例记录：时间、bundle 版本、`bodyEpoch`、`runId`、关键 `artifactId`、实际结果、结论（pass/fail/blocked）。

---

## 1. B 启动与基线

| ID | 步骤 | 期望 | 证据 |
| --- | --- | --- | --- |
| B1 | 重启 DSH → `/p2 start` → `p2_status` | `state=active`，`health=ready`，`connection=connected`，provider `mineflayer 0.2.0`，`bindingId` 非空 | status JSON |
| B2 | `p2_card` | 返回 run/health/position/hostiles/guards/watches；`hostiles` 为数字或 `null`；单次返回 | card JSON |
| B3 | `p2_snapshot` | `parts` 含 position/health/inventory/blocks/entities；`partial=false`；inventory 有 `summary.total/byName`；entities 有 `summary.hostile/nearestDistance` | snapshot JSON |
| B4 | `p2_observe`：`position`、`health`、`blocks {radius:8,count:8}`、`entities {hostileOnly:true,sort:'distance'}` | 每项 `{value,meta}`；meta 带 `sampledAt/validUntil`；entities 按距离升序且只含 hostile | 观测 JSON |
| B5 | `p2_trace`（空过滤） | 返回 `events/stats/dropped/capacity/seq`；有 run/act/op 事件 | trace JSON |
| B6 | `/p2 stop` → 等 10s → `p2_status` | `inactive`；无自动重启（手动 stop 不触发）；body 进程退出 | status/进程 |

---

## 2. E1 op 产物流水线（安全操作）

fixture（`.m5-smoke/real-machine/`）：

- `op-echo.mjs`：query op `rm-echo`，内部 `ctx.provider.query('position')`，返回 `{at: ctx.now(), position}`，`limits.totalMs=1000`。
- `op-look.mjs`：control op `rm-look`，`start: (ctx,args)=>ctx.provider.start('look', args)`，`effects:'active'`、`stop:'poll'`、`capabilities:['look']`。
- `op-ghost.mjs`：control op `rm-ghost`，`start` 里调用 `ctx.provider.start('look',{yaw:0,pitch:0})` 但**返回一个自造 handle**，用于制造未跟踪效果。
- `act-look.mjs`：act `rm-look-act`，`controlOps:['rm-look']`，start 提交 `rm-look`，轮询到完成。
- `behavior-op.mjs`：behavior `rm-op-test`，调用 `rm-echo`、`rm-look-act`（声明依赖），写 progress 后 `ctx.succeed`。

| ID | 步骤 | 期望 | 证据 |
| --- | --- | --- | --- |
| E1.1 | `p2_check {artifactKind:'op'}` `op-echo` → `p2_activate` → `p2_observe {op:'rm-echo'}` | check 返回 `kind:op`、`artifactId:p2:op:…`；activate 成功；observe 返回位置 | check/activate/observe |
| E1.2 | 检查并启用 `act-look`；启用 behavior `rm-op-test`；`p2_switch` | act 的 `ops.control` 含 `rm-look`；behavior 可启动；角色视角按参数改变 | artifact JSON、position yaw/pitch |
| E1.3 | 现场编写 `rm-echo` 同名 op（返回标记值）→ check → activate → `p2_observe rm-echo` | 激活后同名覆盖内置/旧的实现，返回标记；新 artifactId 不同 | 两次 artifactId |
| E1.4 | 启用 `op-ghost`；用 act/behavior 调用 `rm-ghost` 后停止 run → `p2_status` | `cleanupState=unconfirmed`（或 `switchState=unconfirmed`）；**不得出现 `released`**；再切 run 被阻止 | status、events |
| E1.5 | 修改 `op-echo` 源码 → 重新 check | `artifactId` 与 `sourceDigest` 变化；旧 run 不受影响 | 两次 check |
| E1.6 | 重启 body 后再 `p2_observe rm-echo` | 激活状态不跨 epoch；回退为内置/未激活 | status |

> 测试后恢复视角，避免影响后续移动。

---

## 3. E2 dev trace 与延迟

| ID | 步骤 | 期望 | 证据 |
| --- | --- | --- | --- |
| E2.1 | 执行 E1/E4 流程后 `p2_trace {kind:'op', op:'rm-echo'}` | 出现 start/end 或 error 事件；`stats.op.count>0`；`dropped` 数字 | trace JSON |
| E2.2 | 启用一个 20 步 behavior（query+wait）→ `p2_trace {kind:'behavior',runId}` | 每步有耗时；`stats.behavior.p50/p95` 可读 | trace JSON |
| E2.3 | `p2_trace {kind:'act'}`、`{kind:'run'}` | act 启动/停止、run start/end 成对；无行为影响 | trace JSON |

> ring 上限/丢弃计数已在 fake 测试覆盖；实机不强行制造 2048 条。

---

## 4. E4 async act 句柄

fixture：

- `act-hold.mjs`：act `rm-hold`，`start` 返回 running，`update` 持续 running，`stop` 返回 complete；无世界效果。
- `act-move.mjs`：act `rm-move`，`controlOps:['moveTo','stop']`；start 提交 `moveTo {x,z}`，update 轮询成功/失败，stop 发 `stop`。
- `behavior-act.mjs`：behavior `rm-act-test`：
  1. `await ctx.act('rm-move', target, {async:true})` → `{actId}`；
  2. `yield ctx.query('position')`；
  3. 尝试第二个 async act，捕获 `ACT_IN_FLIGHT`；
  4. `actWait`/`actStop`；
  5. `ctx.progress({actId, code, release})` → `ctx.succeed`。

| ID | 步骤 | 期望 | 证据 |
| --- | --- | --- | --- |
| E4.1 | 启动 `rm-act-test`，目标约 5 格 | 返回 `{actId}`；期间 query/decide 可用；run 不阻塞模型 | status activeActHandle |
| E4.2 | 在第一个句柄在飞时启动第二个控制 act | 抛 `ACT_IN_FLIGHT`；不排队、不产生第二个控制者 | progress/error |
| E4.3 | `actStop` 提前中断移动 | 两阶段停止；返回 `release:'released'`；角色停下；`actWait` 取终态 | progress、position |
| E4.4 | behavior 在句柄未完成时 `ctx.succeed` | run 先停止并确认句柄释放，才成功；status `cleanupState=released` | status/events |
| E4.5 | 查询不存在的 actId | `ACT_NOT_FOUND` | progress |
| E4.6 | 组合 E1.4 的未跟踪 op + `actStop` | 释放未确认时不启动新 act（`STOP_UNCONFIRMED`），run 不得成功 | status |

---

## 5. G guard v2

fixture：

- `behavior-standby.mjs`：continuous，循环 `yield ctx.wait(1000)`，作为安全 target。
- `behavior-retreat.mjs`：continuous，循环 `yield ctx.progress({phase:'retreat'})` + wait。
- `policy-night.mjs`：`{ kind:'policy', queries:[{op:'time'}], predicate }` 用 policy 读 `samples['0'].value.timeOfDay`，夜晚返回 `{fire:true,evidence:{timeOfDay}}`。
- `policy-rain.mjs`：读 `weather.raining`。

前置：`p2_check` 两个 policy（**policy 不 activate**）；`p2_check`+`p2_activate` 两个 behavior。

| ID | 步骤 | 期望 | 证据 |
| --- | --- | --- | --- |
| G1 | `p2_guard set`：policy `night`，target `standby`，ttl 120000 | `state=active`；`guards` 数组含 id/priority/target 快照 | guard status |
| G2 | 执行 `/time set night` → 等 ≤1s → `p2_status` | guard `fired`；`lastSwitch.phase=started`；target run 启动；`p2_events` 有 fired/started | status/events |
| G3 | 两个 guard：night priority 10、rain priority 5，同时触发（`/time set night` + `/weather rain`） | 只启动一个切换；另一个 `deferred` 事件且仍 `active/deferred`；切换完成后重新求值并触发 | events 顺序、guards |
| G4 | 同一 guard 持续满足 | 只触发一次（授权消费）；不重复切换 | events 无第二次 fired |
| G5 | TTL 设 10s，在切换后等待过期 | guard `expired`；已启动 target 不被取消 | status |
| G6 | `p2_guard clear {guardId}` / 不传 id（all） | 单个/全部移除；当前 behavior 不受影响；`p2_events` 有 cleared | status/events |
| G7 | 空闲（无 run）时 set + 触发 | 可从 idle 启动 target | status |
| G8 | 无权限/不可用 target | 预检失败 `precheck-failed`，不停止当前 run | events |
| G9 | `p2_guard status` | 返回 guards 数组与 lastSwitch；`p2_events` 游标无重复/丢失 | status/events |
| G10 | 触发后等下一轮模型 | owner 收到 `[p2 guard] … fired` followup（同一事件一次） | 会话消息 |

> 健康语法糖可用 `/damage P2_Bot 2` 或 `/effect give P2_Bot instant_damage 1 0` 触发；测试后补血/回满。

---

## 6. N watch 通知

fixture：

- `policy-rain-watch.mjs`：返回 `{fire: weather.raining, key: String(raining), summary:'rain changed'}`。
- `policy-time-watch.mjs`：按 `timeOfDay` 返回 `{fire: night, key: String(timeOfDay)}`。

| ID | 步骤 | 期望 | 证据 |
| --- | --- | --- | --- |
| N1 | `p2_watch add`：queries `weather`，predicate rain-watch，edge rising，cooldown 5000，ttl 300000 | watch `active`；有 id/edge/cooldown | watch status |
| N2 | `/weather rain` → 等 ≥1s → `p2_status`/`p2_watch list` | 恰好 1 条 watch 事件；`lastFire` 更新；owner 收到 `[p2 watch]` 一次 | events/消息 |
| N3 | 保持下雨，再等 2s | 不重复通知（持续 true 非边沿） | events 计数 |
| N4 | `/weather clear` 再 `/weather rain`，间隔 < cooldown | 冷却中：`suppressed` +1，无新事件 | watch status |
| N5 | 等过 cooldown 再 `/weather clear`→`rain` | 新事件；`key` 变化按新事件处理 | events |
| N6 | TTL 设 10s，等待过期 | watch `expired`；不再通知；事件不重放 | status |
| N7 | `p2_watch remove {id}` / `clear` | 移除单个/全部；无控制入口（工具无 stop/switch） | status/工具参数 |
| N8 | `p2_events` | 含 `kind:'watch'`，seq 单调；重复轮询不重复入队；超界报告 gap | events JSON |
| N9 | 查询失败（如停服瞬间） | 不通知；连续 3 次失败 → watch `error`（可选，需短暂停服/断连，风险较高） | status |

---

## 7. O 观测层

| ID | 步骤 | 期望 | 证据 |
| --- | --- | --- | --- |
| O1 | `p2_snapshot`；另做一次 `p2_trace {kind:'op'}` | 一次 snapshot 只产生 5 个 op span（position/health/inventory/blocks/entities），**单次往返** | trace 计数 |
| O2 | `p2_card`；对照 `p2_status` | card 中 run/health/position/guards/watches 计数与 status 一致；`hostiles` 数字或 `null` | card/status |
| O3 | `p2_observe entities {hostileOnly:true,sort:'name',descending:true}` | 只返回 hostile，按 name 降序；每项含 `kind` | observe JSON |
| O4 | `p2_observe inventory` 与 snapshot 的 inventory summary | `summary.total/byName` 与原始 items 求和一致；provider 未改语义 | 两份 JSON |
| O5 | 触发一个不可用查询（如 `recipe` 在无 craft 能力时） | 单项返回 capability 失败；`p2_snapshot` 的其它 part 不受影响（partial 语义在 fake 覆盖，实机只核对单项错误） | observe error |

---

## 8. E3 超时与看门狗（破坏性，最后执行）

fixture：

- `op-slow.mjs`：query op `rm-slow`，`query: () => new Promise(() => {})`，`limits.totalMs=500`。
- `op-hang.mjs`：query op `rm-hang`，`query: () => { while (true) {} }`（同步挂死）。
- `behavior-slow.mjs`：behavior `rm-slow-test`：`try { yield ctx.query('rm-slow') } catch(e) { progress({code:e.code}) }`，随后 succeed。
- `behavior-hang.mjs`：behavior `rm-hang-test`：`yield ctx.query('rm-hang')`（启动即挂死 body）。

| ID | 步骤 | 期望 | 证据 |
| --- | --- | --- | --- |
| E3.1 | 检查/启用 `op-slow` 与 `behavior-slow`；启动 | `progress.code='OP_TIMEOUT'`；body 仍响应心跳/status；**不触发重启** | status/progress |
| E3.2 | 记录当前 `bodyEpoch` → 启动 `behavior-hang`（或 `p2_observe rm-hang`） | body 无响应约 3 个心跳周期（≈6s）→ `faulted`；强杀进程树；新 epoch 重启；旧 run `faulted`、控制 `unknown`；owner 收到 `[p2 runtime] faulted/restarted` | 旧/新 epoch、events、消息 |
| E3.3 | 重复 E3.2 观察窗口内预算 | 60s 窗口最多 3 次；耗尽后保持 `faulted`，需人工 `/p2 start` | status |
| E3.4 | `/p2 start` 后正常 `/p2 stop`，等 10s | 不自动重启；状态 `inactive` | status |
| E3.5 | 观察 `p2_events` | 含 fault/restart 事件；新 epoch 事件从空开始，不重放旧事件 | events |

> E3.2 会杀死 body，必须放在最后；重启后 body 从空运行开始，之前的 artifacts 需要重新 check/activate。
> 若测试 E3.3 预算耗尽，恢复方式：`/p2 start` 人工启动。

---

## 9. 收尾与判定

1. `p2_watch clear` → `p2_guard clear` → `p2_stop`（停行为）→ `/p2 stop`。
2. 归档 `.m5-runs/real-machine-<time>/`：status、trace、events、fixture 版本、结论表。
3. 每条用例标 `pass / fail / blocked`；fail 附最小复现与日志片段，不在实机窗口内改代码。
4. 所有 fixture 保留在 `.m5-smoke/real-machine/`（忽略），不提交仓库。
5. 若验证后不再需要开发构建：卸载 0.2.0 开发 bundle，重新安装正式构建（本次未准备正式包）。

---

## 附录：fixture 编写要点（避免下一轮重新推导）

```js
// op
defineOp({
  manifest: { schemaVersion: 1, kind: 'op', name: 'rm-echo', opKind: 'query', limits: { totalMs: 1000 } },
  query: (ctx) => ({ at: ctx.now(), position: ctx.provider.query('position') }),
})

// act
defineAct({
  manifest: { id: 'rm-hold', queryOps: [], controlOps: [], limits: { totalMs: 30000 } },
  create: () => ({
    start: () => ({ kind: 'running' }),
    update: () => ({ kind: 'running' }),
    stop: () => ({ kind: 'complete' }),
  }),
})

// behavior
defineBehavior({
  manifest: { id: 'rm-act-test', mode: 'continuous', parameters: {}, dependencies: { acts: ['rm-hold'] } },
  *run(ctx) {
    const handle = yield ctx.act('rm-hold', {}, { async: true })
    try { yield ctx.act('rm-hold', {}, { async: true }) } catch (error) {
      yield ctx.progress({ code: error.code })
    }
    const stopped = yield ctx.actStop(handle.actId)
    return ctx.succeed({ stopped })
  },
})

// policy
definePolicy({
  manifest: { id: 'rm-night', inputs: ['samples', 'now'], outputs: [] },
  run: (inputs) => ({ fire: inputs.samples['0'].value.timeOfDay >= 13000, key: 'night' }),
})
```

- act 的 `ctx.control(name,args)` 返回 callId，结果在下一次 `update(ctx,{handles})` 中读取。
- behavior 的 `ctx.act` 需要 manifest `dependencies.acts`；policy 不作为 dependency 激活，只需 check。
- guard/watch 的 `predicate` 参数是 policy 的 `artifactId`，不是 definitionId。

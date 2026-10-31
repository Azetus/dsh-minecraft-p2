# M0 实机测试报告（LAN 25575）

> 测试日期：2026-10-31（Asia/Hong_Kong）
> 代码：分支 `P2MindTree`（M0 阶段）
> 插件包：`dsh-minecraft-p2@0.3.3`，`bundles/dsh-minecraft-p2-0.3.3.tgz`
> 包 SHA-256：`2887028A341A3C6A677696CE4DB5B1728E6898898AC0A8060DD03C52C6302C56`

## 1. 环境

| 项 | 值 |
|---|---|
| 游戏 | Minecraft Java 1.21.1，PCL 启动，客户端 `Human_Player` |
| 世界 | `dsh-P2Mind-dev`（本轮新建），开放到 LAN `127.0.0.1:25575` |
| 宿主状态 | 测试期间 `Human_Player` 切到旁观模式（12:57:19，由玩家本人操作） |
| 插件安装 | 先 `remove_bundle dsh-minecraft-p2`，再 `install_bundle file:E:\Code\Project\dsh-minecraft-p2\bundles\dsh-minecraft-p2-0.3.3.tgz`；应用后 `p2_body` 工具可用 |
| 安装位置 | `C:\Users\AL_S_\.dsh\profiles\desktop\node_modules\dsh-minecraft-p2` |
| 配置 | 仓库 `.p2/config.json` → `127.0.0.1:25575`，`P2_Bot` |

## 2. 步骤与结果

### 2.1 由 agent 通过插件工具启动 body

调用 `p2_body start`：

```json
{"action":"start","state":"active","epoch":"65866529-f726-4eb5-8a8d-f0838551aa10",
 "status":{"providerState":{"connected":true,"paused":false,"serverAge":293,"idleMs":0,"controlState":"idle"}}}
```

服务器日志：`P2_Bot logged in ... at (-9.5, 68.0, 9.5)`（12:57:23）。

`p2_body status` 持续返回 `active`、`connected=true`、`paused=false`、`controlState=idle`。

### 2.2 实机一致性场景（10/10）

body 用 `P2_Bot` 占位，场景客户端用另一用户名 `P2_Probe`，避免顶号：

```powershell
$env:P2_PORT_LIVE='1'; $env:P2_MC_USERNAME='P2_Probe'; $env:P2_MC_PORT='25575'
npx vitest run test/port-live.test.ts --pool=threads
```

结果：**10/10 PASS**，`Test Files 1 passed`，exit 0。完整输出见 `.m5-runs/m0-live-lan.log`（本机）。

| # | 场景 | 实测证据 |
|---|---|---|
| 1 | 读自身/背包 | pos (8.5,74,-1.5)，health 20，food 20，背包 `[]` |
| 2 | 走 5 格 | `moveTo` ok，位移 6.50 格，耗时 2.1s |
| 3 | 挖一格 | `grass_block (3,72,3)` → ok，读回 `air` |
| 4 | 放一格 | `dirt (1,71,2)` → ok，读回 `dirt`（用刚挖到的泥土） |
| 5 | 超时 | `unknown / CLIENT_TIMEOUT`，elapsed 57ms |
| 6 | 取消后 1s 无旧写 | `STALE_WRITE`，release 后 1s 位移 0 |
| 7 | 令牌过期拒绝 | 旧 seq `beginWrite` → `STALE_WRITE` |
| 8 | 未知方块 | 空目标 `dig` → `failed / DIG_NO_BLOCK` |
| 9 | 未加载区块 | 10 万格外 `blockAt = null`（不是 air） |
| 10 | 断线重连 | 断开后重连（12:57:50），`lookAt` ok，health 20 |

### 2.3 停止

`p2_body stop` → `{"action":"stop","state":"inactive"}`；服务器日志 12:58:00 `P2_Bot left the game`；本机无残留 `body.mjs` 进程。

## 3. 游戏内可观察结果

- 先后出现两个 bot：`P2_Bot`（插件启动的常驻 body，站在 (-9.5,68,9.5) 不动）与 `P2_Probe`（一致性场景客户端）。
- `P2_Probe` 走了约 6.5 格、挖掉一格草方块、放回一格泥土、掉线后重连；`P2_Bot` 全程静止。
- **M0 没有树/giver/order，P2_Bot 连上后不做事是预期行为。**

## 4. 世界改动（仅玩家可做的动作）

- 挖：`grass_block` at `(3,72,3)` → air。
- 放：`dirt` at `(1,71,2)`（来源即上一步挖到的泥土）。
- 未使用命令、传送、改模式、改 gamerule 或注入物品；宿主玩家的旁观模式切换由玩家本人操作。

## 5. 观察与风险

- 被取消的 `goto` 在 provider 中约 **3.5s** 才报告 release（`controlState` active→idle）。ClientPort 会等 release 后才返回 `STALE_WRITE`，期间旧句柄不再发起新写；M1 JobTracker 的停止确认必须按实测放宽或记录，不能假设 1s。
- LAN 世界的出生点附近地形为草坡（y≈68–74）；本次挖/放未被 spawn protection 阻止。
- 未覆盖：DSH `/p2` 命令入口（本次走的是插件 `p2_body` 工具）、order/对话/自治行为（M1+）。

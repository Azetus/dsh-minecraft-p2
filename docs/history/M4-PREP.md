# M4 前置：provider 配置与暂停语义

> 2026-10-27。实现 provider 的项目级配置，并把 server world age 纳入 query 元数据和暂停判定。  
> 这是 M4 前置，不是首个 M4 行为。

## 1. Provider 配置

### 文件

默认读取 body 当前工作目录下的：

```text
.p2/config.json
```

示例见 `.p2/config.example.json`：

```json
{
  "minecraft": {
    "host": "127.0.0.1",
    "port": 25575,
    "username": "P2_Bot",
    "version": "1.21.1",
    "connectTimeoutMs": 15000,
    "serverIdleMs": 1500
  }
}
```

实际 `.p2/config.json` 已加入 `.gitignore`。配置属于 **owner workspace**；body 由 `/p2 start` 以 owner cwd 启动，因此 DSH 会话的工作区根目录应包含 `.p2/config.json`。

### 优先级

```text
P2_MC_* 环境变量
  > .p2/config.json
  > 默认值
```

支持的环境变量：

```text
P2_MC_HOST
P2_MC_PORT
P2_MC_USERNAME
P2_MC_VERSION
P2_MC_CONNECT_TIMEOUT_MS
P2_MC_SERVER_IDLE_MS
```

没有配置文件且没有 `P2_MC_HOST` 时，body 保持 provider-unavailable，不阻止管理命令/工具加载。

## 2. serverAge 与暂停语义

### 数据

- `ValueMeta` 新增可选 `serverAge` 和 `paused`；
- position / inventory / entities / block / time 的 query meta 带当前 world age；
- `time` 的 value 带 `age` 与 `paused`；
- body `status.providerState` 暴露：

```json
{
  "paused": false,
  "serverAge": 141549,
  "idleMs": 0
}
```

### 暂停判定

Provider 监控 `bot.time.age`：

- age 变化：正常，clear paused；
- age 连续 `serverIdleMs` 未变化（默认 1500ms）：判定服务端 tick 停滞；
- 判定暂停时：
  - 立即清空 control states；
  - abort 当前 act，错误码 `GAME_PAUSED`；
  - behavior run 终止，`activeRun=null`；
  - `position` / `inventory` / `entities` / `block` query 失败，错误码 `GAME_PAUSED`；
  - `time` query 仍可读，但 `paused=true`；
  - `start()` 拒绝新 act，错误码 `GAME_PAUSED`。

### 解冻

- age 恢复后 `paused=false`；
- 世界 query 恢复；
- **不会自动恢复被暂停终止的 act/run**；必须显式重新 switch/start。

这是有意的 fail-closed 选择：暂停期间不能把 Mineflayer 客户端预测位置当成服务端事实，也不能在解冻后静默续跑旧控制。

## 3. 实测

### 配置路径

在**不设置任何 `P2_MC_*` 环境变量**的情况下，body 读取项目 `.p2/config.json` 并连接：

```json
{
  "ok": true,
  "status": {
    "connection": "connected",
    "providerState": {
      "paused": false,
      "serverAge": 141160,
      "idleMs": 0
    }
  },
  "position": { "x": -1899.95, "y": -60, "z": -13.74 }
}
```

### DSH `/p2 start` / `/p2 stop`

隔离 dev 的 `/p2 start` 返回成功：

```text
P2 body active (epoch c74acab2-...)
```

workspace 中的 `.p2/config.json` 被 body 读取并连接游戏。  
`/p2 stop` 返回成功：

```text
P2 body stopped
```

实测 stop 约 45ms；此前一次 faulted 是 dev 用了未重建的旧 tarball，重建 bundle 后通过。Desktop 安装路径仍未验证。

### 暂停

`node scripts/m4-pause-probe.mjs 127.0.0.1 25575`：

- 开始长 move：`activeRun=run-1`，`providerState.paused=false`；
- 第二 bot 执行 `/tick freeze`，约 2.5s 后：
  - `activeRun=null`；
  - `providerState={paused:true,serverAge:141560,idleMs:1940}`；
  - `observe position` → `GAME_PAUSED`；
  - `observe time` → `paused:true, age:141560`；
- `/tick unfreeze` 后：
  - `providerState.paused=false`；
  - `position` 可再次读取；
  - `activeRun` 仍为 null，没有自动续跑。

## 4. 验证

```text
npm run check
  → 17 test files / 127 tests: pass
```

新增：

- `test/provider-config.test.ts`：文件、env 覆盖、env-only、非法值；
- `test/mineflayer-provider.test.ts`：暂停/解冻、GAME_PAUSED、act abort、serverAge meta；
- `scripts/m4-pause-probe.mjs`：真实 config + `/tick freeze` 语义。

## 5. 仍需注意

- `serverIdleMs` 是启发式阈值；高延迟/服务器卡顿可能误判，需要按 M4 环境调整；
- 暂停自动终止 run，不提供自动恢复；M4 behavior 需要显式处理重新开始；
- `time` 在暂停期间可读是有意保留的只读诊断能力；
- 隔离 dev 的 `/p2 start` / `/p2 stop` 已验证；Desktop 安装路径未验证；
- 没有改变 M3 的边界：仍不是通用游戏能力。

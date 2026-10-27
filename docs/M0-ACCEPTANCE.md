# M0 验收记录

> 2026-10-27，dev 分支，包版本 `0.1.0`。记录实际执行的验证和仍未覆盖的边界；计划本身见 [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。

## 1. 范围

M0 完成了单包骨架、契约与摘要基础、NDJSON/内存/stdio 传输、body 运行时与进程入口、bridge 进程管理与 `/p2` 管理命令，以及隔离 DSH 的安装/加载验证。

本阶段没有连接 Minecraft，没有 provider，没有模型工具、行为执行或游戏动作。

## 2. 实现结果

- 一个 npm 包同时包含 bridge、body、authoring 子路径和 `cordis.patch.yml`。
- body 是独立子进程；bridge 加载时不创建进程，`/p2 start` 才创建，并完成 hello + describe 一致性校验。
- 已实现 `hello`、`heartbeat`、`describe`、`status`、`stop`、`shutdown`、`command.get`。
- `sourceDigest`、`bindingId`、`artifactDigest`、`artifactId` 有固定样例和规范化规则测试。
- `npm run verify:dist` 覆盖 tarball 安装、DSH profile 组合、模块导入、body manifest 摘要、authoring 入口和项目级 authoring 安装。

## 3. 自动验证

```text
npm run check
  → build + typecheck + 37 tests: pass

npm run verify:dist
  → tarball install into isolated DSH_HOME: pass
  → dsh.profile.bundles contains dsh-minecraft-p2: pass
  → --dump-config / --dump-config-schema: pass
  → body manifest version/digest: pass
  → installed authoring entry: pass
  → project-level authoring install and version: pass
```

当前测试文件：

- `test/contracts.test.ts`：13
- `test/protocol.test.ts`：10
- `test/body.test.ts`：9
- `test/bridge.test.ts`：4
- `test/body-process.test.ts`：1

## 4. 真实进程与命令链路

使用隔离开发环境：

```text
node scripts/dev.mjs --no-build --port 0 --keep
node scripts/dev-api-smoke.mjs <web-url-with-token> <dev-workspace>
```

实际结果：

```text
/p2 status before start  → P2 body inactive
/p2 setup                → P2 project ready
/p2 start                → P2 body active (epoch ...)
/p2 status               → P2 body active ... health=ready owner=session-...
/p2 stop                 → P2 body stopped
/p2 status after stop    → P2 body inactive
```

该链路使用真实 DSH Web 命令入口、真实 body 子进程和 stdio 管道。安装后、start 前没有 body 进程；stop 后恢复 inactive。

## 5. 环境与限制

- 端到端验证需要 DSH Host 能创建带管道的子进程。当前工作区的 workspace-write 沙箱会阻止这一点（`spawn EPERM`），因此该次 dev 验证在 full access 下启动；仓库和真实 Desktop profile 未被修改。
- 未验证真实 Desktop profile 的安装/加载；`verify:dist` 与 dev 已覆盖同一 tarball 的两种安装路径。
- 未验证 DSH 热重载/退出时的异步 dispose、body shutdown 响应的 flush 边界、heartbeat 超时的真实实验，以及 Windows 进程树强制回收。这些留到 M2/M6。
- `/p2 setup` 目前只检查项目 cwd；authoring 版本由 `verify:dist` 覆盖，尚未在命令中重复读取。
- 没有 provider、Minecraft 连接、游戏工具或模型回合。

## 6. 后续

M1 从执行器、查询注入、artifact/registry 和 checker 开始；本记录不把 M0 的测试当作后续阶段验收。

# 依赖与构建工具

> 本文记录当前单包使用的开发依赖、用途和版本选择依据。运行时依赖应尽量为空；新增依赖前先确认是否真的需要进入包内。

## 1. 包管理

- 当前使用 npm，锁文件为 `package-lock.json`。
- 包通过 npm 发布；`npm run bundle` 生成本地 tarball，用于离线安装和发布前验证。
- Node 版本跟随 DSH 的声明：`^22.19.0 || >=24.0.0`。
- npm 12 默认阻止依赖安装脚本；`package.json` 的 `allowScripts` 已记录 `esbuild@0.28.2`，只允许它执行安装时所需的平台二进制准备。

## 2. 开发依赖

| 依赖 | 版本 | 作用 | 为什么不放进运行时 |
| --- | --- | --- | --- |
| `@deepseek-ai/cordis` | `4.0.5` | bridge 的 Cordis `Context` 类型；与本机 DSH 0.2.1-rc.3 使用的 Cordis 版本一致 | 只做类型检查，bridge 不 import 它的运行时实现；宿主已提供 |
| `esbuild` | `^0.28.2` | 把 bridge、body、authoring 分别打成独立 ESM 入口；后续也用于把 Mineflayer provider 打成一个自包含文件 | 构建工具，不进入包 |
| `typescript` | `^6.0.3` | 类型检查；为 authoring 子路径生成 `.d.ts` | 构建工具，不进入包 |
| `vitest` | `^4.1.11` | 测试运行器；测试套件按 `AGENT.md §5.1` 的类别组织 | 开发工具，不进入包 |
| `@types/node` | `^22.20.1` | Node API 类型；与 DSH 的 Node 类型基线一致 | 类型声明，不进入包 |

## 3. 运行时依赖

当前 `dependencies` 是 provider 的三项（`mineflayer`、`minecraft-protocol`、`minecraft-data`）加 `vec3`，其余为零：

- bridge 只使用宿主提供的 Cordis/DSH 服务，不把宿主核心打进包。
- body 与 authoring 目前不需要第三方运行时库。
- Mineflayer 及其插件属于 provider 的实现依赖；优先把 provider/body 打成自包含文件，避免把依赖树装进 DSH profile。若无法完整 bundle，则在 `dependencies` 中记录并在干净环境验证依赖闭包。

### 3.1 provider 版本边界

当前 provider 固定 `mineflayer 4.39.0` / `minecraft-protocol 1.67.0` / `minecraft-data 3.114.0`，目标 MC 1.21.1。依赖行为按以下边界使用：

- 没有 `mayPlace` / `waitForUpdate` / `noPath` 事件 / `craft` 事件；放置事件是 `blockPlaced`。
- `openContainer(crafting_table)` 必抛（工作台不是容器），合成走 `bot.craft`。
- `takeOutput` 在空槽抛 `AssertionError`（无 message），调用方必须捕获。
- `openFurnace` 内部 `once('windowOpen')` 等待 20s；外部 10s 超时可能留下晚开窗口，写操作前必须 `closeWindow`。
- `update_time` 只有 `age/time`；`doDaylightCycle` 是推断值，不能当权威。

## 4. 常用命令

```text
npm install --cache .npm-cache
npm run typecheck
npm run test
npm run check
npm run build
npm run bundle
npm run verify:dist
npm run dev
npm run dev:check
npm run dev:smoke
npm run clean
```

`npm run bundle` 会先构建，再用 `npm pack` 把 `bundles/dsh-minecraft-p2-<version>.tgz` 输出到 `bundles/`。生成物和本地 npm 缓存不提交。

构建脚本调用 esbuild CLI 并继承 stdio，而不是使用 esbuild 的 JS API；当前 Windows 沙箱下，JS API 启动的服务进程需要 piped stdio，会被拒绝。不要为绕开这一点改成其他捕获输出的调用方式。

## 5. 开发与验证环境

- `npm run verify:dist`：构建 tarball，在 `.dev-home/verify` 创建隔离 `DSH_HOME`，通过 `dsh plugin add` 安装同一个 tarball，检查 profile 组合、`--dump-config` 与 `--dump-config-schema`；成功自动清理，失败保留诊断。
- `npm run dev`：在 `.dev-home/run` 创建隔离 `DSH_HOME`，生成包含 base、web-app 与 P2 的 profile，并启动 `dsh --port 0 --no-open`。不会读写真实 Desktop profile，也不会在用户 Documents 下创建 workspace。
- `npm run dev:check`：只 staging 并运行 profile 检查，不启动服务，适合快速排查。
- `node scripts/dev-api-smoke.mjs <web-url-with-token> <workspace>`：通过 DSH Web API 执行 `/p2 status/setup/start/status/stop`，验证真实 body 子进程链路。该链路需要 DSH Host 能创建带管道的子进程；workspace-write 沙箱下会 `spawn EPERM`，应在 full access 下运行。
- 直接运行 `node scripts/dev.mjs --keep` 可保留 `.dev-home/run` 供检查；默认退出时清理。
- 需要模型回合时用 `node scripts/dev.mjs --with-credentials`；凭据只从真实 `DSH_HOME` 复制到隔离 home。
- Minecraft provider 的 host/port 由 `/p2 start <host>:<port>`（或 `p2_body start`）在启动时传入，不写 `.p2/config.json`；文件只保留 `username`/`version`/`connectTimeoutMs`/`serverIdleMs` 等角色与连接行为。没有启动 target 时 body 保持 provider-unavailable。模板见 `content/templates/config.json`；`p2 start` 在缺失时创建 `.p2/config.json`，已有文件不覆盖，`.p2/` 整体不入库。
- 复用已有 session/workspace 时用 `node scripts/dev.mjs --reuse`。它跳过删除、bundle 安装和 workspace 重建，保留 `.dev-home/run` 下的 sessions、workspace 与 `.credentials.yaml`；目标 home 存在但 profile 无效时拒绝复用并保留现场，不自动删除。`--reuse` 不会自动重装 tarball。
- 代码更新后仍要复用已有 session 时用 `node scripts/dev.mjs --refresh`：保留 sessions/workspace/credentials，只强制重装当前 tarball 并校验 profile。默认（或显式 `--fresh`）仍是全量重建。
- `.dev-home/` 已加入 `.gitignore`；这些脚本不进入发布 tarball。

## 6. 版本更新原则

- Cordis 版本跟随当前 DSH 版本，不单独升级。
- `engines.dsh` 为 `>=0.2.1-rc.3 <0.3.0`；当前按 `0.2.1-rc.3` 测试。DSH 升级后先跑安装/加载/停止验证，再调整范围。
- 新增依赖必须说明它属于运行时还是构建期；只用于构建或类型检查的依赖放 `devDependencies`。

# 依赖与构建工具

> 本文记录初版单包使用的开发依赖、用途和版本选择依据。运行时依赖应尽量为空；新增依赖前先确认是否真的需要进入包内。

## 1. 包管理

- 初版使用 npm，锁文件为 `package-lock.json`。
- 包是 `private` 的本地 tarball，`npm run bundle` 输出到 `bundles/`，不发布 registry。
- Node 版本跟随 DSH 的声明：`^22.19.0 || >=24.0.0`。
- npm 12 默认阻止依赖安装脚本；`package.json` 的 `allowScripts` 已记录 `esbuild@0.28.2`，只允许它执行安装时所需的平台二进制准备。

## 2. 开发依赖

| 依赖 | 版本 | 作用 | 为什么不放进运行时 |
| --- | --- | --- | --- |
| `@deepseek-ai/cordis` | `4.0.5` | bridge 的 Cordis `Context` 类型；与本机 DSH 0.2.1-rc.3 使用的 Cordis 版本一致 | 只做类型检查，bridge 不 import 它的运行时实现；宿主已提供 |
| `esbuild` | `^0.28.2` | 把 bridge、body、authoring 分别打成独立 ESM 入口；后续也用于把 Mineflayer provider 打成一个自包含文件 | 构建工具，不进入包 |
| `typescript` | `^6.0.3` | 类型检查；为 authoring 子路径生成 `.d.ts` | 构建工具，不进入包 |
| `vitest` | `^4.1.11` | 测试运行器；当前用 `--passWithNoTests`，M0 起按测试文档的类别添加套件 | 开发工具，不进入包 |
| `@types/node` | `^22.20.1` | Node API 类型；与 DSH 的 Node 类型基线一致 | 类型声明，不进入包 |

## 3. 运行时依赖

截至 M4，`dependencies` 只有 provider 的三项（`mineflayer`、`minecraft-protocol`、`minecraft-data`），其余为零：

- bridge 只使用宿主提供的 Cordis/DSH 服务，不把宿主核心打进包。
- body 与 authoring 目前不需要第三方运行时库。
- Mineflayer 及其插件属于 provider 的实现依赖；优先把 provider/body 打成自包含文件，避免把依赖树装进 DSH profile。若无法完整 bundle，则在 `dependencies` 中记录并在干净环境验证依赖闭包。

**待定：隔离引擎。** M5 的 act／policy runner 需要一个能限制内存、中断执行且默认不含宿主能力的 JS 引擎；具体实现（QuickJS/WASM 变体等）由隔离 spike 决定，见[隔离设计](ISOLATION.md)。确定后它属于**运行时依赖**：必须随 tarball 打包（含 WASM 或其他二进制资产）并验证离线加载，不能依赖运行期下载；引入前需在本文记录版本、打包方式与离线验证结果。在 spike 结论出来前不添加该依赖。

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

## 5. 自主测试环境

- `npm run verify:dist`：构建 tarball，在 `.dev-home/verify` 创建隔离 `DSH_HOME`，通过 `dsh plugin add` 安装同一个 tarball，检查 profile 组合、`--dump-config` 与 `--dump-config-schema`；成功自动清理，失败保留诊断。
- `npm run dev`：在 `.dev-home/run` 创建隔离 `DSH_HOME`，生成包含 base、web-app 与 P2 的 profile，并启动 `dsh --port 0 --no-open`。不会读写真实 Desktop profile，也不会在用户 Documents 下创建 workspace。
- `npm run dev:check`：只 staging 并运行 profile 检查，不启动服务，适合快速排查。
- `node scripts/dev-api-smoke.mjs <web-url-with-token> <workspace>`：通过 DSH Web API 执行 `/p2 status/setup/start/status/stop`，验证真实 body 子进程链路。该链路需要 DSH Host 能创建带管道的子进程；workspace-write 沙箱下会 `spawn EPERM`，应在 full access 下运行。
- 直接运行 `node scripts/dev.mjs --keep` 可保留 `.dev-home/run` 供检查；默认退出时清理。
- 需要模型回合时用 `node scripts/dev.mjs --with-credentials`；凭据只从真实 `DSH_HOME` 复制到隔离 home。
- Minecraft provider 默认读取 owner workspace 的 `.p2/config.json`；`P2_MC_*` 环境变量覆盖文件值。没有文件且没有 `P2_MC_HOST` 时 body 保持 provider-unavailable。示例见 `.p2/config.example.json`，实际配置文件已忽略。详见 [M4-PREP.md](history/M4-PREP.md)。
- 复用已有 session/workspace 时用 `node scripts/dev.mjs --reuse`。它跳过删除、bundle 安装和 workspace 重建，保留 `.dev-home/run` 下的 sessions、workspace 与 `.credentials.yaml`；目标 home 存在但 profile 无效时拒绝复用并保留现场，不自动删除。`--reuse` 不会自动重装 tarball。
- 代码更新后仍要复用已有 session 时用 `node scripts/dev.mjs --refresh`：保留 sessions/workspace/credentials，只强制重装当前 tarball 并校验 profile。默认（或显式 `--fresh`）仍是全量重建。
- `.dev-home/` 已加入 `.gitignore`；这些脚本不进入发布 tarball。

## 6. 版本更新原则

- Cordis 版本跟随已实测的 DSH 版本，不单独升级。
- `engines.dsh` 固定为实际受测 runtime（当前 `0.2.1-rc.3`）；DSH 升级后先跑安装/加载/停止验证，再改这个值。
- 新增依赖必须说明它属于运行时还是构建期；只用于构建或类型检查的依赖放 `devDependencies`。

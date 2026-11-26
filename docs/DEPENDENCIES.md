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
| `esbuild` | `^0.28.2` | 分别构建 bridge、body 和 Mineflayer provider 的 ESM 入口 | 构建工具，不进入包 |
| `typescript` | `^6.0.3` | 类型检查；为包入口生成 `.d.ts` | 构建工具，不进入包 |
| `vitest` | `^4.1.11` | 测试运行器；测试套件按 `AGENTS.md §5.1` 的类别组织 | 开发工具，不进入包 |
| `@types/node` | `^22.20.1` | Node API 类型；与 DSH 的 Node 类型基线一致 | 类型声明，不进入包 |

## 3. 运行时依赖

当前 `dependencies` 是 provider 的三项（`mineflayer`、`minecraft-protocol`、`minecraft-data`）加 `vec3`，其余为零：

- bridge 只使用宿主提供的 Cordis/DSH 服务，不把宿主核心打进包。
- body 核心目前不需要第三方运行时库。
- Mineflayer 及其插件属于 provider 的实现依赖；优先把 provider/body 打成自包含文件，避免把依赖树装进 DSH profile。若无法完整 bundle，则在 `dependencies` 中记录并在干净环境验证依赖闭包。

### 3.1 provider 版本边界

当前 provider 固定 `mineflayer 4.39.0` / `minecraft-protocol 1.67.0` / `minecraft-data 3.114.0`。MC 版本默认由 `minecraft.version: "auto"` 在连接前解析（ping 服务器 → 按协议号查本机 `minecraft-data`），也可以显式钉死；实测环境为 `26.1.2`。依赖行为按以下边界使用：

- 没有 `mayPlace` / `waitForUpdate` / `noPath` 事件 / `craft` 事件；放置事件是 `blockPlaced`。
- `openContainer(crafting_table)` 必抛（工作台不是容器），合成走 `bot.craft`。
- `takeOutput` 在空槽抛 `AssertionError`（无 message），调用方必须捕获。
- `openFurnace` 内部 `once('windowOpen')` 等待 20s；外部 10s 超时可能留下晚开窗口，写操作前必须 `closeWindow`。
- `update_time` 只有 `age/time`；`doDaylightCycle` 是推断值，不能当权威。

## 4. 本地构建与检查

| 任务 | 命令 |
| --- | --- |
| 安装依赖并使用本地缓存 | `npm install --cache .npm-cache` |
| 构建、类型检查、测试 | `npm run check`。单独运行时分别用 `npm run build`、`npm run typecheck`、`npm test` |
| 生成安装包 | `npm run bundle` 先构建，再用 `npm pack` 生成 `bundles/dsh-minecraft-p2-<version>.tgz` |
| 验证安装包 | `npm run verify:dist` 在独立的 `.dev-home/verify` 安装 tarball，检查 profile 组合、`--dump-config` 与 `--dump-config-schema`。成功后清理该验证环境，失败保留诊断 |

生成物和本地 npm 缓存不提交。构建脚本调用 esbuild CLI 并继承 stdio，避免 Windows 沙箱拒绝 esbuild JS API 所需的管道子进程。

## 5. 检查或启动隔离的 p2-dev

从仓库根运行 [dev.mjs](../scripts/dev.mjs)。隔离的 `DSH_HOME` 是 `.dev-home/run`，默认 profile 在该目录的 `profiles/p2-dev` 下，会话历史在 `sessions/` 下。要保留原会话，先确认会话记录仍在，并检查默认 `workspace/` 和 `storages/workspace.json` 是否齐全。后两者有缺失时，复用流程也会重新写入默认 workspace 登记。

| 任务 | 从仓库根运行 | 对环境的影响 |
| --- | --- | --- |
| **保留原 session，只检查已安装的 profile** | `node scripts/dev.mjs --reuse --no-start --keep` | 复用已安装的插件，执行 `dsh --profile p2-dev --dump-config` 并检查结果中包含 P2。输出应显示 `dev: reused`、`bundle: reused`，检查日志写入 `.dev-home/run/dev-check.log`。全程无需启动 Web 服务或进游戏 |
| 用已安装的插件继续会话 | `node scripts/dev.mjs --reuse --keep` | 启动隔离 DSH，Web 端口由系统分配；按原 session ID 和工作目录选回会话 |
| 用当前工作树的插件继续会话 | `node scripts/dev.mjs --refresh --no-start --keep` | 重新打包、在已有 profile 强制安装并检查，保留会话。检查通过后用上一行命令启动 |
| 首次创建或明确要求重建 | `node scripts/dev.mjs --fresh --keep` | 先删除已有 `.dev-home/run`，再创建并启动新环境。`--keep` 保留的是这次生成的环境 |

若 `.dev-home/run` 缺失，`--reuse` 也会创建新环境。若 home 已有但 profile 无效，`--reuse` 会报错并保留现场。`npm run dev` 和 `npm run dev:check` 都默认重建，后者只多传 `--no-start`，成功后还会清理新环境。`npm run clean` 会删除整个 `.dev-home`，包括其中的所有 session。

需要模型回合且隔离环境缺少凭据时，在所选命令上追加 `--with-credentials`，将源 `DSH_HOME` 的凭据复制到隔离 home。`.dev-home/` 已加入 `.gitignore`，开发脚本不进入发布 tarball。

需要在原会话里自然语言派单、连接本轮 LAN 或核对订单终态时，按[外层实机验收 skill](../.agents/skills/p2-live-acceptance/SKILL.md)执行。角色和版本从所选会话工作目录的 `.p2/config.json` 读取，使用 `/p2 start <host>:<port>` 传入本轮连接地址。单独验证 body 子进程链路时可用 `npm run dev:smoke -- <web-url-with-token> <workspace> <host>:<port>`。它会新建会话、启动并停止 body，需要 DSH Host 能创建带管道的子进程。

## 6. 版本更新原则

- Cordis 版本跟随当前 DSH 版本，不单独升级。
- `engines.dsh` 为 `>=0.2.1-rc.3 <0.3.0`；当前按 `0.2.1-rc.3` 测试。DSH 升级后先跑安装/加载/停止验证，再调整范围。
- 新增依赖必须说明它属于运行时还是构建期；只用于构建或类型检查的依赖放 `devDependencies`。

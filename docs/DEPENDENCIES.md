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

当前 `dependencies` 为空，这是有意的：

- bridge 只使用宿主提供的 Cordis/DSH 服务，不把宿主核心打进包。
- body 与 authoring 目前是骨架，不需要第三方运行时库。
- Mineflayer 及其插件属于 provider 的实现依赖，计划在 M3 引入；优先把 provider/body 打成自包含文件，避免把依赖树装进 DSH profile。若无法完整 bundle，则在 `dependencies` 中记录并在干净环境验证依赖闭包。

## 4. 常用命令

```text
npm install --cache .npm-cache
npm run typecheck
npm run test
npm run check
npm run build
npm run bundle
npm run clean
```

`npm run bundle` 会先构建，再用 `npm pack` 把 `bundles/dsh-minecraft-p2-<version>.tgz` 输出到 `bundles/`。生成物和本地 npm 缓存不提交。

构建脚本调用 esbuild CLI 并继承 stdio，而不是使用 esbuild 的 JS API；当前 Windows 沙箱下，JS API 启动的服务进程需要 piped stdio，会被拒绝。不要为绕开这一点改成其他捕获输出的调用方式。

## 5. 版本更新原则

- Cordis 版本跟随已实测的 DSH 版本，不单独升级。
- `engines.dsh` 固定为实际受测 runtime（当前 `0.2.1-rc.3`）；DSH 升级后先跑安装/加载/停止验证，再改这个值。
- 新增依赖必须说明它属于运行时还是构建期；只用于构建或类型检查的依赖放 `devDependencies`。

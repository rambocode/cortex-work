# 经验沉淀（lessons）

记录会复发的系统性问题与排查套路。一次性失误或风格偏好不记。

---

## electron-builder 摊平 pnpm 多版本依赖 → 纯 ESM 第三方包命名导入崩溃

**现象**：开发态正常，**打包后**第三方包(如 pi `@earendil-works/pi-coding-agent`)启动即报：

```
SyntaxError: Named export 'minimatch' not found. The requested module 'minimatch'
is a CommonJS module, which may not support all module.exports as named exports.
```

**根因**：仓库里同一个包存在多个版本共存(本例 `minimatch` 有 `3.1.5 / 5.1.9 / 9.0.9 / 10.2.5`，旧版由 eslint、`glob@7` 等 **devDependencies** 拖入)。开发时 pnpm 的隔离结构(`.pnpm` 符号链接)保证纯 ESM 的 pi 解析到它 pin 的新版(`minimatch@10.2.5`，有 ESM 命名导出)；但 **electron-builder 打包会把 pnpm 结构「拍平」**，拍平时给 pi 喂了旧版(`minimatch@3` 纯 CJS，`module.exports = fn`)，Node 的 ESM 加载器无法静态提取命名导出 → 崩。

**解法**：在根 `package.json` 的 `pnpm.overrides` 把冲突包钉到目标包 pin 的版本，源头收敛为单版本，拍平就无歧义：

```jsonc
"pnpm": { "overrides": { "minimatch": "10.2.5" } }  // 与 pi 的 pin 对齐
```

仅影响开发期工具链(老消费者随之升版)，必须 `typecheck / test / lint / build` 全绿验证；生产运行时零风险(目标包本就要新版)。**注意这条只解决「版本」,不解决「位置」——见下一条,两者正交、都要治。**

**排查套路**：
1. 数版本：`ls node_modules/.pnpm | rg '^<pkg>@'`
2. 溯来源：`pnpm why -r <pkg>`（区分 dependencies vs devDependencies）
3. 验产物：`@electron/asar extract-file app.asar node_modules/<pkg>/package.json` 看 version 是否唯一且正确。

**注意**：`pnpm install` 不会删 `.pnpm` 下被 override 掉的旧版本目录(孤儿)，但它们无 symlink 引用、不会被 electron-builder 收集，无害；介意可 `pnpm store prune`。

---

## pi 在 unpacked、依赖闭包留 asar → ESM/CJS 都跨不过 asar 边界(必须全 unpack)

与上一条**正交**:上一条是依赖【版本】错(多版本摊平选错),这一条是依赖【位置】错(根本解析不到)。两者都要治。

**现象**:pi 在**真实安装环境**逐个报依赖找不到——先加载扩展时 `Cannot find module 'typebox'`,修了又在启动时 `ERR_MODULE_NOT_FOUND: Cannot find package 'undici'`(`http-dispatcher.js` 的 ESM import),后面还有 jiti/glob/yaml…

**根因**:`asarUnpack` 只把 pi 包(`@earendil-works/**`)搬到 `app.asar.unpacked`,pi 的【整个依赖闭包】留在 `app.asar` 内。pi(unpacked 区)解析任何依赖时,Node 从 `app.asar.unpacked/.../pi/...` 往上找 node_modules,候选链经过 `app.asar.unpacked` 却**不经过平行的 `app.asar`**(二者是 `Resources` 下两个独立条目)→ asar 内的依赖一律进不了候选。

**⚠️ 我踩过的误判(最重要的教训)**:曾以为"ESM `import` 能跨 asar、只有 CJS `require.resolve` 不能",于是只 unpack 了 typebox。**这是错的——ESM 和 CJS 一样都跨不过**。误判源于**在仓库内的 dist 验证**(`<repo>/apps/desktop/dist/...`):那里 pi 往上能摸到**仓库的 node_modules** 兜底,依赖"看着能解析",是假象。装到 `/Applications`(无仓库兜底)才暴露 undici。**教训:打包依赖验证必须把 app 复制到仓库外(/tmp)再跑,否则仓库 node_modules 会制造假通过。**

**解法**:不要逐个 unpack(打地鼠,typebox 修完是 undici)。直接全 unpack,让 pi 与依赖闭包落在同一棵真实树:

```yaml
asarUnpack:
  - "**/node_modules/**"
```

主进程仍在 asar,它 require 这些被 unpack 的依赖由 Electron 的 fs patch 透明重定向,不受影响(asarUnpack 标准行为)。代价:node_modules 散文件、文件数增多(签名/复制稍慢),内容体积基本不变(asar 默认不压缩)。

**验证(必须仓库外)**:
```bash
ditto "<repo>/.../dist/mac-arm64/<App>.app" /tmp/Test.app          # 复制出仓库,隔离仓库 node_modules
ELECTRON_RUN_AS_NODE=1 "/tmp/Test.app/Contents/MacOS/<App>" \
  "/tmp/Test.app/Contents/Resources/app.asar.unpacked/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" --help
# 期望:pi 完整打印 help、零 MODULE_NOT_FOUND
```

**潜在同类**:unpacked 区代码用 `fs` 读 asar 内资源(如 pi 的 photon wasm 图片处理)也有类似边界。

> ⚠️ 后续:全 unpack 仍在 asar 体系内缠斗(wasm fs 边界等隐患仍在),**最终被下一条「bun 二进制」方案取代**。本条与上一条(override)作为历史经验保留——理解「为什么 bun 二进制是对的」需先看这两条踩过的坑。

---

## 终极方案:纯 ESM 复杂 CLI(如 pi)在 Electron 里改用 `bun --compile` 自包含二进制 + spawn

前两条(版本 override、全 unpack)都是在 asar 体系内打补丁。pi 这类**纯 ESM、依赖闭包庞大、还带 wasm/napi 原生资产**的 CLI,塞进 asar 始终在跟 Node 模块解析 + asar 边界缠斗。**根治:用 bun 编成自包含单二进制,所有依赖 inline,彻底脱离 node_modules 解析。**

**做法**(见 `apps/desktop/scripts/build-pi-binary.mjs`):
- `bun build --compile <pkg>/dist/bun/cli.js --outfile pi`——pi 官方有 `dist/bun/` 入口,不需要其 monorepo 源,直接吃 npm 包(实测 0.4s 出 70M 二进制)。
- **旁置资产**:bun 二进制不 inline 数据文件。`config.js` 的 `isBunBinary` 分支按「二进制所在目录」找 `theme/`(启动 initTheme 必需)、`assets/`、`export-html/`、`package.json`——必须把这些拷到二进制旁。
- electron-builder `extraResources` 带二进制 + 资产(不进 asar);`cli.ts` 用 `child_process.spawn` 调用(独立 CLI 进程,不弹 Dock,替代 `utilityProcess.fork`)。
- 撤销之前的全 unpack(`asarUnpack` 恢复最小);minimatch override 可留可撤。

**收益**:minimatch/typebox/undici/任何依赖解析问题一次性消失;asar 恢复正常;用 pi 官方一等支持的 bun 二进制形态最稳。**代价**:构建依赖 bun(CI 需装);pi 升级要重 compile(脚本按 `.pi-version` 幂等)。

**验证同样必须仓库外**:`Test.app/Contents/Resources/pi/pi --mode json -p -e <ext> --provider <id> "hi"`,确认完整 JSON 事件流 + 扩展加载 + 到 LLM 调用(假 key 401 即通)。

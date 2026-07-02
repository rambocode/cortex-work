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

---

## ENOENT ≠ 文件缺失:先核对「报错路径」是否等于「真实文件路径」,别急着按缺失处理

**现象**:用户反馈会话里点 Agent 输出的文件链接,「第一次能打开,后面都打不开」,toast 报 `fs:readFile ... ENOENT ... '/Users/jingjing/Documents/Ops/002-…机制澄清.md'`。我第一轮看到 ENOENT **直接假设文件不存在**,做了「渲染期探测存在性 → 删除线标注 + 禁用点击」——**方向完全做反**:文件其实存在,这套改动反而把存在的文件标成已删除、彻底点不开。

**根因**:文件**真实存在,但在子目录**(`outputs/yuque-kb/docs/002-…md`)。LLM 输出的表格第一列是 **inline code 裸文件名**(无目录前缀,公共前缀写在表格标题里)。`resolveProjectFileRef(root, "002-…md")` 把裸名直接拼到**项目根** → `root/002-…md`,丢了中间目录 → 路径错 → ENOENT。「第一次能打开」是因为那个文件恰在根目录(拼根正确);子目录的文件全错。即:**ENOENT 来自错误构造的路径,不是文件缺失。**

**教训 / 排查套路**:
1. 看到 ENOENT,先问「**报错里的那个绝对路径,真的就是文件该在的位置吗?**」——把报错路径拿去 `ls`/对照真实树,而不是默认「文件没了」。
2. 反查 `ref → 绝对路径` 的**构造链路**(本例 `resolveProjectFileRef` 简单拼根)。裸文件名 / 相对名落到错误基准目录,是 ENOENT 的常见伪装。
3. **让用户的复现描述纠偏假设**:「第一次能、后面不能」本质是「根目录文件能、子目录文件不能」,这个非对称性直接指向「路径基准错」而非「文件缺失」。
4. 修法是**让 ref 能定位到真实文件**(项目内按 basename 查找,见 `fs:resolveProjectFile`),而非把定位不到的标成「已删除」。仅当项目内确实搜不到才按缺失处理。

---

## 新增主进程依赖时,务必核对 electron-builder.yml 的 `files` 排除清单(renderer-only 排除会坑主进程)

**现象**:浏览器控制上线后,打包正式版**启动即崩**:`Cannot find module 'zod/v3'`(`@modelcontextprotocol/sdk/.../zod-compat.js` require)。dev、`pnpm test`、worktree 全绿,只有打包后崩。

**根因**:`electron-builder.yml` 的 `files` 里有一条历史排除 `- "!**/node_modules/zod/**"`,注释写「zod 仅 renderer 用、随 out/ bundle」。但新功能让**主进程**的 MCP SDK 依赖 zod——主进程走 `externalizeDepsPlugin`,SDK 不进 bundle、运行时从 **asar 的 node_modules** `require`,且 `require('zod/v3')`(zod v4 的兼容子路径)。排除后 asar 内 zod 条目数=0 → 解析失败。node 对 `require('zod/v3')` 报的是**原始 specifier**,故显示 `zod/v3` 而非 `zod`,别被误导成「子路径问题」。

**教训 / 排查套路**:
1. **引入任何会被主进程 `require` 的新依赖(尤其经 externalizeDepsPlugin external 掉的)后,先查 `electron-builder.yml` 的 `files` 黑名单**有没有把它(或它的传递依赖)排除掉。renderer-only 的体积优化排除,会随「该依赖被主进程用上」而失效。
2. `Cannot find module 'X/sub'` 先判断是「整个包没打进去」还是「子路径缺失」:`node -e "require('@electron/asar').listPackage(asar).filter(p=>p.includes('node_modules/X/'))"` 数条目,0 条=整包没进(报错里的子路径只是原始 specifier)。
3. **打包问题必须仓库外验证**:改完跑 `dist:dir`(跳签名),再用 `@electron/asar` listPackage 确认目标文件(如 `zod/v3/index.cjs`)真在 asar 里,别只改配置就发版。
4. peerDependency 不会被 electron-builder 自动收;靠消费方(desktop)把它列进 `dependencies` 才打包——但若被 `files` 显式排除,列了也没用。

---

## CSS 注释里的 `*/` 提前闭合 → Tailwind v4 / Lightning CSS 静默丢规则（postcss 却容忍）

**现象**：新加的一整块 CSS 规则在运行时「像没写」——本例 `.pw-projects-page{position:fixed;inset:0}`（全屏三栏工作台的覆盖层）未生效，导致该覆盖层退化为 `.body`（flex row）的**在流子元素**，把侧栏/落地页挤成窄列、字符竖排、底层 UI 透出，整个界面错乱。dev 与打包**都坏**（不是 stale HMR）。

**根因**：CSS 注释里出现了非预期的 `*/`，**提前闭合注释**。本例注释文案写了类名通配 `.pw-task-*/.pw-project*`，其中 `*` 紧跟 `/` 构成 `*/` → 注释在此结束，后面 `.pw-project*。 */ .pw-projects-page {…}` 被当成 CSS，变成畸形选择器。**Tailwind v4 用 Lightning CSS**（`globals.css` 里 `@import "tailwindcss"`，dev server 与 `electron-vite build` 同一引擎），**严格丢弃畸形规则**；而 `postcss.parse` 宽松、能「解析通过」——所以只用 postcss 验证语法会漏掉。

**为何隐蔽**：源文件 `grep`/`postcss` 都显示规则在、语法 OK；只有看**构建产物**才发现规则没进去。相邻的其它注释（如 `.pw-project*；` 后接全角 `；` 不构成 `*/`）安然无恙，更易误判为「只有这块坏」。

**解法**：注释里避免 `*/`——引用带通配的类名时不要写成 `.a-*/.b-*`，改用「与」「/」加空格或去掉斜杠（`.pw-task 与 .pw-project 系列类`）。

**排查套路**：
1. 症状是「某块 CSS 整体失效 + 布局塌成窄列/竖排」→ 先怀疑该块**前面的注释**里有 `*/`。
2. **验产物而非源**：`electron-vite build` 后 `grep -c '<class>' out/renderer/assets/globals-*.css`，与一个「已知在」的类（如 `pw-settings-page`）对照计数；0 = 被丢。
3. 全文件扫隐患：找注释体内的 `*/`（如 `grep -nE '\*/[^ ]' file.css`），排除正常的行尾 `*/`。
4. `postcss.parse` 通过**不代表** Lightning CSS 会保留——两者宽严不同，CSS 正确性以构建产物为准。

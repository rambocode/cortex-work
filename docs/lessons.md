# 经验沉淀（lessons）

记录会复发的系统性问题与排查套路。一次性失误或风格偏好不记。

---

## Electron 拖拽带隔着 fixed 覆盖层吞点击:`-webkit-app-region: drag` 命中与 z-index 无关

**现象**:整窗覆盖层(如写作工作区 `.pw-writing-root`,fixed inset-0 z-40)顶部一条横带内的按钮**点不中**,只有露在该带之下的部分可点;覆盖层其余区域正常。

**根因**:被盖住的底层 UI(个人工作区列头 `.pw-col-head`/`.titlebar`)带 `-webkit-app-region: drag`。Electron 的拖拽区命中是**窗口级**判定,不走 DOM 事件、**不受 z-index/遮挡影响**——覆盖层盖住它也照样在窗口顶端 ~40px 全宽生效,把覆盖层同位置的点击吞成「拖窗口」。

**解法**:覆盖层根元素显式 `-webkit-app-region: no-drag` 整体抵消底层拖拽带,再在覆盖层内自己需要的位置(如左栏贴顶条)重新划 `drag` 区(内部交互元素记得 `no-drag`)。

**排查套路**:覆盖层里「只有顶部一条带点不中/一点就拖动窗口」→ 先怀疑底层 app-region,搜 `app-region: drag`/`.ds-drag` 看底层谁在同一屏幕位置;新建整窗覆盖层时默认给根元素 `no-drag` + 自划拖拽条。

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

---

## Vite `build.ssr: true` 默认外部化全部依赖 → 打包后子进程 `import()` 到不存在的包

**现象**：新增的 Research Worker（`utilityProcess.fork` 的子进程，独立 vite config 构建）在 dev 下一切正常、单测全绿，但产物只有 62 KB / 20 modules，且 `grep require\(` 能看到 `require("zod")` 与被原样保留的 `import("pdfjs-dist/legacy/build/pdf.mjs")`。打包后该 worker 的 PDF 抽取会直接失败。

**根因（两层叠加）**：
1. `build.ssr: true` 让 vite 把**所有 node_modules 依赖判为 external**。`rollupOptions.external` 只能**追加**外部化，**无法反向强制内联**——想真正 bundle 必须显式写 `ssr: { noExternal: true }`（注意是**顶层** `ssr` 字段，不是 `build.ssr`）。
2. `electron-builder.yml` 的 `files` 段本就把 `pdfjs-dist` 整个排除出 asar（注释写明「renderer+main 均已 bundle」）。主进程那次 dynamic import 之所以没事，正是因为 electron-vite 把它 bundle 进了 `out/main`。新的 worker 不 bundle，就变成 import 一个打包产物里根本不存在的包。

**为何隐蔽**：dev 下 `node_modules` 齐全，一切正常；单测里 `loadPdfJs` 是可注入依赖、根本不加载真 pdfjs；typecheck 也不看运行期解析。**只有打包态才暴露，而打包验证通常排在最后**。

**解法**：新增任何独立 vite 构建入口（尤其给子进程用的）时：
```ts
ssr: { noExternal: true },          // ← 顶层，强制内联第三方依赖
build: {
  ssr: true,
  rollupOptions: {
    external: ["electron", /^electron\/.+/, ...builtinModules.flatMap((m) => [m, `node:${m}`])],
    output: { entryFileNames: "<确定的名字>.js" },
  },
},
```

**顺带一个坑**：`build.ssr` 模式下 `lib.fileName` **不生效**，产物会退回 `index.js`。依赖确定文件名定位入口的代码（如 worker 的 entry-resolver）会找不到文件。必须用 `rollupOptions.output.entryFileNames` 显式指定。

**验证套路**（改完立刻做，别留到发版）：
1. `grep -oE 'require\("[^"]+"\)' <产物>` → 除 node 内建外**不应有**任何第三方包。
2. 对照一个已在生产运行的同类产物（本例：`out/main/pdf-*.js` 与 worker 的 `chunks/pdf-*.js` chunk hash 相同，说明打包行为一致）。
3. 子进程类产物**真 fork 一次**跑通协议往返，别只看构建成功——本例靠 `doctor` 返回 `pdf_available: true` 才证明 pdfjs 确实能加载。

---

## main 侧窄写通道必须把结果回传给 renderer，否则会被陈旧副本静默覆盖

**现象**：给设置页接「保存 PAT」时，main 用 `safeStorage` 加密后写进
`personal-workspace.json` 的 `researchEngine.searchServer.encryptedToken`，写入本身完全正确。
但用户保存完令牌、随手再点一个开关，**刚存的令牌就没了**，且界面上「令牌状态」一直显示「未配置」。

**根因**：这是「双写同一份文档」的经典竞态，与业务无关，任何走
`store:save` 全量落盘的设置项都会踩：

1. renderer 的 store 里有一份 `searchServer` 副本，**不含** main 刚写的 `encryptedToken`；
2. 设置组件的全量写回以这份副本为基线（`patch()` 里 `{...base, ...next}`）；
3. 于是下一次任意设置变更 → 全量 `store:save` → 用缺密文的副本覆盖磁盘 → 令牌蒸发。

main 写得越"对"（绕开 renderer、直接改权威态），这个洞越隐蔽——因为写入路径的单测全绿，
问题只在「main 写完 + renderer 随后再写一次」的时序里才出现。

**解法**：main 侧的窄写通道**返回落盘后的结果**，renderer 拿到后写回自己的 store，
让两边副本重新对齐。回传密文是安全的——renderer 本来就持有它（只有 main 能解）。

```ts
// core 的桥契约：返回值不是可有可无的
setSearchServerCredential?(input): Promise<ResearchSearchServerSettings>;

// renderer：拿到就回写，别丢
void fn(input).then((saved) => { if (saved) patch({ searchServer: saved }); });
```

**判据**：只要满足「main 能直接改某个 renderer 也会全量写回的持久化字段」，
就必须回答一句「renderer 怎么知道它变了」。答案只有两个——**回传**或**广播**
（`store:patchPushSettings` 走的是广播，见 `store.ts` 的 `broadcastPushSettingsIfChanged`）。
没有第三种，"反正下次重启会读到"不算。

**测试怎么写才咬得住**：断言「保存后 store 里有密文」是不够的，那只覆盖了第 1 步。
必须**再动一个无关开关**，然后断言密文还在——这才复现第 3 步：

```ts
fireEvent.click(screen.getByRole("switch", { name: "会话内检索" }));
expect(research()?.searchServer?.encryptedToken).toBe("CIPHER-FROM-MAIN");
```

---

## 自动触发的动作失败后，必须同时留下「手动重试入口」和「失败原因」

**现象**：新建研究后会话一直停在「待开始」，界面上四个按钮全灰，没有任何错误提示。
用户无从判断该等它自己恢复、还是自己要做点什么——实际上两者都不是，只能删掉重建。

**根因是两个独立的洞叠在一起**，各自都不致命，凑一起就成了死局：

1. **状态机有个没人能推动的中间态**。创建表单会自动调一次 `run`，失败后会话停在 `created`：
   它不是运行中（不能暂停）、不是已暂停或中断（不能恢复）、也不是终态。
   `canPause/canResume/canCancel` 三个判定各自都对，但**没有一个覆盖 `created`**。
   启动恢复也不管它——那只把「运行中途挂掉」的会话转成 `interrupted`。
2. **失败原因写在了一个即将卸载的组件的局部 state 上**：
   ```ts
   catch (e) { setError(`启动失败：${e.message}`); }
   setSubmitting(false);
   onCreated(summary);        // ← 宿主在这里 setCreating(false)，表单当场卸载
   ```
   `setError` 的内容一帧都没显示就没了。代码注释还写着「列表里能看到、可重跑」——
   **可重跑的入口从来不存在**，注释描述的是意图，不是事实。

**解法**：
- 给 `created` 补一个「开始」按钮（`canStartSession(status) === "created"`）。
  `service.run()` 本来就不挑状态，能力一直在，只是没有入口。
- 失败原因由宿主保管并透传给会话视图（连 sessionId 一起存，切会话时清掉），
  而不是留在创建表单里。

**可复用的判据**（每次写「自动执行某个动作」时问一遍）：
1. 这个动作失败后，**用户点哪里能重试**？答不上来就是死局。
2. 失败原因**显示在哪个组件上**？如果那个组件在失败后的下一步就被卸载，等于没显示。
3. 遍历状态枚举，确认**每个非终态都至少被一个操作判定覆盖**——
   逐个判定单独看都对，不代表并集是全的。

**测试要咬住第 3 条**，别只测你想到的那个状态：
```ts
expect(canStartSession("created")).toBe(true);
for (const s of RESEARCH_SESSION_STATUSES.filter((s) => s !== "created")) {
  expect(canStartSession(s)).toBe(false);
}
```

---

## agent-browser 的 action policy 认「规范动作名」，不认子命令名

**现象**：Deep Research 的 Browser 兜底对所有站点都救不回来——403 站点再吃一次 403，
JS 渲染页拿到 0 字。但适配器的单测全绿，日志里也只有一句普通的抓取失败。

**根因是三个洞叠在一起，每一个单独看都不显眼**：

1. **装配层漏接**：`runtime.ts` 构造 `ResearchService` 时没传 `agentBrowserBinary`。
   该依赖是 `?:`，漏传不会有编译错误，也不会让任何单测变红（单测都自己构造 deps）。
   worker 侧于是在 `if (!binary) return null` 处直接放弃——**整条兜底是死代码**。
2. **policy 写了子命令名而不是规范名**：allow 列表里是 `"open"`，但 agent-browser 把
   `open` 子命令归一成 `navigate` 再比对，于是导航永远 `denied by policy`。
   适配器只能退用 `read <url>`，而那条路走的是 agent-browser **自带的 HTTP 客户端**
   （`source: "html-fallback"`、`browserLaunched: false`），**根本不启动 Chrome**。
   也就是说：兜底对它存在的全部三个触发场景（403 / 429 / 空正文）统统无效。
3. **导航后没等渲染**：`open` 返回 ≠ 页面渲染完。实测同一 SPA 页，5 次里 2 次读到空壳
   （11 字 vs 完整 3188 字）。`wait --load networkidle` 后 5/5 稳定。
   而它的规范名是 `waitforloadstate`——**同一个坑又踩一次**。

**这个「子命令名 ≠ 规范动作名」的坑已经踩了三次**：
`eval`→`evaluate`（U0 S4 发现，代码里留了 `PROBE_DENIED_ACTION` /
`PROBE_DENIED_ACTION_NAME` 两个常量）、`open`→`navigate`、`wait --load`→`waitforloadstate`。

**规则**：往 allow 列表加动作前，**先用真二进制跑一次并读错误文案**——
`Action 'navigate' denied by policy` 里的那个词才是要写进列表的名字。
别照着 `--help` 的子命令名抄。两个名字都留着最安全（语义等价时不放大权限）。

**更一般的教训 —— 可选依赖的装配层要有测试**。凡是 `deps.foo?:` 这种形状，
漏接一个的代价是「功能静默消失」而不是「报错」，而所有既有单测都测不到它，
因为它们自己构造 deps。装配点值得一个哪怕很粗糙的结构断言：

```ts
const runtimeSource = readFileSync(join(__dirname, "runtime.ts"), "utf8");
it("必须注入 agentBrowserBinary，否则 Browser 兜底是死代码", () => {
  expect(runtimeSource).toContain("agentBrowserBinary");
});
```

断言源码文本很糙，但它咬住的正是「有没有接线」这件唯一会漏的事。

**验证要用真二进制、并且要重复跑**：这个 bug 的第 3 层是概率性的，
跑一次「成功了」会直接把它放过去。

---

## 一个设置项若能从另一个设置项推导出来，它就不该存在

**现象**：CRE 原设计让用户在新建研究时选一档「数据出站策略」
（`local_only` / `metadata_only` / `evidence_allowed`），同时用户还要在别处选模型。
用户一句话否掉了它：「这个没任何意义，应该由用户所选的模型控制」。

**为什么这是设计缺陷而不是偏好问题**——三条都成立才叫「冗余」，这里三条都成立：

1. **同一事实的两个真源**。「正文会不会离开这台机器」由所选模型的 `baseUrl` 唯一决定：
   loopback 就是不出站，云端就是出站。策略枚举是对同一事实的第二次声明。
2. **两个真源可以互相矛盾，而矛盾的代价落在用户头上**。选了云模型又选 `local_only`
   → 选型只在 loopback provider 里挑 → 研究直接不可用；选了 `metadata_only`
   → 模型从来看不到正文 → 报告退化成「按标题字面推测」。两种情况用户都看不出是哪个
   设置导致的，日志里也只有一句 `call_failed`（这两条各自都真实踩过，见本文件前面两条）。
3. **说明文案会与实际行为漂移**。策略档位的文案是「用户声明的意图」，实际出站由选型结果决定，
   两者各说一套；改成从 `isLocal` 推导文案后，文案与行为在结构上不可能不一致。

**判据（新增任何设置项前问一遍）**：
- 这个值能否从别的设置**推导**出来？能 → 不要存它，写个纯函数导出它。
- 如果用户把它和它的来源设成互相矛盾的组合，会发生什么？
  答案是「功能不可用」或「静默降级」而不是「报一个能看懂的错」→ 这个设置项不该存在。
- 面向用户的说明文案，是取自「用户声明的意图」还是「系统实际会做的事」？
  必须是后者，且最好由同一个函数同时产出判定与文案（本例：`selectResearchModel` 出
  `isLocal`，`describeModelEgress(isLocal)` 出文案，UI 只渲染）。

**别顺手拆掉正交的那一层**。这次删掉的是 Session 级的出站策略，
但来源级的零信任闸门（`canSendToCloudModel`：memory / local_file / 登录页默认不得进模型）
是**另一个问题的答案**——它回答「这份数据本身允不允许被送进模型」，与「数据去哪」正交，
必须原样保留。判断依据：两者能否同时为真且互不蕴含。能，就不是冗余。

**收尾要彻底，留半截比不删更糟**。一个永远等于某个常量的字段会让后来人以为它还在起作用：
类型、zod schema、DB 列（本例加了迁移 v2 `DROP COLUMN`，**不改已发布的 v1**）、
死掉的 prompt 构造函数、UI 标签表、barrel 导出，一并清掉；spec 里那条 KTD 不是删除而是
**标注修订并写清为什么**——否则下一个读 spec 的人会照着原设计再实现一遍。

## macOS 日历的 write-only 授权档：读返回空数组而非报错，且第三方库看不见它

**症状分两层，两层都是静默的。**

第一层：用户在系统设置里把日历权限给成「仅添加」（`EKAuthorizationStatusWriteOnly`，macOS 14 起），
应用调 `store.events(matching:)` 拿到的是**空数组，不是错误**。若代码把 write-only 判成「已授权」
（`status == .fullAccess || status == .writeOnly`，这是本仓 `CalendarBusy.swift` / `Permissions.swift`
的原始写法），用户会得到一句自信的「你这周没有任何日程」。**读路径必须硬判 `.fullAccess`。**

第二层：`node-mac-permissions@2.5.0` 的 `EventAuthStatus`（`permissions.mm`）只 switch 了
`Authorized / Denied / Restricted`，把 `WriteOnly(4)` 落进 `default:` 返回 `"not determined"`。
后果是「去授权」按钮**点了完全没反应**——`needsSettingsFallback` 只认 denied/restricted 故不命中，
于是走 `askForCalendarAccess("full")`，而 macOS 对已决策过的应用会立即 resolve 且不弹窗，
返回 `true` 让调用方以为已经弹过窗，连设置面板都不会打开。

**判据**：凡是要区分「能不能读日历」的地方，真源只能是 helper 侧的
`EKEventStore.authorizationStatus`（本仓经 `permissions` 命令的 `calendarAccess` 五态字段出），
不能用 node-mac-permissions，也不能用归一化后的三态。

**顺带的一条通用教训**：给能力做门控时，「未授权也注入、调用时报错引导」是错的。
Agent 会反复重试把整轮对话烧掉，而用户只看到「日历坏了」。授权引导是 UI 的职责，
门控就该是「不满足条件整包不注入」（同 `capabilities/computer-use/inject.ts` 的五门控）。
write-only 也要挡：只给写工具而没有读工具的日历 Agent 会盲写重复日程，比完全不给更糟。

## `Date.parse` 对「纯日期」和「日期时间」用两种时区基准

ES 规范里 `Date.parse("2026-08-04")` 按 **UTC** 解释，而 `Date.parse("2026-08-04T00:00")` 按
**本地时区**解释 —— 同一个函数两种基准，差值恰好是本机 UTC 偏移。

在 UTC+8 下，「查 8 月 4 日的日程」用 `Date.parse` 实现，实际查的是 8 月 3 日 08:00 起的窗口。
**它不报错**，只是让模型自信地报出错误答案，这类 bug 要等用户对着日历核对才会发现。

还有一条同源的坑：`new Date(2026, 12, 4)` 会**静默滚到 2027 年 1 月**，`new Date(2026, 1, 31)`
滚到 3 月。模型偶尔会给出 `"2026-13-04"` 这种月份，滚过去之后查到的是一整年后的时段。
Date 构造函数对越界分量既不抛错也不产生 NaN，必须显式判域（本仓 `capabilities/calendar/time.ts`
的 `partsInRange`：判范围 + 构造后回读比对，捕获 2 月 30 日这类「格式合法但不存在」的日期）。

**做法**：手写解析，并对每种形态显式定义语义（带偏移 → 按偏移；无偏移日期时间 → 本地；
纯日期 → 本地当日边界，start 取 00:00、end 取 23:59:59.999），配回归测试锁住
「纯日期 ≡ 显式写 T00:00」这条等式 —— 那条断言的唯一目的就是防止有人改回 `Date.parse`。

**跨进程边界一律传 epoch 毫秒**。ISO8601 在边界上有「有无 offset / 有无小数秒 / 是否 date-only」
三重歧义，两侧各写一遍解析器必然漂移。本仓 `native/Cortex_Helper` 没有 test target，
所以解析责任全部收在 TS 侧（有 vitest 覆盖），Swift 只做 `Date(timeIntervalSince1970:)`。

## `extendInfo` 只在打包时生效：dev 下验不了日历/语音识别这类需要用途描述的授权

**症状**：`pnpm dev:desktop` 下点权限中心的「去授权」，日历既不弹窗、也不出现在
系统设置 › 隐私与安全性 › 日历 的列表里，只是直接跳到了那个空列表。看起来像代码坏了。

**成因**：`electron-builder.yml` 的 `extendInfo`（`NSCalendarsUsageDescription` 等）是
**打包步骤**写进 `Cortex.app/Contents/Info.plist` 的。dev 模式的宿主是
`node_modules/electron/dist/Electron.app`，它自带的 plist 只有摄像头、麦克风、蓝牙那几条，
**没有**日历与语音识别。macOS TCC 的硬规则是缺用途描述就不弹窗，请求会被直接拒掉或抛错，
应用也不会被注册进授权列表。于是 `requestReplyPermissionAccess` 返回 false，
`openReplyPermissionSettings` 按设计回退去开设置面板 —— 全链路都"正常工作"，只是验不了。

**注意这与辅助功能/屏幕录制不同**。那两项在 dev 下能授权（会记在 Electron.app 名下），
因为它们走的是 `AXIsProcessTrustedWithOptions` / `CGRequestScreenCaptureAccess`，
不依赖 Info.plist 的用途描述。所以「dev 下授权会记在 Electron 名下」这句话对它们成立、
对日历不成立 —— 别把两者混为一谈。

**还有一层坑：`dist:dir` 也验不了。** 该脚本带 `-c.mac.identity=null`，产出的包是 adhoc 签名、
`Identifier=Electron`、TeamIdentifier 为空。TCC 按代码签名标识认应用，这个包在系统眼里
跟正式版 `ai.cortex.work` 不是同一个应用，授权记录不可靠。

**判据**：要验的权限是否依赖 `NS*UsageDescription`？
- 是（日历 / 语音识别 / 麦克风）→ 必须用**签名包**（`pnpm release:ui` 或 `local-release-mac.sh`），
  `dev` 与 `dist:dir` 都不行；
- 否（辅助功能 / 屏幕录制）→ dev 下可验，但授权归属 Electron.app，与正式版互相独立。

顺带：`dist:dir` 仍然能验「未授权时能力是否正确地完全不注入」这类门控行为 —— 那与签名无关。

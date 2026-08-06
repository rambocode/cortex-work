// pi-host Worker 的独立构建入口（纯 vite，不走 electron-vite）。
//
// 结构照 `electron.worker.config.ts`（research worker），但**外部化策略与它相反**，
// 这是本文件存在的全部理由，改之前务必读完下面三段。
//
// ── KTD4：三个 pi 包绝不 bundle ───────────────────────────────────────────────────────
// research worker 把「除 electron 与 node 内建之外的一切」都 bundle 进产物（`ssr.noExternal:true`），
// 因为它的依赖是普通 CJS/双格式包。pi 的三个包（`pi-coding-agent` / `pi-agent-core` / `pi-ai`）
// 是**纯 ESM**（`"type":"module"`，exports 只有 `import` 条件），bundle 进 CJS 产物正是
// CLAUDE.md 里记的那个历史大坑：整张 ESM 依赖闭包（glob/minimatch/undici/jiti/photon-node/
// highlight.js…）被内联进 CJS chunk，然后在 asar 里反复 `ERR_MODULE_NOT_FOUND` ——
// 当年就是因此被迫改用 bun 编译二进制的。
//
// 正确做法（2026-08-06 打包态实测已证）：三包 external + 运行时用**裸包名**动态 import。
// worker 落在 `app.asar.unpacked/out/worker/`，裸包名照样能解析到 asar 内的包，
// 不需要 unpack 三包，也不需要绝对路径 hack。加载点唯一：`main/agents/pi-inproc/runtime.ts`
//（specifier 是数组 join 出来的**变量** + `@vite-ignore`，打包器完全不参与）。
//
// 因此这里既 `ssr.noExternal: true`（把我们自己的 TS 源码与普通依赖 bundle 掉，让产物自包含），
// 又用 `rollupOptions.external` 把 `@earendil-works/*` 显式挡在外面——两者并存不矛盾：
// noExternal 决定「默认内联」，external 是更高优先级的白名单式豁免。
//
// ── 不得有 top-level await ────────────────────────────────────────────────────────────
// 产物是 CJS，rollup 对 CJS 输出的 TLA 直接**构建期**拒绝
//（`Module format "cjs" does not support top-level await`）。worker 目录与它复用的主进程
// 模块都必须把 await 封在 async 函数里。
//
// ── electron 被 alias 成会抛错的 stub ─────────────────────────────────────────────────
// 复用的主进程模块里有几条只在函数体内用 `app.getPath` 的死代码路径（binary 路径生成
// .js extension 用的），它们经 `pi-rpc.ts` 进依赖图。把 `electron` external 掉也能跑，
// 但误用时的报错是「undefined is not a function」，看不出是主进程 API。
// alias 成 stub 后：① 产物里没有任何 `require("electron")`；② 误用得到指名道姓的错误。
//
// ── main/log 与 main/ipc/agent-trace 被 alias 成 worker 侧实现 ─────────────────────────
// 前者顶层 `import "electron-log/main"` + `app.isPackaged`，后者顶层 `import { ipcMain }`，
// 且两者都被复用模块在**模块顶层**引用，不替换就整条加载不起来。
// 替身把日志/留痕转成协议消息发回主进程落盘（KTD2：worker 的 stdout 不连终端）。
//
// ── 与 research worker 共用 out/worker 目录 ───────────────────────────────────────────
// ⚠️ `emptyOutDir: false` 是**必须**的：`electron.worker.config.ts` 用的是 `true`，
// 两个配置写同一个 outDir，本配置若也清目录就会把先构建的 research worker 产物删掉。
// 构建顺序：先 `build:worker`（清目录），再 `build:pi-host`（追加）。
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

/** 需要在 worker 侧换实现的主进程模块（键 = 被替换的源文件绝对路径）。 */
const MODULE_SUBSTITUTIONS: ReadonlyArray<{ from: string; to: string; why: string }> = [
  {
    from: resolve("src/main/log/index.ts"),
    to: resolve("src/worker/pi-host/log.ts"),
    why: "electron-log/main 与 app.isPackaged 是主进程独有；worker 日志走 WorkerLog 协议消息",
  },
  {
    from: resolve("src/main/ipc/agent-trace.ts"),
    to: resolve("src/worker/pi-host/trace.ts"),
    why: "顶层 import ipcMain / 推 WebContents；worker 侧降级为结构化日志",
  },
];

/**
 * 模块替换插件。
 *
 * 为什么不用 `resolve.alias`：alias 的 `find` 匹配的是**导入字符串**，而复用模块里的写法
 * 有 `"../log"` / `"../../log"` / `"../../ipc/agent-trace"` 好几种相对形态，逐个列举既啰嗦
 * 又必然漏一个（漏掉的表现是打包成功、运行时才炸）。这里改成「先按正常规则解析，再看
 * 解析结果是不是那两个文件」，与写法无关，加一个新的复用模块也不用改这里。
 */
function substituteMainModules(): Plugin {
  return {
    name: "pi-host-substitute-main-modules",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer) return null;
      // skipSelf 防止无限递归：交给后续插件按原规则解析一次。
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const hit = MODULE_SUBSTITUTIONS.find((s) => s.from === resolved.id);
      return hit ? hit.to : null;
    },
  };
}

/**
 * `electron` 的替身。用 alias 而不是 external：external 会在产物里留下
 * `require("electron")`，而本目录的既定规则是「worker 不依赖 electron」。
 */
function stubElectron(): Plugin {
  const stub = resolve("src/worker/pi-host/electron-stub.ts");
  return {
    name: "pi-host-stub-electron",
    enforce: "pre",
    resolveId(source) {
      return source === "electron" ? stub : null;
    },
  };
}

export default defineConfig({
  plugins: [stubElectron(), substituteMainModules()],
  // `ssr: true` 默认把所有 node_modules 依赖判为 external，`rollupOptions.external` 只能**追加**
  // 外部化、无法反向强制内联。必须显式 noExternal 才能真正 bundle（research worker 踩过）。
  ssr: { noExternal: true },
  build: {
    outDir: "out/worker",
    // Electron 39 内嵌 Node 22.22.1。
    target: "node22",
    ssr: true,
    // 不压缩：worker 崩溃栈要能直接对上源码。pi 的 agent loop 就在这个进程里，可读栈是刚需。
    minify: false,
    reportCompressedSize: false,
    // ⚠️ 见文件头：与 research worker 共用 outDir，绝不能清。
    emptyOutDir: false,
    lib: {
      entry: resolve("src/worker/pi-host/index.ts"),
      formats: ["cjs"],
      fileName: () => "pi-host.js",
    },
    rollupOptions: {
      external: [
        // KTD4：三个 pi 包永远留在外面，运行时以裸包名动态 import。
        /^@earendil-works\//,
        ...builtinModules.flatMap((m) => [m, `node:${m}`]),
      ],
      output: {
        // `lib.fileName` 在 `build.ssr` 模式下不生效（产物会退回 index.js），必须显式指定；
        // 主进程侧的入口解析依赖这个确定的文件名。
        entryFileNames: "pi-host.js",
        // chunk 名带前缀：与 research worker 的 `chunks/[name]-[hash].js` 同目录，
        // 不加前缀时两边的同名 chunk 会看起来像同一个东西，排查产物时容易认错。
        chunkFileNames: "chunks/pi-host-[name]-[hash].js",
        // rollup 3+ 默认即 true，显式写出来是因为它是这条链路的命脉：
        // 为 false 时动态 `import()` 会被降级成 `require()`，纯 ESM 的 pi 包直接加载失败。
        dynamicImportInCjs: true,
      },
    },
  },
  resolve: {
    conditions: ["node"],
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
});

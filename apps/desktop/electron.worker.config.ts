// Research Worker 的独立构建入口（纯 vite，不走 electron-vite）。
//
// 为什么另起一份配置而不是给 electron.vite.config.ts 的 main 加多入口：
// 那个文件里有一条回归事故留下的警告——往 main 加 rollupOptions.input 会覆盖 electron-vite 的
// 单入口 lib 预设，导致 externalizeDepsPlugin 失效，把 nodemailer/electron-updater/MCP SDK
// 全打进 chunk。Worker 与 main 的外部化策略本来就不同（见下），没有理由共用一份配置。
//
// 与 main 的外部化策略差异（有意为之）：
// main 走 externalizeDepsPlugin，第三方依赖留在 node_modules 里由 Node 运行时 require；
// Worker 则把**除 electron 与 node 内建之外的一切都 bundle 进产物**。原因是 utilityProcess
// 起的子进程其模块解析根与 asar 打包边界都更脆弱，bundle 掉可以让 worker 产物自包含、
// 不依赖 asar 内的 node_modules 布局。代价是 pdfjs-dist 在 out/main 与 out/worker 里各一份
// （约 +8MB 未压缩），这是接受的取舍——换来 worker 与将来 Rust 版的协议对称。
//
// dev 注意：worker **不参与 HMR**。改了 src/worker/** 之后必须重跑 `pnpm build:worker`
// （或整个 `pnpm dev`）才会生效。
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // ⚠️ `ssr: true` 默认把所有 node_modules 依赖判为 external，`rollupOptions.external` 只能**追加**
  // 外部化、无法反向强制内联。必须显式 noExternal 才能真正 bundle。
  // 这条踩过：不加时 zod 变成运行期 require、pdfjs 的 dynamic import 被原样保留，而
  // electron-builder.yml 把 pdfjs-dist 整个排除出 asar（见其 files 段），打包后 PDF 抽取直接失败——
  // 且 dev 下一切正常、单测也测不到（loadPdfJs 是可注入依赖），只有打包态才暴露。
  ssr: { noExternal: true },
  build: {
    outDir: "out/worker",
    // Electron 39 内嵌 Node 22.22.1（U0 spike 实测），可安全用 node22 目标。
    target: "node22",
    ssr: true,
    // 不压缩：worker 崩溃栈要能直接对上源码，体积不是这里的瓶颈。
    minify: false,
    reportCompressedSize: false,
    emptyOutDir: true,
    lib: {
      entry: resolve("src/worker/research/index.ts"),
      formats: ["cjs"],
      fileName: () => "research-worker.js",
    },
    rollupOptions: {
      external: [
        "electron",
        /^electron\/.+/,
        ...builtinModules.flatMap((m) => [m, `node:${m}`]),
      ],
      output: {
        // lib.fileName 在 build.ssr 模式下不生效（产物会退回 index.js），必须显式指定；
        // entry-resolver 依赖这个确定的文件名定位 worker 入口。
        entryFileNames: "research-worker.js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
  resolve: {
    conditions: ["node"],
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
});

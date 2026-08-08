import { resolve } from "path";
import { createRequire } from "module";
import { copyFileSync, createReadStream, existsSync, mkdirSync } from "fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const configuredRendererPort = Number(process.env.DESKTOP_RENDERER_PORT);

// ── Silero VAD 静态资产(onnx 模型 / AudioWorklet / onnxruntime-web 的 wasm+mjs) ──
// dev 由下方内联插件以 /vad/<name> 同源服务;build 平铺拷进 out/renderer/vad/,打包态
// 进 asar 后经主进程 cortex-vad:// 协议供给(见 src/main/vad-assets.ts)。依赖声明在
// packages/views(消费方是 views 的语音助手控制器),desktop 不直接依赖它们,故经 views
// 的模块图定位真实文件路径(pnpm 隔离布局下不能裸 require.resolve)。
// 不用 vite-plugin-static-copy:它对仓库外绝对路径 src 会把 node_modules/.pnpm/... 的
// 完整目录结构复制进 dest(rename 也不生效),渲染端按 vad/<裸文件名> 请求即 404。
const viewsRequire = createRequire(resolve("../../packages/views/package.json"));
const vadWebDist = resolve(viewsRequire.resolve("@ricky0123/vad-web/package.json"), "../dist");
// onnxruntime-web 的 exports 不放行 ./package.json,只能解析主入口(落在 dist/ 内)再取目录。
const ortRequire = createRequire(viewsRequire.resolve("@ricky0123/vad-web/package.json"));
const ortDist = resolve(ortRequire.resolve("onnxruntime-web"), "..");

const VAD_ASSETS: Record<string, { src: string; mime: string }> = {
  "silero_vad_v5.onnx": { src: `${vadWebDist}/silero_vad_v5.onnx`, mime: "application/octet-stream" },
  "vad.worklet.bundle.min.js": { src: `${vadWebDist}/vad.worklet.bundle.min.js`, mime: "text/javascript" },
  "ort-wasm-simd-threaded.wasm": { src: `${ortDist}/ort-wasm-simd-threaded.wasm`, mime: "application/wasm" },
  "ort-wasm-simd-threaded.mjs": { src: `${ortDist}/ort-wasm-simd-threaded.mjs`, mime: "text/javascript" },
};

/** dev 服务 + build 平铺拷贝 VAD 资产的内联插件(仅挂 renderer 构建)。 */
function vadAssetsPlugin(): Plugin {
  return {
    name: "cortex-vad-assets",
    configureServer(server) {
      server.middlewares.use("/vad", (req, res, next) => {
        const name = decodeURIComponent((req.url ?? "").replace(/^\/+/, "").split("?")[0] ?? "");
        const asset = VAD_ASSETS[name];
        if (!asset) return next();
        res.setHeader("content-type", asset.mime);
        createReadStream(asset.src).pipe(res);
      });
    },
    closeBundle() {
      const dest = resolve("out/renderer/vad");
      mkdirSync(dest, { recursive: true });
      for (const [name, asset] of Object.entries(VAD_ASSETS)) {
        copyFileSync(asset.src, resolve(dest, name));
      }
    },
  };
}

// ── 唤醒词(openWakeWord) ONNX 模型 ──
// 由 scripts/prepare-kws-models.mjs 下载到 resources/kws/(gitignored,SHA-256 固定);
// dev 以 /kws/<name> 同源服务,build 平铺拷进 out/renderer/kws/,打包态经 cortex-kws://
// 供给(见 src/main/kws-assets.ts)。模型缺失只警告不阻断:唤醒词是可选功能,
// 运行时 kws 窗口 fetch 404 会上报 degraded 而非拖垮构建。
const KWS_MODEL_DIR = resolve("resources/kws");
const KWS_MODELS = ["melspectrogram.onnx", "embedding_model.onnx", "hey_jarvis_v0.1.onnx"];

/** dev 服务 + build 平铺拷贝唤醒词模型的内联插件(仅挂 renderer 构建)。 */
function kwsAssetsPlugin(): Plugin {
  return {
    name: "cortex-kws-assets",
    configureServer(server) {
      server.middlewares.use("/kws", (req, res, next) => {
        const name = decodeURIComponent((req.url ?? "").replace(/^\/+/, "").split("?")[0] ?? "");
        const src = resolve(KWS_MODEL_DIR, name);
        if (!KWS_MODELS.includes(name) || !existsSync(src)) return next();
        res.setHeader("content-type", "application/octet-stream");
        createReadStream(src).pipe(res);
      });
    },
    closeBundle() {
      const dest = resolve("out/renderer/kws");
      mkdirSync(dest, { recursive: true });
      for (const name of KWS_MODELS) {
        const src = resolve(KWS_MODEL_DIR, name);
        if (!existsSync(src)) {
          console.warn(`[cortex-kws-assets] 缺少 ${name}，先运行 node scripts/prepare-kws-models.mjs（唤醒词将不可用）`);
          continue;
        }
        copyFileSync(src, resolve(dest, name));
      }
    },
  };
}

export default defineConfig({
  main: {
    // @cortex-work/core 以原生 .ts 发布,Node 无法直接执行 → 须打包进 main chunk
    //（仅用到零 react 的 i18n/native:托盘/locale 扇出文案）。
    // 注意:勿在此加多入口 rollupOptions —— 会覆盖 electron-vite 单入口 lib 预设,使
    // externalizeDepsPlugin 失效、把 nodemailer/electron-updater/MCP SDK 等全打进 chunk(回归)。
    // 文档抽取(doc-extract)在主进程内跑 @firecrawl/anydoc(externalize + asarUnpack,原生 .node),
    // 不另起 worker 构建入口;进程隔离(utilityProcess/fork)待打包验证后于二期再做。
    // node-mac-permissions 是 optionalDependencies（Windows 不安装），插件默认只读取
    // dependencies；显式 include 才能让 Windows 构建保留动态 import、运行时走非 mac 短路。
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@cortex-work/core"],
        include: ["node-mac-permissions"],
      }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 多入口模式下 electron-vite 不再走单入口 lib 预设,会丢失对 electron 的自动外部化
        // → 把 electron 包的 path-shim 误打进 chunk,使 ipcRenderer/contextBridge 变 undefined、
        // desktopAPI 注入失败(渲染端兜底「仅桌面端可用」)。故显式外部化 electron(node 内建由插件兜底)。
        external: ["electron"],
        // 显式声明多入口后 electron-vite 不再自动探测 index.ts,故须同时列出 index
        // (否则所有窗口丢失 preload)。annotation = webview 受控标注 preload(计划 U4)。
        input: {
          index: resolve("src/preload/index.ts"),
          annotation: resolve("src/preload/annotation.ts"),
        },
        // 强制 CJS + .js 扩展:① 现网 main 以 ../preload/index.js 引用(默认单入口本是 CJS .js,
        // 多入口若不指定会变 .mjs 破坏引用);② webview 沙箱 preload 必须 CJS(annotation.js)。
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
        },
      },
    },
  },
  renderer: {
    server: {
      port: Number.isFinite(configuredRendererPort) ? configuredRendererPort : 0,
      strictPort: false,
    },
    plugins: [react(), tailwindcss(), vadAssetsPlugin(), kwsAssetsPlugin()],
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
      },
      dedupe: ["react", "react-dom"],
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve("src/renderer/index.html"),
          spotlight: resolve("src/renderer/spotlight.html"),
          notes: resolve("src/renderer/notes.html"),
          agentTrace: resolve("src/renderer/agent-trace.html"),
          notification: resolve("src/renderer/notification.html"),
          projects: resolve("src/renderer/projects.html"),
          reply: resolve("src/renderer/reply.html"),
          dictation: resolve("src/renderer/dictation.html"),
          petOverlay: resolve("src/renderer/pet-overlay.html"),
          kws: resolve("src/renderer/kws.html"),
        },
      },
    },
  },
});

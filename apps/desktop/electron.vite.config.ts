import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const configuredRendererPort = Number(process.env.DESKTOP_RENDERER_PORT);

export default defineConfig({
  main: {
    // @cortex-work/core 以原生 .ts 发布,Node 无法直接执行 → 须打包进 main chunk
    //（仅用到零 react 的 i18n/native:托盘/locale 扇出文案）。
    // 注意:勿在此加多入口 rollupOptions —— 会覆盖 electron-vite 单入口 lib 预设,使
    // externalizeDepsPlugin 失效、把 nodemailer/electron-updater/MCP SDK 等全打进 chunk(回归)。
    // 文档抽取(doc-extract)在主进程内跑 officeParser(externalize + asarUnpack,wasm 完整),
    // 不另起 worker 构建入口;进程隔离(utilityProcess/fork)待打包验证后于二期再做。
    plugins: [externalizeDepsPlugin({ exclude: ["@cortex-work/core"] })],
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
    plugins: [react(), tailwindcss()],
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
          petOverlay: resolve("src/renderer/pet-overlay.html"),
        },
      },
    },
  },
});

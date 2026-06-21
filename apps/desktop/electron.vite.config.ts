import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const configuredRendererPort = Number(process.env.DESKTOP_RENDERER_PORT);

export default defineConfig({
  main: {
    // @cortex-work/core 以原生 .ts 发布,Node 无法直接执行 → 须打包进 main chunk
    //（仅用到零 react 的 i18n/native:托盘/locale 扇出文案）。
    plugins: [externalizeDepsPlugin({ exclude: ["@cortex-work/core"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
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
        },
      },
    },
  },
});

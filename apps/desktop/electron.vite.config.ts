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

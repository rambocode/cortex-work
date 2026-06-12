import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // monaco-editor 只有 "module" 入口（无 "main"）,vitest 的 node 解析找不到;
    // 指到 esm 真实文件。测试本身不会执行 Monaco（动态 import 在 useEffect 内）。
    alias: {
      "monaco-editor": "monaco-editor/esm/vs/editor/editor.api.js",
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
  },
});

import reactConfig from "@cortex-work/eslint-config/react";

export default [
  ...reactConfig,
  // 构建产物不参与 lint。resources/ 含 pi 的 bun 二进制 + 旁置资产(第三方压缩 JS 等)。
  // dist.bak-<时间戳>/ 是发版前手工备份的 dist 快照——`dist/` 这条匹配不到带后缀的目录名,漏掉它
  // 会把备份里的 vendor JS(marked.min.js 等)全扫进来,实测刷出 1200+ 条 error 淹没真实问题。
  // .pi-build-cache/ 是 pi 编译产物缓存(与 resources/pi 同源),同样不参与 lint。
  { ignores: ["out/", "dist/", "dist.bak-*/", "resources/", ".pi-build-cache/"] },
  // 构建脚本跑在 Node 上,补 node globals(reactConfig 默认按浏览器/源码环境)。
  {
    files: ["scripts/**/*.{mjs,js}"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        URL: "readonly",
        __dirname: "readonly",
      },
    },
  },
  // .cjs 构建脚本(如 before-pack.cjs,electron-builder 以 require() 加载 beforePack)走
  // CommonJS:补 require/module/exports 及 node globals,sourceType=commonjs。
  {
    files: ["scripts/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        exports: "writable",
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        URL: "readonly",
        __dirname: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

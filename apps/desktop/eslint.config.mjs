import reactConfig from "@cortex-work/eslint-config/react";

export default [
  ...reactConfig,
  // 构建产物不参与 lint。resources/ 含 pi 的 bun 二进制 + 旁置资产(第三方压缩 JS 等)。
  { ignores: ["out/", "dist/", "resources/"] },
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

import baseConfig from "./base.js";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import i18nextPlugin from "eslint-plugin-i18next";

// 用户可见硬编码文案防回归(i18n R9/R10）。迁移期全局 warn(非阻断,暴露待提取面);
// 提取单元(U6-U12)按目录 overrides 升 error 做棘轮,U13 全局转 error。
// jsx-only:校验 JSX 文本 + 用户可见属性(label/placeholder/title/aria-label),
// 排除 className/style 等非文案属性以降误报。
const i18nLiteralRule = [
  "warn",
  {
    framework: "react",
    mode: "jsx-only",
    "jsx-attributes": {
      exclude: [
        "className",
        "class",
        "style",
        "id",
        "key",
        "type",
        "name",
        "htmlFor",
        "href",
        "src",
        "rel",
        "target",
        "role",
        "width",
        "height",
        "viewBox",
        "fill",
        "stroke",
        "autoComplete",
        "autoCapitalize",
        "spellCheck",
        "inputMode",
        "tabIndex",
      ],
    },
    callees: { exclude: ["t", "i18n.t"] },
  },
];

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...baseConfig,
  {
    files: ["**/*.{jsx,tsx}"],
    plugins: { react: reactPlugin },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs["jsx-runtime"].rules,
      "react/prop-types": "off",
      "react/no-unknown-property": "off",
    },
    settings: {
      react: { version: "detect" },
    },
  },
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    plugins: { "react-hooks": reactHooksPlugin },
    rules: {
      ...reactHooksPlugin.configs["recommended-latest"].rules,
    },
  },
  {
    files: ["**/*.{tsx,jsx}"],
    plugins: { i18next: i18nextPlugin },
    rules: {
      "i18next/no-literal-string": i18nLiteralRule,
    },
  },
];

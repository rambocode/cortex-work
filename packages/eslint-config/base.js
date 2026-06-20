import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import { maxLinesRule, maxLinesOverrides } from "./rules.js";

/** @type {import("eslint").Linter.Config[]} */
export default [
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Already enforced by TypeScript compiler (noUnusedLocals/noUnusedParameters)
      "@typescript-eslint/no-unused-vars": "off",
      // Allow explicit any where needed
      "@typescript-eslint/no-explicit-any": "off",
      // 单文件行数上限（详见 CLAUDE.md 代码质量约束）
      ...maxLinesRule,
    },
  },
  maxLinesOverrides,
  {
    ignores: ["node_modules/", "dist/", ".next/", "out/"],
  },
];

// 全仓共享的自定义规则片段，被 base.js / react.js（及经 base 的 next.js）复用，
// 保证各包对同一约束的口径一致。新增跨预设的规则统一写在这里。

/**
 * 单文件行数上限：与 CLAUDE.md「代码质量约束」中的 1200 行约定保持一致。
 * - 设为 warn：不阻断构建，仅提示拆分（逼近上限时按职责拆组件 / hook / 工具函数）。
 * - skipBlankLines / skipComments：只统计有效代码行，注释与空行不计入。
 * 测试与生成文件在下方 maxLinesOverrides 中豁免。
 */
export const maxLinesRule = {
  "max-lines": [
    "warn",
    { max: 1200, skipBlankLines: true, skipComments: true },
  ],
};

/**
 * 行数上限豁免：测试文件天然偏长（用例 + fixture），自动生成 / 声明文件不受人工约束。
 * 放在共享数组里，保证 base 与 react 预设的豁免范围一致。
 */
export const maxLinesOverrides = {
  files: ["**/*.test.{ts,tsx}", "**/*.d.ts", "**/*.gen.{ts,tsx}"],
  rules: {
    "max-lines": "off",
  },
};

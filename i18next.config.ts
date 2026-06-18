import { defineConfig } from "i18next-cli";

// i18next-cli:从 t() / <Trans> 调用提取 key 到命名空间 JSON,并生成 key 类型。
// zh-Hans 为源(primaryLanguage):提取时把代码里的默认值写入 zh;en 留待翻译。
// 命名空间随提取单元增长(common/settings/chat/notes/files/timeline/pet/...)。
export default defineConfig({
  locales: ["zh-Hans", "en"],
  extract: {
    input: [
      "packages/views/**/*.{ts,tsx}",
      "packages/core/**/*.{ts,tsx}",
      "apps/**/*.{ts,tsx}",
    ],
    ignore: ["**/*.test.{ts,tsx}", "**/node_modules/**", "**/dist/**", "**/.next/**"],
    output: "packages/core/i18n/resources/{{language}}/{{namespace}}.json",
    defaultNS: "common",
    primaryLanguage: "zh-Hans",
    // 迁移期不剪未引用 key:各命名空间分单元逐步迁移,避免 extract 误删未迁移区的 key
    // 或种子 key。U13 收口时再翻 true 清理残留。
    removeUnusedKeys: false,
  },
  types: {
    // 生成的 key 类型增强落在 core 内(随各单元 `pnpm i18n:types` 重新生成,R4/R11)。
    output: "packages/core/i18n/@types/i18next.d.ts",
    resourcesFile: "packages/core/i18n/@types/resources.d.ts",
  },
});

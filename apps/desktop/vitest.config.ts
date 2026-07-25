// desktop 的默认测试配置。
//
// 在此之前 apps/desktop 是**零配置**跑 vitest 的（package.json 只有 "test": "vitest run"）。
// 引入本文件的唯一目的是把真 SQLite 集成测试排除出默认轮次：`node:sqlite` 只存在于 Electron
// 内嵌的 Node 22，而仓库日常跑测试用的系统 Node 是 20，直接跑会全红。
//
// 因此测试分成两轮：
//   pnpm test        → 本配置，系统 Node，排除 *.sqlite.test.ts（行为与改动前一致）
//   pnpm test:sqlite → vitest.sqlite.config.ts，ELECTRON_RUN_AS_NODE=1 electron 跑真 SQLite
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 保留 vitest 的默认排除项（node_modules/dist/...），只在其后追加 SQLite 专轮。
    exclude: [...configDefaults.exclude, "**/*.sqlite.test.ts", "out/**"],
  },
});

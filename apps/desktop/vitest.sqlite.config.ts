// 真 SQLite 集成测试的专用配置。
//
// 只跑 `*.sqlite.test.ts`，必须经 `ELECTRON_RUN_AS_NODE=1 electron` 启动（见 package.json 的
// test:sqlite 脚本），因为 `node:sqlite` 只存在于 Electron 39 内嵌的 Node 22，系统 Node 20 没有。
// U0 spike 已实测 vitest 4.1.7 能在 ELECTRON_RUN_AS_NODE 下正常运行。
//
// 这一轮里 ResearchRepository 直接吃真 driver（`:memory:` 数据库），验证的是迁移、外键、
// 事务回滚、启动恢复这些「假实现证明不了」的性质。上层编排的测试不在这里，它们注入
// InMemoryResearchRepository，在默认轮次里跑。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.sqlite.test.ts"],
    exclude: ["**/node_modules/**", "dist/**", "out/**"],
    // 真 SQLite 用的是同一个进程内的同步连接，并行 worker 会争抢临时文件；串行更稳且这轮很小。
    fileParallelism: false,
  },
});

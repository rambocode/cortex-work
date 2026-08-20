import { app } from "electron";
import { installGlobalCrashGuards } from "./crash-guards";
import { registerAppSchemes } from "./protocol-schemes";

// 进程级崩溃兜底与特权协议注册必须在 app.ready 之前完成；两者保持在极薄入口中，
// 完整业务 runtime 则动态加载，避免 1MB+ 主进程依赖阻塞第一个可见窗口。
installGlobalCrashGuards();
registerAppSchemes();

const benchmarkUserData = process.env["CORTEX_STARTUP_BENCHMARK_USER_DATA"];
if (benchmarkUserData) app.setPath("userData", benchmarkUserData);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 入口只持有单实例锁和 app.ready 前协议注册；完整主窗口由 runtime 直接创建，不插入启动页。
  process.env["CORTEX_SINGLE_INSTANCE_LOCK_ACQUIRED"] = "1";
  void import("./runtime");
}

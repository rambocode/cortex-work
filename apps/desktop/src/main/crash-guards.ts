// 主进程进程级崩溃兜底。
//
// 背景(为什么需要):线上崩溃报告显示主进程在一次异步 fs.readdir(scandir) 的完成
// 回调续体里抛出未捕获错误 → V8 fatal abort → 整个主进程被 SIGTRAP(EXC_BREAKPOINT)
// 杀死。根因是「主进程从未安装任何 process 级错误兜底」:Node/Electron 默认对
// uncaughtException 与(15+ 默认 throw 模式下的)unhandledRejection 都是「打印并退出」。
//
// 关键边界:ipcMain.handle 链内的 reject 由 Electron 自行捕获并转发给渲染端(invoke
// 拒绝),不会冒泡到这里;能到达本兜底的,都是「没人接」的漂浮异常/拒绝(如未 await 的
// fire-and-forget async、缺 .catch 的定时器回调等)——这正是本兜底要覆盖的那一类。
//
// 取舍:这里 log-and-survive(只记日志、不退出)。对桌面应用而言,某次后台扫描回调抛错
// 远不该拖垮整个 App;绝大多数此类错误是可恢复的业务错误。代价是极端情况下(真正的状态
// 损坏)会带病运行——长期解法是给具体调用点做局部兜底,并保留 crashpad 符号化以便定位到
// 具体 JS 帧,而非依赖本进程级网兜。

import { app } from "electron";

export interface CrashGuardLogger {
  error: (...args: unknown[]) => void;
}

// 幂等标志:重复安装会泄漏监听器(process / app 都是长生命周期 EventEmitter)。
let installed = false;

// 安装进程级崩溃兜底。须在主进程最早期调用(任何异步初始化之前)。
// logger 默认用全局 console;index 在 patchConsole() 后,console.error 会写入文件日志,
// 因此即便本函数在 patchConsole 之前安装,错误发生时仍走已打补丁的 console(惰性查找)。
export function installGlobalCrashGuards(logger: CrashGuardLogger = console): void {
  if (installed) return;
  installed = true;

  process.on("uncaughtException", (err: Error, origin: string) => {
    logger.error(`[main] uncaughtException (${origin})`, err?.stack ?? err);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("[main] unhandledRejection", (reason as Error)?.stack ?? reason);
  });

  // 渲染进程 / 子进程崩溃只记日志便于区分崩溃来源(主 vs 渲染),不在此重启——
  // 各窗口/子进程的重建交由既有逻辑,这里只保证不静默白屏、有据可查。
  app.on("render-process-gone", (_event, _webContents, details) => {
    logger.error("[main] render-process-gone", details);
  });
  app.on("child-process-gone", (_event, details) => {
    logger.error("[main] child-process-gone", details);
  });
}

// 仅供单测重置已安装标志,避免跨用例串状态。生产代码不要调用。
export function __resetCrashGuardsForTests(): void {
  installed = false;
}

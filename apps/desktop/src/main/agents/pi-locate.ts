// pi CLI 入口定位。pi 经 Electron utilityProcess.fork 跑（见 cli.ts startAgentProcess），
// 这里给出的 cli.js 绝对路径即 fork 的 modulePath（utilityProcess 用 Electron 内置 Node，
// 不创建 GUI、不在 macOS Dock 上闪现）。
//
// ⚠️ 不能用 require.resolve("@earendil-works/pi-coding-agent")：该包 package.json 的
//    exports 只声明了 import 条件（ESM），主进程是 CJS 上下文，CJS resolve 会抛
//    ERR_PACKAGE_PATH_NOT_EXPORTED。故直接按目录结构 join 到 dist/cli.js。

import { app } from "electron";
import { join } from "path";

export function resolvePiCliEntry(): string {
  const entry = join(app.getAppPath(), "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  // 打包后 utilityProcess 的 modulePath 须是磁盘真实文件,electron-builder.yml 已把
  // 该包 asarUnpack 到 app.asar.unpacked,这里把路径同步切过去。
  return app.isPackaged ? entry.replace("app.asar", "app.asar.unpacked") : entry;
}

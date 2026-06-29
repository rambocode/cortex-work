// pi CLI 定位。pi 已用 bun 编译成自包含单二进制（见 apps/desktop/scripts/build-pi-binary.mjs）,
// 由 cli.ts 经 child_process.spawn 直接执行。二进制把整个依赖闭包 inline,不依赖 node_modules
// 解析,从根上免疫 minimatch/typebox/undici 这类「依赖在 asar 里解析不到」的问题。
//
// 二进制 + 旁置资产（theme/assets/export-html/wasm）产出在 apps/desktop/resources/pi/,
// 打包时经 electron-builder 的 extraResources 落到 <App>/Contents/Resources/pi/。

import { app } from "electron";
import { join } from "path";

export function resolvePiBinary(): string {
  const bin = process.platform === "win32" ? "pi.exe" : "pi";
  // 打包态:extraResources 把 resources/pi 落到 Contents/Resources/pi（mac）或 resources/pi（win）。
  if (app.isPackaged) {
    return join(process.resourcesPath, "pi", bin);
  }
  // dev 态:electron-vite 的 app.getAppPath() = apps/desktop,二进制由 build-pi-binary.mjs 生成。
  return join(app.getAppPath(), "resources", "pi", bin);
}

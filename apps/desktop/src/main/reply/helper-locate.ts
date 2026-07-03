// reply-helper 伴生二进制定位。仿 agents/pi-locate.ts 的 dev/打包双路径:
// helper 由 scripts/build-reply-helper.mjs 用 `swift build -c release` 编成单个原生可执行文件,
// 产出到 apps/desktop/resources/reply-helper/reply-helper,打包时经 electron-builder 的
// extraResources 落到 <App>/Contents/Resources/reply-helper/(见 electron-builder.yml)。
// 主进程 helper-client 经 child_process.spawn 直接执行它。
//
// 平台:reply 功能是 macOS 专属(AX / CGEventTap / Vision / EventKit);非 mac 平台不 spawn
// helper(守卫在 U7 接线侧),本函数仍可被调用但返回的路径在非 mac 上不存在。

import { app } from "electron";
import { join } from "path";

/** reply-helper 可执行文件绝对路径(dev = 源码树 resources;打包态 = Contents/Resources)。 */
export function resolveReplyHelperBinary(): string {
  const binName = "reply-helper";
  // 打包态:extraResources 把 resources/reply-helper 落到 Contents/Resources/reply-helper。
  if (app.isPackaged) {
    return join(process.resourcesPath, "reply-helper", binName);
  }
  // dev 态:app.getAppPath() = apps/desktop,二进制由 build-reply-helper.mjs 生成到 resources/。
  return join(app.getAppPath(), "resources", "reply-helper", binName);
}

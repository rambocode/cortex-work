// 内嵌浏览器会话分区(persist:browser-panel)的配置:权限 deny-by-default、下载控制、
// 数据清理。第三方公网内容的会话与宿主应用隔离(独立 partition),且对敏感能力默认全拒
// (见计划 KTD2)。

import { session } from "electron";
import { BROWSER_PARTITION } from "./webviewGuards";

function browserSession() {
  return session.fromPartition(BROWSER_PARTITION);
}

// 启动时配置一次。deny-by-default:摄像头/麦克风/剪贴板/通知/地理位置等一律拒,
// 后续如需放开再按 origin 白名单。下载默认拦截(承载任意公网内容,防 drive-by download)。
export function configureBrowserPartition(): void {
  const ses = browserSession();

  // 运行时权限请求(弹窗类):默认全拒。
  ses.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  // 静态权限检查(getUserMedia 等先走 check):同样默认拒绝。
  ses.setPermissionCheckHandler(() => false);

  // 下载:默认取消。承载任意公网内容时,自动落盘可执行文件是真实攻击面;
  // 后续如需放开,改为弹用户确认 + 限定目录。
  ses.on("will-download", (event) => {
    event.preventDefault();
  });
}

// 「清除浏览数据」:清空该 partition 的 cookie/缓存/localStorage 等。
export async function clearBrowserData(): Promise<void> {
  await browserSession().clearStorageData();
}

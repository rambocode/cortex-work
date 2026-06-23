// 浏览器面板 guest WebContents 注册表(U4)。主进程持有当前 persist:browser-panel 面板的 guest 引用,
// 供浏览器控制工具(U5)与 CDP(U7)直接驱动(KTD2:主进程直驱 guest,不绕渲染端)。
// 单面板:只记当前一个。webviewGuards 在 web-contents-created 登记;webview 重挂 → 新 guest 覆盖;
// 销毁 → 清(关竞态:对已销毁 WebContents 调用会同步抛错)。
import type { WebContents } from "electron";

let currentGuest: WebContents | null = null;

// 控制台缓冲(供 readConsole 工具 U5):有界环形,新面板/重挂时清。
const CONSOLE_MAX = 200;
let consoleBuf: { level: number; message: string }[] = [];

export function readConsoleBuffer(): { level: number; message: string }[] {
  return [...consoleBuf];
}

// 登记当前面板 guest(webview 重挂时覆盖旧引用)+ 接控制台捕获。
export function setGuest(wc: WebContents): void {
  currentGuest = wc;
  consoleBuf = [];
  // Electron 39 console-message:运行时回调 (event, MessageDetails){level 0–3, message}。
  // d.ts 重载可能仍把第二参推断为旧版 level:number,故 cast(运行时取对象字段正确)。
  wc.on("console-message", (_event, details) => {
    const d = details as unknown as { level: number; message: string };
    consoleBuf.push({ level: d.level, message: d.message });
    if (consoleBuf.length > CONSOLE_MAX) consoleBuf.shift();
  });
}

// 清除:仅当被清的正是当前记录引用时才清——避免旧 guest 的 destroyed 事件清掉已重挂的新引用。
export function clearGuestIf(wc: WebContents): void {
  if (currentGuest === wc) currentGuest = null;
}

// 取存活的 guest:null = 无面板 / 已销毁。同步复检 isDestroyed,关「destroyed 事件异步到达前
// 引用已不可用」的竞态窗口。工具 handler 取引用后须用本函数(而非裸引用)。
export function getLiveGuest(): WebContents | null {
  if (currentGuest && currentGuest.isDestroyed()) currentGuest = null;
  return currentGuest;
}

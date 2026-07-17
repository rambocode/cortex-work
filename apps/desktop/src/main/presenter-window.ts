// Slides 演示窗口(独立全屏第二窗口):把 buildPresenterHtml 生成的自包含演示
// HTML 写入临时文件后 loadFile 播放。键盘导航/备注/缩放全部由 presenter HTML 自带的
// 运行时提供(它是宿主无关的导出产物,本模块不改它、也不注入 preload/bridge)。
//
// 契约:
//  - 单例:重复播放 = 销毁旧窗口重建(deck 内容/起始页可能已变),不是聚焦复用。
//  - 起始页经 URL hash(#N,1 基)传给 presenter 运行时,它初始化即读 location.hash。
//  - Esc 关闭走主进程 before-input-event 拦截 —— 不往 presenter HTML 里塞
//    window.close(),避免污染同一份导出产物。
import { app, BrowserWindow } from "electron";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { buildPresenterHtml, type PresenterSlide } from "./capabilities/slides/export/html";
import { createLogger } from "./log";

const log = createLogger("slides");

let win: BrowserWindow | null = null;

/** 打开演示窗口:全屏播放整套 ready 页,从 startIndex(0 基)起播。 */
export async function openPresenterWindow(options: {
  title: string;
  slides: PresenterSlide[];
  startIndex: number;
}): Promise<void> {
  // 旧窗口先销毁(其 closed 回调清理各自的临时目录):内容可能已变,重建不串台。
  destroyPresenterWindow();

  const html = buildPresenterHtml({ title: options.title, slides: options.slides });
  // mkdtemp 防并发/重名。目录由本窗口的 closed 回调闭包持有并清理 —— 不放模块级变量,
  // 否则旧窗口异步 closed 可能误删新窗口刚建的目录。
  const tmpDir = await fsp.mkdtemp(join(app.getPath("temp"), "cortex-present-"));
  const file = join(tmpDir, "presenter.html");
  await fsp.writeFile(file, html, "utf8");
  // best-effort:失败静默,OS temp 兜底回收。
  const cleanup = (): void => void fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  const current = new BrowserWindow({
    fullscreen: true,
    show: false,
    autoHideMenuBar: true,
    // 与 presenter body 底色一致,避免全屏切换时白闪。
    backgroundColor: "#0b0d12",
    webPreferences: {
      // 纯静态本地 HTML:无 preload、无 Node、开沙箱,不暴露任何桌面能力。
      sandbox: true,
      contextIsolation: true,
    },
  });
  win = current;

  // Esc 退出演示(presenter 运行时自身不处理 Esc;全屏态下 Esc 也可能先退全屏,
  // 这里统一拦成关窗,行为与 Keynote 一致)。
  current.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") current.close();
  });
  current.once("ready-to-show", () => current.show());
  current.on("closed", () => {
    // 仅当自己仍是当前窗口时清空模块引用(重建场景下 win 已指向新窗口)。
    if (win === current) win = null;
    cleanup();
  });

  // hash = 起始页序号(1 基),presenter 初始化读 location.hash 定位。
  try {
    await current.loadFile(file, { hash: String(options.startIndex + 1) });
  } catch (err) {
    log.warn(`[present] loadFile failed: ${String(err)}`);
    destroyPresenterWindow();
    throw err;
  }
}

/** 销毁演示窗口(若存在);幂等。临时目录清理由窗口自身的 closed 回调负责。 */
export function destroyPresenterWindow(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

/** 测试/调试用:当前演示窗口(已销毁视为 null)。 */
export function getPresenterWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

// re-export 供 handler/测试引用同一类型,避免出现第二个 PresenterSlide 形状。
export type { PresenterSlide };

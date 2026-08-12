// 写作禅模式 IPC(对齐 Metion 的禅模式形态):
//   1. 幕布窗口 —— 写作主窗口保持原尺寸悬浮,主进程在其身后垫一层铺满当前显示器的无边框背景窗口,
//      显示真实背景照片,遮住桌面与其它程序界面;不把主窗口打成 OS 全屏。
//   2. 资产服务 —— 背景照片(resources/zen/backgrounds/*.jpg)与环境音(resources/zen/sounds/*.mp3,
//      均取自 Metion 的 zen 资源)按 id(文件名去后缀)枚举/取数,渲染端不接触绝对路径。
//
// 层序做法:幕布 showInactive(不抢焦点)后立刻把发起窗口 moveTop(),两窗同属本 app 的普通层级,
// 本 app 处于前台时其它程序的窗口都在幕布之下;幕布 focusable:false 且**不做**点击穿透 ——
// 点到幕布的点击被它吞掉,不会把身后其它程序的窗口带到前面。
// 菜单栏/Dock:幕布用 macOS「simple fullscreen」(pre-Lion 全屏)——不切换 Space、无动画,
// 但会把 app 级 presentationOptions 置为自动隐藏菜单栏与 Dock(鼠标顶/底边悬停才浮现),
// 写作窗口保持普通窗口浮在幕布上,即达成「屏幕上只有背景 + 写作窗口」。退出时必须
// setSimpleFullScreen(false) 还原 presentationOptions 再销毁,否则菜单栏/Dock 会一直藏着。
// 绿灯:禅模式下窗口全屏无意义,进入时对写作窗口 setFullScreenable(false)(绿灯置灰),退出还原。
// 已知限制:多显示器只遮写作窗口所在的那块屏。

import { BrowserWindow, app, ipcMain, screen } from "electron";
import { existsSync, promises as fsp } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 幕布单例:全局最多一张(禅模式同刻只有一个写作窗口在用)。
let backdropWin: BrowserWindow | null = null;
// 幕布随其发起窗口关闭而销毁的解绑函数(重复 show 时先解旧绑)。
let detachParentClose: (() => void) | null = null;
// 发起窗口引用:退出禅模式时还原 fullscreenable(绿灯)。
let backdropParent: BrowserWindow | null = null;

// zen 资产根:打包态 <App>/Contents/Resources/zen(electron-builder extraResources),
// 开发态回落仓库 apps/desktop/resources/zen。与 slides 模板的定位范式一致。
function zenAssetsRoot(): string {
  const packaged = join(process.resourcesPath ?? "", "zen");
  if (process.resourcesPath && existsSync(packaged)) return packaged;
  return join(app.getAppPath(), "resources", "zen");
}

// 枚举目录里指定扩展名的文件 id(文件名去后缀,排序稳定);目录缺失回空表(资产未随包)。
// (导出仅供单测:对真实 resources/zen 目录验证枚举与防穿越,不经 electron。)
export async function listAssetIds(dir: string, exts: string[]): Promise<string[]> {
  try {
    const names = await fsp.readdir(dir);
    return names
      .filter((n) => exts.some((e) => n.toLowerCase().endsWith(e)))
      .map((n) => n.replace(/\.[^.]+$/, ""))
      .sort();
  } catch {
    return [];
  }
}

// 按 id 找回文件绝对路径:只做 basename 拼接 + 存在性校验,id 含路径分隔符一律拒绝(防目录穿越)。
export async function assetPathById(dir: string, id: string, exts: string[]): Promise<string | null> {
  if (!id || /[/\\]/.test(id)) return null;
  for (const ext of exts) {
    const p = join(dir, `${id}${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

const BG_EXTS = [".jpg", ".jpeg", ".png"];
const SOUND_EXTS = [".mp3", ".m4a"];

// 幕布 HTML:铺满显示背景照片。写到系统临时目录再 loadFile —— 幕布必须是 file:// origin,
// 否则(data: origin)加载 file:// 图片子资源会被 webSecurity 拦下。
async function writeBackdropHtml(imageFileUrl: string): Promise<string> {
  const html =
    `<!doctype html><html><head><meta charset="utf-8"></head>` +
    `<body style="margin:0;height:100vh;background:#1d2939 url('${imageFileUrl}') center / cover no-repeat"></body></html>`;
  const path = join(app.getPath("temp"), "cortex-zen-backdrop.html");
  await fsp.writeFile(path, html, "utf8");
  return path;
}

// 显示(或刷新)幕布:定位到发起窗口所在显示器,盖满 display.bounds,显示指定背景照片。
async function showBackdrop(parent: BrowserWindow, imagePath: string): Promise<void> {
  const display = screen.getDisplayMatching(parent.getBounds());
  if (!backdropWin || backdropWin.isDestroyed()) {
    backdropWin = new BrowserWindow({
      show: false,
      frame: false,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      backgroundColor: "#1d2939",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
  }
  detachParentClose?.();
  const onParentClosed = () => hideBackdrop();
  parent.once("closed", onParentClosed);
  detachParentClose = () => parent.removeListener("closed", onParentClosed);
  backdropParent = parent;
  // 禅模式下窗口全屏无意义:绿灯置灰,退出时还原。
  parent.setFullScreenable(false);

  backdropWin.setBounds(display.bounds);
  await backdropWin.loadFile(await writeBackdropHtml(pathToFileURL(imagePath).href));
  // 可能在 await 间隙被 hide 销毁(快速进出禅模式),此处须再校验。
  if (!backdropWin || backdropWin.isDestroyed()) return;
  backdropWin.showInactive();
  // darwin:simple fullscreen 顺带隐藏菜单栏与 Dock(见文件头注释);幂等,重复调用无害。
  if (process.platform === "darwin" && !backdropWin.isSimpleFullScreen()) {
    backdropWin.setSimpleFullScreen(true);
  }
  // 幕布刚 show 会排到本层级最前,把写作窗口拉回幕布之上。
  if (!parent.isDestroyed()) parent.moveTop();
}

function hideBackdrop(): void {
  detachParentClose?.();
  detachParentClose = null;
  // 还原写作窗口的绿灯(fullscreenable)。
  if (backdropParent && !backdropParent.isDestroyed()) backdropParent.setFullScreenable(true);
  backdropParent = null;
  if (backdropWin && !backdropWin.isDestroyed()) {
    // 先退 simple fullscreen 还原 app 级 presentationOptions(菜单栏/Dock)再销毁窗口:
    // presentationOptions 是 app 级状态,只有 setSimpleFullScreen(false) 会显式还原,
    // 不能指望 destroy 顺带处理。
    if (process.platform === "darwin" && backdropWin.isSimpleFullScreen()) {
      backdropWin.setSimpleFullScreen(false);
    }
    backdropWin.destroy();
  }
  backdropWin = null;
}

export function registerWritingZenHandlers(): void {
  const root = zenAssetsRoot();
  const bgDir = join(root, "backgrounds");
  const soundDir = join(root, "sounds");

  // 资产枚举:渲染端拿 id 列表做「背景图像/背景音」的循环切换;不暴露绝对路径。
  ipcMain.handle("writing:zenAssets", async () => ({
    backgrounds: await listAssetIds(bgDir, BG_EXTS),
    sounds: await listAssetIds(soundDir, SOUND_EXTS),
  }));

  // 进入禅模式 / 切换背景都走同一通道:幕布不存在则建,存在则原地换景。
  // backgroundId 为空/找不到(旧档脏值、资产缺失)回落到清单首张;一张都没有则不显示幕布。
  ipcMain.handle("writing:zenBackdropShow", async (event, backgroundId: string) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent) return;
    let imagePath =
      typeof backgroundId === "string" ? await assetPathById(bgDir, backgroundId, BG_EXTS) : null;
    if (!imagePath) {
      const first = (await listAssetIds(bgDir, BG_EXTS))[0];
      imagePath = first ? await assetPathById(bgDir, first, BG_EXTS) : null;
    }
    if (!imagePath) return;
    await showBackdrop(parent, imagePath);
  });

  ipcMain.handle("writing:zenBackdropHide", async () => {
    hideBackdrop();
  });

  // 环境音取数:整文件 base64(mp3 单文件几 MB 级,IPC 一次性传输可承受);
  // 渲染端转 blob URL 循环播放 —— dev 渲染端是 http origin,直接 file:// 会被 webSecurity 拦。
  ipcMain.handle("writing:zenSoundData", async (_event, soundId: string): Promise<string | null> => {
    if (typeof soundId !== "string") return null;
    const p = await assetPathById(soundDir, soundId, SOUND_EXTS);
    if (!p) return null;
    return (await fsp.readFile(p)).toString("base64");
  });
}

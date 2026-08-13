// 写作禅模式 IPC(对齐 Metion 的禅模式形态):
//   1. 幕布窗口 —— 进入时写作窗口收缩到显示器工作区的最佳比例(computeZenBounds)居中悬浮,
//      主进程在其身后垫一层铺满当前显示器的无边框背景窗口,显示真实背景照片(轻度去饱和),
//      遮住桌面与其它程序界面;不把主窗口打成 OS 全屏,退出时恢复进入前几何。
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
// 进入禅模式前的窗口几何与状态:退出时恢复。非 null 表示「进入前状态已记录」,
// 换背景(zenBackdropShow 重入)不再重复记录 —— 否则会把禅模式尺寸当成待恢复值。
let savedParentState: {
  bounds: Electron.Rectangle;
  maximized: boolean;
  fullScreen: boolean;
} | null = null;

// 禅模式写作窗口的「最佳比例」:宽屏横构图(对齐 Metion 参考——约半屏宽的横向卡片,
// 高 ≈ 宽 × 0.6,四周大面积露出幕布)。宽 clamp(900, 52% 工作区宽, 1320),下限保
// 720 版心 + 两侧呼吸位;高随最终宽按 0.6 走(不低于 520、且上下合计至少留 96px 幕布);
// 居中。纯函数导出供单测;小屏兜底不超出工作区。
export function computeZenBounds(workArea: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Electron.Rectangle {
  const width = Math.min(Math.round(Math.min(1320, Math.max(900, workArea.width * 0.52))), workArea.width);
  const height = Math.min(
    Math.round(Math.min(workArea.height - 96, Math.max(520, width * 0.6))),
    workArea.height,
  );
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + (workArea.height - height) / 2);
  return { x, y, width, height };
}

// 进入禅模式:记录窗口当前状态后收缩到最佳比例(macOS setBounds 第二参自带动画)。
// OS 全屏窗口 setBounds 无效,须先退全屏并等 leave-full-screen 落定(超时兜底,防事件不来)。
// 每次调用(含换背景重入)都回到最佳比例 —— 禅内拖动/调宽**不做记忆**(产品约定),
// 但「进入前状态」只在首次记录,否则退出时会错把禅模式尺寸恢复回去。
async function shrinkParentForZen(parent: BrowserWindow): Promise<void> {
  if (!savedParentState) {
    savedParentState = {
      bounds: parent.getBounds(),
      maximized: parent.isMaximized(),
      fullScreen: parent.isFullScreen(),
    };
    if (savedParentState.fullScreen) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 800);
        parent.once("leave-full-screen", () => {
          clearTimeout(timer);
          resolve();
        });
        parent.setFullScreen(false);
      });
      if (parent.isDestroyed()) return;
    } else if (savedParentState.maximized) {
      parent.unmaximize();
    }
  }
  const workArea = screen.getDisplayMatching(parent.getBounds()).workArea;
  parent.setBounds(computeZenBounds(workArea), true);
}

// 退出禅模式:恢复进入前的几何与最大化/全屏状态。before-quit 兜底路径跳过(窗口将销毁)。
function restoreParentAfterZen(parent: BrowserWindow | null): void {
  const saved = savedParentState;
  savedParentState = null;
  if (!saved || !parent || parent.isDestroyed()) return;
  parent.setBounds(saved.bounds, true);
  if (saved.maximized) parent.maximize();
  // 还原全屏须在 fullscreenable 已还原之后(调用方保证顺序)。
  if (saved.fullScreen) parent.setFullScreen(true);
}

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
// 照片强力弱化:重度去饱和(saturate 0.35)+ 叠一层深灰蓝压暗纱(rgba 0.35),
// 幕布只当氛围衬底,不与前景写作窗口抢注意力(实机反馈:只轻度降饱和视觉上几乎无感)。
async function writeBackdropHtml(imageFileUrl: string): Promise<string> {
  const html =
    `<!doctype html><html><head><meta charset="utf-8"></head>` +
    `<body style="margin:0;height:100vh;overflow:hidden;background:#1d2939">` +
    `<div style="position:fixed;inset:0;background:` +
    `linear-gradient(rgba(20,28,38,0.35),rgba(20,28,38,0.35)),` +
    `url('${imageFileUrl}') center / cover no-repeat;` +
    `filter:saturate(0.35)"></div>` +
    `</body></html>`;
  const path = join(app.getPath("temp"), "cortex-zen-backdrop.html");
  await fsp.writeFile(path, html, "utf8");
  return path;
}

// 显示(或刷新)幕布:定位到发起窗口所在显示器,盖满 display.bounds,显示指定背景照片。
async function showBackdrop(parent: BrowserWindow, imagePath: string): Promise<void> {
  // 先收缩写作窗口(每次都复位到最佳比例,禅内拖动不做记忆):若原是 OS 全屏,
  // 这一步会先退全屏,幕布再按退出后所在显示器定位,避免对着全屏 Space 垫幕布。
  await shrinkParentForZen(parent);
  if (parent.isDestroyed()) return;
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
  // 渲染端重载(dev HMR / 手动刷新 / 渲染进程崩溃重建)兜底:zenMode 是**瞬态不落盘**的,重载后
  // 渲染端回到普通态,但主进程这边的幕布与 simple fullscreen 会原样留着 —— 那是 app 级
  // presentationOptions(自动隐藏菜单栏/Dock),留住就再没人来还原,只能靠退出登录/重启复位。
  // 导航开始即视为渲染端状态已丢,主动收幕布。
  const onParentNavigate = () => hideBackdrop();
  parent.once("closed", onParentClosed);
  parent.webContents.on("did-start-navigation", onParentNavigate);
  detachParentClose = () => {
    parent.removeListener("closed", onParentClosed);
    if (!parent.isDestroyed()) parent.webContents.removeListener("did-start-navigation", onParentNavigate);
  };
  backdropParent = parent;
  // 禅模式下窗口全屏无意义:退出时还原。
  parent.setFullScreenable(false);
  // 隐藏系统红绿灯(macOS):Electron 不支持只藏绿灯(全屏钮),故整组隐藏、退出还原;
  // 关闭/最小化由渲染端在窗口左上角自绘的红/黄两灯经 writing:zenWindowControl 兑现。
  if (process.platform === "darwin") parent.setWindowButtonVisibility(false);

  backdropWin.setBounds(display.bounds);
  await backdropWin.loadFile(await writeBackdropHtml(pathToFileURL(imagePath).href));
  // 可能在 await 间隙被 hide 销毁(快速进出禅模式),此处须再校验。
  if (!backdropWin || backdropWin.isDestroyed()) return;
  backdropWin.showInactive();
  // darwin:simple fullscreen 顺带隐藏菜单栏与 Dock(见文件头注释);幂等,重复调用无害。
  if (process.platform === "darwin" && !backdropWin.isSimpleFullScreen()) {
    backdropWin.setSimpleFullScreen(true);
  }
  if (!parent.isDestroyed()) {
    // 写作窗口挂为幕布的**子窗口**:子窗口恒浮于父窗口之上。幕布虽 focusable:false,
    // 直接点击仍会被系统在同层级内前移、盖住写作窗口(实测「点幕布写作窗口消失」),
    // 仅靠 moveTop 只能救 show 那一刻。退出禅模式必须先解除父子关系再销毁幕布
    // (见 hideBackdrop)——销毁父窗口会连带关闭子窗口。
    parent.setParentWindow(backdropWin);
    parent.moveTop();
  }
}

function hideBackdrop(opts?: { restoreParent?: boolean }): void {
  detachParentClose?.();
  detachParentClose = null;
  if (backdropParent && !backdropParent.isDestroyed()) {
    // 先解除父子关系:销毁父窗口(幕布)会连带关闭子窗口,顺序错了写作窗口直接没了。
    backdropParent.setParentWindow(null);
    // 还原绿灯(fullscreenable)与系统红绿灯组;随后恢复进入前几何(顺序有意:
    // 恢复 OS 全屏依赖 fullscreenable 已放开)。before-quit 传 restoreParent:false 跳过几何恢复。
    backdropParent.setFullScreenable(true);
    if (process.platform === "darwin") backdropParent.setWindowButtonVisibility(true);
  }
  restoreParentAfterZen(opts?.restoreParent === false ? null : backdropParent);
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
  // app 退出兜底:用户可能直接在禅模式里 Cmd+Q。simple fullscreen 改的是 **app 级**
  // presentationOptions(自动隐藏菜单栏/Dock),不显式 setSimpleFullScreen(false) 就还原不了;
  // 窗口 destroy 不顺带处理,进程没了这份系统状态也未必立刻复位。before-quit 早于窗口销毁,
  // 是最后一个能干净还原的时机。窗口几何不必恢复(马上销毁),传 restoreParent:false。
  app.on("before-quit", () => hideBackdrop({ restoreParent: false }));

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

  // 禅模式自绘红/黄灯的执行端(系统红绿灯组在禅模式被整组隐藏,见 showBackdrop):
  // close 直接关窗;minimize 有个 macOS 坑 —— 子窗口不能最小化,须先解除与幕布的
  // 父子关系,恢复(restore)时再挂回,期间点幕布顶掉窗口的问题不存在(窗口在 Dock 里)。
  ipcMain.handle("writing:zenWindowControl", (event, action: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    if (action === "close") {
      win.close();
      return;
    }
    if (action !== "minimize") return;
    win.setParentWindow(null);
    win.once("restore", () => {
      if (backdropWin && !backdropWin.isDestroyed() && !win.isDestroyed()) {
        win.setParentWindow(backdropWin);
      }
    });
    win.minimize();
  });

  // 环境音取数:整文件 base64(mp3 单文件几 MB 级,IPC 一次性传输可承受);
  // 渲染端转 blob URL 循环播放 —— dev 渲染端是 http origin,直接 file:// 会被 webSecurity 拦。
  ipcMain.handle("writing:zenSoundData", async (_event, soundId: string): Promise<string | null> => {
    if (typeof soundId !== "string") return null;
    const p = await assetPathById(soundDir, soundId, SOUND_EXTS);
    if (!p) return null;
    return (await fsp.readFile(p)).toString("base64");
  });

  // 禅模式衬线字体(思源宋体 Light,OFL 协议随包,resources/zen/fonts/):整文件 base64
  // 一次传输(11MB,渲染端模块级缓存、每次运行只取一次),FontFace 注册后进衬线栈首位。
  // 与环境音同因走 IPC:dev 渲染端 http origin 直连 file:// 字体会被 webSecurity 拦。
  ipcMain.handle("writing:zenFontData", async (): Promise<string | null> => {
    const p = join(root, "fonts", "SourceHanSerifCN-Light.otf");
    if (!existsSync(p)) return null;
    return (await fsp.readFile(p)).toString("base64");
  });
}

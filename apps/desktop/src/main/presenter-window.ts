// Slides 演示窗口(bento 化):直接 loadFile deck.bento.html,以 boot hash 选择放映形态
// (vendor/bento 的 cortex/present-modes:solo / audience / speaker)。
//
// 两种形态:
//  - 单屏:单个全屏窗口以 #cortex-present-solo 进 bento 放映,键盘/交互由 bento 自带
//    运行时处理,主进程只拦 Esc 与 cortex-presenter://control/end。
//  - 双屏(≥2 块显示器):外接屏 #cortex-present-audience(页内导航全禁),主屏
//    #cortex-present-speaker(自渲染 notes/下一页)。翻页权威在主进程:两窗拦方向键 →
//    更新 currentPos → 对两窗 executeJavaScript 调 window.cortexPresent.goto(实页索引)。
//
// 契约:
//  - 单例:重复播放 = 销毁旧 session 重建(deck 内容/起始页可能已变),不是聚焦复用。
//  - stateOf 状态页不进入线性导航:主进程持 railIndices(非状态页的实页索引),
//    方向键在 rail 内推进,goto 广播实页索引(与 bento present 的语义一致)。
//  - 任何演示窗口都**不注入 preload**(deck 是本地自包含 HTML,开沙箱,不暴露桌面能力);
//    主进程与页面只有两条通道:executeJavaScript(驱动)与 cortex-presenter:// URL(回控)。
import { BrowserWindow, screen } from "electron";
import { promises as fsp } from "node:fs";
import { pickPresentDisplays } from "./present-display-geometry";
import { createLogger } from "./log";

const log = createLogger("slides");

// 演示 session:双窗模式 audience(观众)+ speaker(演讲者);单窗模式 speaker 为 null。
// currentPos 是主进程持有的唯一翻页权威(rail 内位置,0 基)。
interface PresentSession {
  audience: BrowserWindow;
  speaker: BrowserWindow | null;
  /** 线性可走页的实页索引表(已剔除 stateOf 状态页,升序)。 */
  railIndices: number[];
  /** rail 内当前位置(0 基)。 */
  currentPos: number;
  /** 放映换壳临时目录(slides:present 换壳产物):放映页 reload 依赖它在盘上,关窗即删。 */
  cleanupPath?: string;
}

let session: PresentSession | null = null;

/** 删除换壳临时目录(尽力而为;仅关窗路径调用)。 */
function cleanupSessionFiles(s: PresentSession): void {
  if (!s.cleanupPath) return;
  fsp.rm(s.cleanupPath, { recursive: true, force: true }).catch(() => {});
}

// 纯静态本地 HTML 的 webPreferences:无 preload、无 Node、开沙箱,不暴露任何桌面能力。
// partition 与编辑器 webview 同为 persist:cortex-slides(packages/views 的
// slides-webview-partition.ts,跨包各持一份字面量,勿改成非 persist):
// file:// 源共享 localStorage —— 编辑器里设的语言(bento-lang)/动效偏好对
// 演讲者视图的 t() 界面与放映动效生效,且偏好跨重启存活。
const PRESENT_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  partition: "persist:cortex-slides",
} as const;

// Cortex 的“播放”语义是忠实执行文稿内配置的动画。deck.bento.html 是自包含文件,
// 旧 deck 会继续携带创建时的 runtime,因此宿主在 load 后统一关闭该 file origin 的
// reduce-motion 偏好；若 runtime 已按系统设置静态启动,只重载一次让当前页动画生效。
const ENSURE_PRESENTATION_MOTION_SOURCE = `(() => {
  let attempts = 20;
  const enable = () => {
    const overlay = document.querySelector('.bento-present-overlay');
    if (!overlay) {
      if (attempts-- > 0) window.setTimeout(enable, 100);
      return;
    }
    if (!overlay.classList.contains('reduce-motion')) return;
    localStorage.setItem('bento-reduce-motion', 'off');
    location.reload();
  };
  enable();
})()`;

function clampPos(n: number, total: number): number {
  return Math.max(0, Math.min(total - 1, n));
}

// 主进程权威翻页:更新 rail 位置并向两窗广播实页索引。
// bento 侧 window.cortexPresent.goto 是幂等跳页(audience 驱动 reveal,speaker 重绘)。
function broadcastGoto(): void {
  const s = session;
  if (!s) return;
  const realIndex = s.railIndices[s.currentPos] ?? 0;
  for (const w of [s.audience, s.speaker]) {
    if (w && !w.isDestroyed()) {
      w.webContents
        .executeJavaScript(`window.cortexPresent && window.cortexPresent.goto(${realIndex})`)
        .catch(() => {});
    }
  }
}

function navigate(pos: number): void {
  const s = session;
  if (!s) return;
  s.currentPos = clampPos(pos, s.railIndices.length);
  broadcastGoto();
}

type PresenterControlCommand =
  | { type: "advance" }
  | { type: "back" }
  | { type: "jump"; pageIndex: number }
  | { type: "end" };

function parsePresenterControlUrl(rawUrl: string): PresenterControlCommand | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "cortex-presenter:" || url.hostname !== "control") return null;
    if (url.pathname === "/advance") return { type: "advance" };
    if (url.pathname === "/back") return { type: "back" };
    if (url.pathname === "/end") return { type: "end" };
    if (url.pathname === "/jump") {
      const page = Number(url.searchParams.get("page"));
      if (Number.isInteger(page) && page > 0) return { type: "jump", pageIndex: page - 1 };
    }
    return null;
  } catch {
    return null;
  }
}

function isPresenterControlUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "cortex-presenter:" && url.hostname === "control";
  } catch {
    return false;
  }
}

function handlePresenterControl(command: PresenterControlCommand): void {
  const s = session;
  if (!s) return;
  if (command.type === "advance") navigate(s.currentPos + 1);
  else if (command.type === "back") navigate(s.currentPos - 1);
  else if (command.type === "jump") {
    // jump 的入参是「实页序号」(speaker 控制条以 1 基实页发起);换算到 rail 内最近位置。
    const pos = s.railIndices.findIndex((idx) => idx >= command.pageIndex);
    navigate(pos >= 0 ? pos : s.railIndices.length - 1);
  } else destroyPresenterWindow();
}

// 双窗模式的键盘处理:两窗都拦方向/翻页键(preventDefault 阻止事件下发到页面,避免页面内
// 残留的 keydown 再翻一次导致两窗脱同步),Esc 关全部窗口;其它键放行给页面。
function handleDualInput(event: { preventDefault: () => void }, input: { type: string; key: string }): void {
  if (input.type !== "keyDown") return;
  const s = session;
  switch (input.key) {
    case "Escape":
      event.preventDefault();
      destroyPresenterWindow();
      break;
    case "ArrowLeft":
    case "PageUp":
      event.preventDefault();
      if (s) navigate(s.currentPos - 1);
      break;
    case "ArrowRight":
    case "PageDown":
    case " ":
      event.preventDefault();
      if (s) navigate(s.currentPos + 1);
      break;
    case "Home":
      event.preventDefault();
      navigate(0);
      break;
    case "End":
      event.preventDefault();
      if (s) navigate(s.railIndices.length - 1);
      break;
    // 其它键不 preventDefault,放行给页面自身处理。
  }
}

/** 打开演示窗口:加载 deck.bento.html,从 startIndex(实页 0 基)起播;多屏自动分观众/演讲者屏。 */
export async function openPresenterWindow(options: {
  title: string;
  /** deck.bento.html 的绝对路径(由 bento-workspace 校验后传入;换壳时为临时副本)。 */
  deckHtmlPath: string;
  startIndex: number;
  /** 线性可走页的实页索引表(剔除 stateOf;至少一项)。 */
  railIndices: number[];
  /** 换壳临时目录:关窗时删除;未换壳(直接加载 deck 原文件)时不传。 */
  cleanupPath?: string;
}): Promise<void> {
  // 旧 session 先销毁:deck 内容可能已变,重建不串台。
  destroyPresenterWindow();

  const railIndices = options.railIndices.length > 0 ? [...options.railIndices].sort((a, b) => a - b) : [0];
  // 起始页吸附到 rail 内不小于它的最近线性页。
  const startPosRaw = railIndices.findIndex((idx) => idx >= options.startIndex);
  const startPos = startPosRaw >= 0 ? startPosRaw : railIndices.length - 1;
  const startReal = railIndices[startPos] ?? 0;

  // 是否分屏:仅当 ≥2 块屏且存在非主屏时,才走双窗;否则单窗全屏(与旧行为一致)。
  const displays = screen.getAllDisplays();
  const pick = pickPresentDisplays(displays, screen.getPrimaryDisplay().id);

  const audience = new BrowserWindow({
    fullscreen: !pick,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0b0d12", // 与放映底色一致,避免全屏切换白闪。
    ...(pick
      ? {
          // 双窗:无边框 + 目标屏 bounds。macOS 用 panel 严格覆盖 Display.bounds
          // (不用 simpleFullScreen:它会全局隐藏 Dock,历史踩坑,勿回退)。
          frame: false,
          ...(process.platform === "darwin"
            ? { type: "panel" as const, enableLargerThanScreen: true, fullscreenable: false }
            : {}),
          x: pick.audience.bounds.x,
          y: pick.audience.bounds.y,
          width: pick.audience.bounds.width,
          height: pick.audience.bounds.height,
        }
      : {}),
    webPreferences: { ...PRESENT_WEB_PREFERENCES },
  });
  if (pick && process.platform === "darwin") {
    // screen-saver 层级盖住观众屏自己的菜单栏/Dock;只提升这一个窗口。
    audience.setAlwaysOnTop(true, "screen-saver");
    audience.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }

  let speaker: BrowserWindow | null = null;
  if (pick) {
    speaker = new BrowserWindow({
      fullscreen: false,
      frame: false,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#0b0d12",
      x: pick.speaker.bounds.x,
      y: pick.speaker.bounds.y,
      width: pick.speaker.bounds.width,
      height: pick.speaker.bounds.height,
      webPreferences: { ...PRESENT_WEB_PREFERENCES },
    });
  }

  const s: PresentSession = { audience, speaker, railIndices, currentPos: startPos };
  if (options.cleanupPath) s.cleanupPath = options.cleanupPath;
  session = s;

  const allWins = speaker ? [audience, speaker] : [audience];

  // 任一窗 closed → 连带销毁另一窗、清空 session(仅当仍是当前 session)、删换壳临时目录。
  const onClosed = (): void => {
    if (session === s) {
      session = null;
      for (const w of allWins) {
        if (!w.isDestroyed()) w.destroy();
      }
      cleanupSessionFiles(s);
    }
  };

  for (const w of allWins) {
    // bento 放映页里的 's'(speaker popup)等 window.open 路径一律拒绝:
    // 演示窗口不允许衍生新窗口(speaker 由主进程自己开)。
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // cortex-presenter://control/...:solo 的页内退出与 speaker 的控制条都走这条通道。
    w.webContents.on("will-navigate", (event, navigationUrl) => {
      if (!isPresenterControlUrl(navigationUrl)) return;
      event.preventDefault();
      const command = parsePresenterControlUrl(navigationUrl);
      if (command) handlePresenterControl(command);
    });
    w.webContents.on("did-finish-load", () => {
      if (w === audience) {
        void w.webContents.executeJavaScript(ENSURE_PRESENTATION_MOTION_SOURCE).catch(() => {});
      }
    });
    w.on("closed", onClosed);
  }

  if (pick && speaker) {
    // 双窗:两窗都收权威翻页键。
    for (const w of allWins) w.webContents.on("before-input-event", handleDualInput);
    const enterFullscreen = (w: BrowserWindow, bounds: Electron.Rectangle): void => {
      if (session !== s || w.isDestroyed()) return;
      w.setBounds(bounds);
      w.show();
      if (process.platform !== "darwin") w.setFullScreen(true);
    };
    audience.once("ready-to-show", () => enterFullscreen(audience, pick.audience.bounds));
    speaker.once("ready-to-show", () => enterFullscreen(speaker!, pick.speaker.bounds));
  } else {
    // 单窗:仅拦 Esc(方向键交给 bento 放映运行时),行为与改造前一致。
    audience.webContents.on("before-input-event", (_event, input: { type: string; key: string }) => {
      if (input.type === "keyDown" && input.key === "Escape") audience.close();
    });
    audience.once("ready-to-show", () => audience.show());
  }

  // boot hash 决定放映形态与起始实页(cortex/present-modes 解析)。
  const soloHash = `cortex-present-solo.${startReal}`;
  try {
    const loads: Array<Promise<void>> = [
      audience.loadFile(options.deckHtmlPath, { hash: pick ? `cortex-present-audience.${startReal}` : soloHash }),
    ];
    if (speaker) loads.push(speaker.loadFile(options.deckHtmlPath, { hash: `cortex-present-speaker.${startReal}` }));
    await Promise.all(loads);
  } catch (err) {
    log.warn(`[present] loadFile failed: ${String(err)}`);
    destroyPresenterWindow();
    throw err;
  }
}

/** 销毁演示窗口(若存在);幂等。先清空 session 再销毁,避免 closed 回调重入。 */
export function destroyPresenterWindow(): void {
  const s = session;
  session = null;
  if (!s) return;
  for (const w of [s.audience, s.speaker]) {
    if (w && !w.isDestroyed()) w.destroy();
  }
  cleanupSessionFiles(s);
}

/** 测试/调试用:当前演示窗口(以观众窗为准,已销毁视为 null)。 */
export function getPresenterWindow(): BrowserWindow | null {
  const w = session?.audience;
  return w && !w.isDestroyed() ? w : null;
}

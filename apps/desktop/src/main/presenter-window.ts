// Slides 演示窗口:把 buildPresenterHtml 生成的自包含演示 HTML 写入临时文件后 loadFile 播放。
//
// 两种形态:
//  - 单屏(只有一块显示器):沿用原行为 —— 单个全屏窗口播放观众页,方向键/备注/缩放全部
//    由 presenter HTML 自带运行时处理,主进程只拦 Esc。零回归。
//  - 双屏(≥2 块显示器):外接屏放观众页(#bar 隐藏),主屏放演讲者页(speaker view)。
//    翻页权威收归主进程:两窗都拦方向键 → 更新 currentIndex → 对两窗广播 location.hash,
//    复用各页现成的 hashchange→show 联动;初始定位靠各窗 loadFile 的 hash,无 load 竞态。
//
// 契约:
//  - 单例:重复播放 = 销毁旧 session 重建(deck 内容/起始页可能已变),不是聚焦复用。
//  - 起始页经 URL hash(#N,1 基)传给各页运行时,它初始化即读 location.hash。
//  - 任何演示窗口都**不注入 preload/bridge**(纯静态本地 HTML,开沙箱,不暴露桌面能力)。
import { app, BrowserWindow, screen } from "electron";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { buildPresenterHtml, type PresenterSlide } from "./capabilities/slides/export/html";
import { buildSpeakerHtml } from "./capabilities/slides/present/speaker-html";
import { pickPresentDisplays } from "./present-display-geometry";
import { createLogger } from "./log";

const log = createLogger("slides");

// 演示 session:双窗模式 audience(观众)+ speaker(演讲者);单窗模式 speaker 为 null。
// currentIndex/total 是主进程持有的唯一翻页权威(双窗联动的单一数据源)。
interface PresentSession {
  audience: BrowserWindow;
  speaker: BrowserWindow | null;
  currentIndex: number;
  total: number;
}

let session: PresentSession | null = null;

// 纯静态本地 HTML 的 webPreferences:无 preload、无 Node、开沙箱,不暴露任何桌面能力。
const PRESENT_WEB_PREFERENCES = { sandbox: true, contextIsolation: true } as const;

function clampIndex(n: number, total: number): number {
  return Math.max(0, Math.min(total - 1, n));
}

// 把当前页广播给两窗:改各窗 location.hash → 触发页面自身的 hashchange→show(复用现成联动)。
function broadcastHash(idx: number): void {
  if (!session) return;
  for (const w of [session.audience, session.speaker]) {
    if (w && !w.isDestroyed()) {
      w.webContents.executeJavaScript(`location.hash='#${idx + 1}'`).catch(() => {});
    }
  }
}

// 主进程权威翻页:clamp 后更新 currentIndex,再广播给两窗。
function navigate(target: number): void {
  if (!session) return;
  const idx = clampIndex(target, session.total);
  session.currentIndex = idx;
  broadcastHash(idx);
}

// 双窗模式的键盘处理:两窗都拦方向/翻页键(preventDefault 阻止事件下发到页面,避免页面内
// 自带的 keydown 再翻一次导致两窗脱同步),Esc 关全部窗口;f/n 等其它键放行给页面。
function handleDualInput(event: { preventDefault: () => void }, input: { type: string; key: string }): void {
  if (input.type !== "keyDown") return;
  switch (input.key) {
    case "Escape":
      event.preventDefault();
      destroyPresenterWindow();
      break;
    case "ArrowLeft":
    case "PageUp":
      event.preventDefault();
      navigate((session?.currentIndex ?? 0) - 1);
      break;
    case "ArrowRight":
    case "PageDown":
    case " ":
      event.preventDefault();
      navigate((session?.currentIndex ?? 0) + 1);
      break;
    case "Home":
      event.preventDefault();
      navigate(0);
      break;
    case "End":
      event.preventDefault();
      navigate((session?.total ?? 1) - 1);
      break;
    // 其它键(f/n 等)不 preventDefault,放行给页面自身处理。
  }
}

/** 打开演示窗口:从 startIndex(0 基)起播;多屏时自动分观众屏/演讲者屏。 */
export async function openPresenterWindow(options: {
  title: string;
  slides: PresenterSlide[];
  startIndex: number;
}): Promise<void> {
  // 旧 session 先销毁(其 closed 回调清理共享临时目录):内容可能已变,重建不串台。
  destroyPresenterWindow();

  const total = options.slides.length;
  const startIndex = clampIndex(options.startIndex, total);
  const hash = String(startIndex + 1);

  // 观众页(与单窗同一份 presenter 导出运行时)。
  const audienceHtml = buildPresenterHtml({ title: options.title, slides: options.slides });
  // 共享 mkdtemp 目录:双窗的 audience.html / speaker.html 同放此目录,全部窗口关闭后统一清理。
  const tmpDir = await fsp.mkdtemp(join(app.getPath("temp"), "cortex-present-"));
  const audienceFile = join(tmpDir, "audience.html");
  await fsp.writeFile(audienceFile, audienceHtml, "utf8");

  // 是否分屏:仅当 ≥2 块屏且存在非主屏时,才走双窗;否则单窗全屏(零回归)。
  const displays = screen.getAllDisplays();
  const pick = pickPresentDisplays(displays, screen.getPrimaryDisplay().id);

  const audience = new BrowserWindow({
    fullscreen: !pick, // 单窗维持原 fullscreen:true;双窗改由 ready-to-show 里 setFullScreen 到指定屏。
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0b0d12", // 与 body 底色一致,避免全屏切换白闪。
    ...(pick
      ? { x: pick.audience.bounds.x, y: pick.audience.bounds.y, width: pick.audience.bounds.width, height: pick.audience.bounds.height }
      : {}),
    webPreferences: { ...PRESENT_WEB_PREFERENCES },
  });

  let speaker: BrowserWindow | null = null;
  let speakerFile: string | null = null;
  if (pick) {
    speakerFile = join(tmpDir, "speaker.html");
    const speakerHtml = buildSpeakerHtml({ title: options.title, slides: options.slides, startIndex });
    await fsp.writeFile(speakerFile, speakerHtml, "utf8");
    speaker = new BrowserWindow({
      fullscreen: false,
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

  const s: PresentSession = { audience, speaker, currentIndex: startIndex, total };
  session = s;

  const allWins = speaker ? [audience, speaker] : [audience];

  // 共享临时目录清理:两窗共用同一 tmpDir,任一窗先关就 rm 会删掉另一窗的临时文件(虽已 load
  // 进内存,语义不干净)—— 故计数到全部窗口 closed 才 rm(幂等,best-effort,OS temp 兜底)。
  let remaining = allWins.length;
  const cleanupDir = (): void => {
    remaining -= 1;
    if (remaining <= 0) void fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };

  // 任一窗 closed → 连带销毁另一窗、清空 session(仅当仍是当前 session,重建场景下已被替换)。
  const onClosed = (): void => {
    cleanupDir();
    if (session === s) {
      session = null;
      for (const w of allWins) if (!w.isDestroyed()) w.destroy();
    }
  };

  if (pick && speaker) {
    // 双窗:两窗都收权威翻页键;观众窗额外隐藏 #bar(鼠标点 #bar 会绕过主进程翻页权威致两窗脱同步)。
    for (const w of allWins) w.webContents.on("before-input-event", handleDualInput);
    audience.webContents.on("dom-ready", () => {
      audience.webContents.insertCSS("#bar{display:none!important}").catch(() => {});
    });
    // 目标屏定位 + 全屏:先建于目标屏坐标,ready-to-show 里再 setBounds + setFullScreen + show,
    // 避免全屏窗口跨屏移动的闪烁/竞态。
    audience.once("ready-to-show", () => {
      audience.setBounds(pick.audience.bounds);
      audience.setFullScreen(true);
      audience.show();
    });
    speaker.once("ready-to-show", () => {
      speaker!.setBounds(pick.speaker.bounds);
      speaker!.setFullScreen(true);
      speaker!.show();
    });
  } else {
    // 单窗:仅拦 Esc(方向键交给 presenter HTML 自带运行时),保留可点 #bar,行为与改造前一致。
    audience.webContents.on("before-input-event", (_event, input: { type: string; key: string }) => {
      if (input.type === "keyDown" && input.key === "Escape") audience.close();
    });
    audience.once("ready-to-show", () => audience.show());
  }

  for (const w of allWins) w.on("closed", onClosed);

  // hash = 起始页序号(1 基),各页初始化读 location.hash 定位。
  try {
    const loads: Array<Promise<void>> = [audience.loadFile(audienceFile, { hash })];
    if (speaker && speakerFile) loads.push(speaker.loadFile(speakerFile, { hash }));
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
}

/** 测试/调试用:当前演示窗口(以观众窗为准,已销毁视为 null)。 */
export function getPresenterWindow(): BrowserWindow | null {
  const w = session?.audience;
  return w && !w.isDestroyed() ? w : null;
}

// re-export 供 handler/测试引用同一类型,避免出现第二个 PresenterSlide 形状。
export type { PresenterSlide };

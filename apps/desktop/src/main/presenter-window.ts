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
import {
  ENTRANCE_PRESETS,
  STYLE_DURATION_SCALE,
  defaultHeuristicEntranceDurationMs,
} from "@cortex-work/core/design/slides/slides-animation";
import type {
  SlidesAnimationStyle,
  SlidesSlotAnimation,
} from "@cortex-work/core/design/slides/slides-types";
import { buildPresenterHtml, type PresenterSlide } from "./capabilities/slides/export/html";
import { buildSpeakerHtml } from "./capabilities/slides/present/speaker-html";
import { pickPresentDisplays } from "./present-display-geometry";
import { createLogger } from "./log";

const log = createLogger("slides");

// 演示 session:双窗模式 audience(观众)+ speaker(演讲者);单窗模式 speaker 为 null。
// currentIndex/currentStep/total 是主进程持有的唯一翻页权威(双窗联动的单一数据源)。
// entranceSteps 按 manifest 显式 entrances 预计算为有序去重的「待按键步骤」；step 0
// 在进入页面时自动播放，不进入此序列。无显式注解的启发式也全部归 step 0。
interface PresentSession {
  audience: BrowserWindow;
  speaker: BrowserWindow | null;
  currentIndex: number;
  /** 当前页已推进到的分步档位(0 基;0 = 仅自动入场的 step 0 已播)。 */
  currentStep: number;
  entranceSteps: number[][];
  stepDurations: Array<Record<number, number>>;
  busyUntil: number;
  total: number;
}

let session: PresentSession | null = null;

// 纯静态本地 HTML 的 webPreferences:无 preload、无 Node、开沙箱,不暴露任何桌面能力。
const PRESENT_WEB_PREFERENCES = { sandbox: true, contextIsolation: true } as const;

function clampIndex(n: number, total: number): number {
  return Math.max(0, Math.min(total - 1, n));
}

function pendingEntranceSteps(animation: SlidesSlotAnimation | undefined): number[] {
  const steps = animation?.entrances?.map((entry) => entry.step).filter((step) => step > 0) ?? [];
  return [...new Set(steps)].sort((a, b) => a - b);
}

function entranceStepDurations(
  animation: SlidesSlotAnimation | undefined,
  style: SlidesAnimationStyle,
  slideHtml: string,
): Record<number, number> {
  const durations: Record<number, number> = {};
  if (!(animation?.entrances?.length) && slideHtml.includes("data-cortex-id")) {
    durations[0] = defaultHeuristicEntranceDurationMs(style);
    return durations;
  }
  for (const entry of animation?.entrances ?? []) {
    const preset = ENTRANCE_PRESETS[entry.preset];
    const duration = entry.durationMs ?? Math.round(preset.defaultDurationMs * STYLE_DURATION_SCALE[style]);
    durations[entry.step] = Math.max(durations[entry.step] ?? 0, (entry.delayMs ?? 0) + duration);
  }
  return durations;
}

// hash 契约(与 presenter-runtime 对齐):`#页[.步|.all]`,1 基页号。
// speaker 页 parseInt 解析天然只取页号,无需感知 step。
function broadcastHash(idx: number, token?: number | "all"): void {
  if (!session) return;
  const suffix = token === undefined || token === 0 ? "" : `.${token}`;
  for (const w of [session.audience, session.speaker]) {
    if (w && !w.isDestroyed()) {
      w.webContents.executeJavaScript(`location.hash='#${idx + 1}${suffix}'`).catch(() => {});
    }
  }
}

// 主进程权威翻页。mode:'auto' = 正向进入新页(step 归零、自动入场);
// 'all' = 回退/跳页(该页全显、不播动画,标准 PPT 语义)。
function navigate(target: number, mode: "auto" | "all"): void {
  if (!session) return;
  const idx = clampIndex(target, session.total);
  session.currentIndex = idx;
  const steps = session.entranceSteps[idx] ?? [];
  session.currentStep = mode === "all" ? (steps.at(-1) ?? 0) : 0;
  session.busyUntil = mode === "auto" ? Date.now() + (session.stepDurations[idx]?.[0] ?? 0) : 0;
  broadcastHash(idx, mode === "all" ? "all" : 0);
}

function advancePresentation(): void {
  const s = session;
  if (!s || Date.now() < s.busyUntil) return;
  const nextStep = (s.entranceSteps[s.currentIndex] ?? []).find((candidate) => candidate > s.currentStep);
  if (nextStep !== undefined) {
    s.currentStep = nextStep;
    s.busyUntil = Date.now() + (s.stepDurations[s.currentIndex]?.[nextStep] ?? 0);
    broadcastHash(s.currentIndex, nextStep);
  } else if (s.currentIndex + 1 < s.total) {
    navigate(s.currentIndex + 1, "auto");
  }
}

function backPresentation(): void {
  const s = session;
  if (s && s.currentIndex > 0) navigate(s.currentIndex - 1, "all");
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
  if (command.type === "advance") advancePresentation();
  else if (command.type === "back") backPresentation();
  else if (command.type === "jump") navigate(command.pageIndex, "auto");
  else destroyPresenterWindow();
}

// 双窗模式的键盘处理:两窗都拦方向/翻页键(preventDefault 阻止事件下发到页面,避免页面内
// 自带的 keydown 再翻一次导致两窗脱同步),Esc 关全部窗口;f/n 等其它键放行给页面。
// 正向推进是 (page, step) 状态机:本页还有未播分步 → step+1;否则翻下一页。
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
      backPresentation();
      break;
    case "ArrowRight":
    case "PageDown":
    case " ": {
      event.preventDefault();
      advancePresentation();
      break;
    }
    case "Home":
      event.preventDefault();
      navigate(0, "all");
      break;
    case "End":
      event.preventDefault();
      navigate((s?.total ?? 1) - 1, "all");
      break;
    // 其它键(f/n 等)不 preventDefault,放行给页面自身处理。
  }
}

/** 打开演示窗口:从 startIndex(0 基)起播;多屏时自动分观众屏/演讲者屏。 */
export async function openPresenterWindow(options: {
  title: string;
  slides: PresenterSlide[];
  startIndex: number;
  /** 全局动画风格(deck.json 的 animationStyle);缺省 none = 静态播放,零回归。 */
  animationStyle?: SlidesAnimationStyle;
}): Promise<void> {
  // 旧 session 先销毁(其 closed 回调清理共享临时目录):内容可能已变,重建不串台。
  destroyPresenterWindow();

  const total = options.slides.length;
  const startIndex = clampIndex(options.startIndex, total);
  const hash = String(startIndex + 1);

  // 观众页(与单窗同一份 presenter 导出运行时)。
  const audienceHtml = buildPresenterHtml({
    title: options.title,
    slides: options.slides,
    animationStyle: options.animationStyle
  });
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
      ? {
          // 双窗:无边框 + 目标屏 bounds(全屏由 ready-to-show 里 simpleFullScreen 完成)。
          frame: false,
          ...(process.platform === "darwin"
            ? {
                // macOS 普通窗口会把 y=0 强制夹到菜单栏下方。允许超出工作区后,panel
                // 才能严格覆盖 Display.bounds,无需不可靠的 Spaces 全屏转场。
                type: "panel" as const,
                enableLargerThanScreen: true,
                fullscreenable: false,
              }
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
    // screen-saver 层级盖住观众屏自己的菜单栏/Dock;只提升这一个窗口,不会像
    // simpleFullScreen 那样修改 NSApp 全局 presentationOptions、隐藏主屏 Dock。
    audience.setAlwaysOnTop(true, "screen-saver");
    audience.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  }

  let speaker: BrowserWindow | null = null;
  let speakerFile: string | null = null;
  if (pick) {
    speakerFile = join(tmpDir, "speaker.html");
    const speakerHtml = buildSpeakerHtml({
      title: options.title,
      slides: options.slides,
      startIndex,
      animationStyle: options.animationStyle,
    });
    await fsp.writeFile(speakerFile, speakerHtml, "utf8");
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

  // 风格为 none(或缺省)时动画整体关闭,不存在待按键的分步。
  const animationOn = (options.animationStyle ?? "none") !== "none";
  const animationStyle = options.animationStyle ?? "none";
  const entranceSteps = options.slides.map((slide) => (animationOn ? pendingEntranceSteps(slide.animation) : []));
  const stepDurations = options.slides.map((slide) =>
    animationOn ? entranceStepDurations(slide.animation, animationStyle, slide.html) : {},
  );
  const s: PresentSession = {
    audience,
    speaker,
    currentIndex: startIndex,
    currentStep: 0,
    entranceSteps,
    stepDurations,
    busyUntil: Date.now() + (stepDurations[startIndex]?.[0] ?? 0),
    total,
  };
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
      for (const w of allWins) {
        releaseSimpleFullscreen(w);
        if (!w.isDestroyed()) w.destroy();
      }
    }
  };

  if (pick && speaker) {
    // 双窗:两窗都收权威翻页键;观众窗额外隐藏 #bar(鼠标点 #bar 会绕过主进程翻页权威致两窗脱同步)。
    for (const w of allWins) w.webContents.on("before-input-event", handleDualInput);
    speaker.webContents.on("will-navigate", (event, navigationUrl) => {
      if (!isPresenterControlUrl(navigationUrl)) return;
      event.preventDefault();
      const command = parsePresenterControlUrl(navigationUrl);
      if (!command) return;
      handlePresenterControl(command);
    });
    audience.webContents.on("dom-ready", () => {
      audience.webContents.insertCSS("#bar{display:none!important}").catch(() => {});
    });
    // 目标屏定位与全屏策略(历史沿革,勿回退):
    //  - setSimpleFullScreen 经 NSApp 级 presentationOptions **全局隐藏 Dock 与菜单栏**
    //    (用户明确要求:演示期间不得隐藏程序坞),弃用;
    //  - 原生 setFullScreen(Spaces)在双窗场景会被系统吞掉,并且把演讲者窗等待在
    //    enter-full-screen 后会导致两窗一起不可用。macOS 因此改为无边框 panel 严格覆盖
    //    Display.bounds;观众/演讲者两窗各自 ready 后独立展示,没有跨窗时序依赖;
    //  - 其它平台无 Spaces/presentationOptions 概念,两窗仍用 setFullScreen。
    const enterFullscreen = (w: BrowserWindow, bounds: Electron.Rectangle): void => {
      if (session !== s || w.isDestroyed()) return;
      w.setBounds(bounds);
      w.show();
      if (process.platform !== "darwin") w.setFullScreen(true);
    };
    audience.once("ready-to-show", () => enterFullscreen(audience, pick.audience.bounds));
    speaker.once("ready-to-show", () => enterFullscreen(speaker!, pick.speaker.bounds));
  } else {
    // 单窗:仅拦 Esc(方向键交给 presenter HTML 自带运行时),保留可点 #bar,行为与改造前一致。
    audience.webContents.on("before-input-event", (_event, input: { type: string; key: string }) => {
      if (input.type === "keyDown" && input.key === "Escape") audience.close();
    });
    audience.once("ready-to-show", () => audience.show());
  }

  // close(销毁前)先退自身 simple fullscreen —— 兜住用户经系统途径(Cmd+W 等)关窗的路径。
  for (const w of allWins) w.on("close", () => releaseSimpleFullscreen(w));
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
/**
 * 防御性兜底:双窗路径已不再进入 simpleFullScreen(演示期间保留 Dock,见 enterFullscreen
 * 注释),正常流程下这里恒为 no-op;保留是防未来某路径又把窗口置入 simple 态时,
 * 销毁前忘还原 presentation options 导致退出演示后程序坞消失(历史踩坑)。
 */
function releaseSimpleFullscreen(w: BrowserWindow | null): void {
  try {
    if (w && !w.isDestroyed() && w.isSimpleFullScreen()) w.setSimpleFullScreen(false);
  } catch {
    /* 窗口正在销毁等边缘态,忽略 */
  }
}

export function destroyPresenterWindow(): void {
  const s = session;
  session = null;
  if (!s) return;
  for (const w of [s.audience, s.speaker]) {
    releaseSimpleFullscreen(w);
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

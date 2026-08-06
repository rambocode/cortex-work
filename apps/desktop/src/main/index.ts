import { app, autoUpdater as electronAutoUpdater, BrowserWindow, globalShortcut, ipcMain, powerMonitor } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { runTaskMigration } from "./ipc/tasks-migrate";
import {
  registerIpcHandlers,
  killAllCli,
  killAllAsk,
  killAllPiSessions,
  killAllPty,
  closeAllWatchers,
  killAllAutomations,
  killAllOrchestrations,
  killAllRoundtables,
  syncAgentBrowserRuntime,
  killAllResearchWorkers,
  runResearchStartupTasks,
  syncResearchEngineRuntime,
} from "./ipc/register";
import { installBrowserWebviewGuards } from "./browser/webviewGuards";
import { configureBrowserPartition } from "./browser/partition";
import { chatsDir, ensureMigrated } from "./paths";
import { initScheduler, rescheduleAll, stopScheduler } from "./automation/scheduler";
import { tasksStore, tasksReminderScheduler, isTasksReminderOptInEnabled } from "./ipc/tasks";
import { startMcpHost, stopMcpHost } from "./capabilities/mcp-host/server";
import { registerBrowserTools } from "./capabilities/browser/tools";
import { startDocExtractHost, stopDocExtractHost } from "./capabilities/doc-extract/mcp";
import { startMediaGenHost, stopMediaGenHost } from "./capabilities/media-gen/server";
import { startLoopWorkflowsHost, stopLoopWorkflowsHost } from "./capabilities/loop-workflows/server";
import { startResearchHost, stopResearchHost } from "./capabilities/research/server";
import { startAutomationHost, stopAutomationHost } from "./capabilities/automation/server";
import { startCalendarHost, stopCalendarHost } from "./capabilities/calendar/server";
import { setCalendarHelper, invalidateCalendarAccessCache } from "./capabilities/calendar/helper";
import { startDelegateHost, stopDelegateHost, killAllDelegates } from "./capabilities/delegate/server";
import { startDesignDelegateHost, stopDesignDelegateHost, killAllDesignDelegates } from "./capabilities/design-delegate/server";
import { stopSlidesHost } from "./capabilities/slides/server";
import { ensureComputerUsePackage } from "./capabilities/computer-use/install";
import { clearAllSlidesSessions } from "./capabilities/slides/session";
import { initWorkflowRuntime, killAllWorkflows } from "./workflow/index";
import { loadWorkflows, markOrphanRunsKilled } from "./workflow/store";
import { initWorkflowScheduler } from "./workflow/scheduler";
import { createTray, destroyTray } from "./automation/tray";
import { toggleSpotlight, destroySpotlight, getSpotlightWindow } from "./spotlight";
import { registerSpotlightHandlers } from "./ipc/spotlight";
import { registerProjectsDelegateRelay } from "./projects-window";
import { toggleNotesOverlay, destroyNotesOverlay, getNotesOverlayWindow } from "./notes-overlay";
import { registerNotesOverlayHandlers } from "./ipc/notes-overlay";
import { destroyNotificationWindow, clearNotifications } from "./notification-window";
import { registerNotificationWindowHandlers } from "./ipc/notification-window";
import {
  destroyAgentTraceWindow,
  getAgentTraceWindow,
  registerAgentTraceWindowHandlers,
} from "./agent-trace-window";
import { ensurePetOverlayWindow, destroyPetOverlayWindow, getPetOverlayWindow } from "./pet-overlay-window";
import { registerPetHandlers } from "./ipc/pet";
import { registerPetdexHandlers, registerPetdexScheme } from "./ipc/petdex";
import {
  resolveHotkeyRegistration,
  rebindCandidates,
  resolveRebindChain,
  isValidAccelerator,
  NOTES_HOTKEY_ACCELERATOR,
  NOTES_HOTKEY_INVALID_TOAST,
  REPLY_HOTKEY_ACCELERATOR,
  type HotkeyRegistration,
} from "./hotkey";
import {
  applyVoiceHotkeys,
  getVoiceChatScreenContextPid,
  setDictationResultHandler,
  setVoiceChatScreenContextPid,
  setVoiceHotkeyCallbacks,
  setVoiceScreenshotProvider,
  toggleVoiceChatFromHotkey,
} from "./ipc/voice";
import { DictationController } from "./voice/dictation-controller";
import { polishTranscriptIfEnabled } from "./capabilities/whisper/polish";
import { destroyDictationWindow, pushDictationBarState } from "./voice/dictation-window";
import { mapAcceleratorToMacKeyCode } from "./voice/accelerator-keycode";
import { getVoiceChatWindow } from "./voice/voice-chat-window";
// 快捷回复助手（reply，U7）：仅 macOS 接线（AX / CGEventTap / Vision / EventKit 均为 macOS 专属）。
import { ReplyHelperClient } from "./reply/helper-client";
import { resolveReplyHelperBinary } from "./reply/helper-locate";
import { queryReplyPermissions } from "./reply/permissions";
import {
  initReplyController,
  getReplyController,
  triggerReplyDraft,
  disposeReplyController,
  type DraftAcceptedInfo,
} from "./reply/controller";
import {
  getLastReplySnapshot,
  setReplyHelperPermissionsSource,
  setReplyRelearnHandler,
  replyHistoryStore,
  replyConversationStore,
  replyMemoryStore,
} from "./ipc/reply";
import { newReplyHistoryId } from "./reply/history-store";
import { ConversationLearner } from "./reply/conversation-learner";
import { collectRelearnSamples } from "./reply/relearn";
import { buildDistillPrompt, cleanDistilledRules } from "@cortex-work/core/reply/memory";
import type { ReplyRelearnResult } from "./ipc/reply-types";
import { ReplyDistiller } from "./reply/distill";
import { chatComplete, REPLY_TEMPERATURES } from "./reply/draft-generator";
import { resolveReplyModel } from "./reply/resolve-model";
import { getPersistedState, purgeLegacyPlaintextCredentials, migrateMediaGenPlaintextKeys } from "./ipc/store";
// 用户记忆做梦管线（跨工作台持久记忆,与 reply 域独立）。
import { Dreamer } from "./memory/dreamer";
import { initMemoryDream } from "./memory/dream-scheduler";
import { readEpisodicInputs } from "./memory/episodic-source";
import { userMemoryStore, dreamStateStore, setMemoryDreamer } from "./ipc/memory";
import { postChatCompletion } from "./ipc/openai-chat";
import { getDefaultModelRef } from "./providers/default-model";
import type { DreamPrompt } from "@cortex-work/core/memory/dream-prompt";
import { getDesktopBehavior, initDesktopBehavior, registerDesktopHandlers } from "./desktop-behavior";
import { initLogger, patchConsole, registerLogHandlers } from "./logger";
import { getRuntimeAppVersion } from "./app-version";
import { installGlobalCrashGuards } from "./crash-guards";
import { ensureProcessPath } from "./ipc/cli";
import { isPiGatewayEnabled } from "./agents/pi-inproc";
import { primePiGatewayRuntime, shutdownPiGatewayRuntime } from "./agents/pi-gateway/client";
import { installAppMenu } from "./app-menu";
import { createLogger } from "./log";
import { createMainWindowOptions } from "./main-window-geometry";

const log = createLogger("main");

// 进程级崩溃兜底必须最先安装:历史崩溃为「异步 fs 扫描回调/漂浮 Promise 抛未捕获错误」
// → 主进程整体 SIGTRAP 退出。装在所有初始化之前,确保后续任何未捕获异常/拒绝只记日志、
// 不杀进程(ipcMain.handle 链内的 reject 由 Electron 转发渲染端,不会到这里)。
installGlobalCrashGuards();

// PATH 补齐要早于任何 spawn / 包管理调用:GUI 启动（Finder/Dock,不经登录 shell）的主进程
// PATH 里通常没有 nvm / homebrew 的 node 与 npm。走 spawnEnvFor 的路径本来就会经 buildEnv()
// 补齐,但第三方库自己 spawn 时只认 process.env（如 pi SDK 的 DefaultPackageManager 起 npm 装包）。
// 只增不减、幂等,故对既有 spawn 行为无影响。
ensureProcessPath();

// petdex 图鉴的 cortex-petdex:// 只读协议:特权注册必须发生在 app.ready 之前,
// 故放在模块顶层而非 whenReady 回调里(晚了 Electron 会拒绝注册)。
registerPetdexScheme();

const appIconPath = join(__dirname, "../../assets/cortex-neuron-icon.png");

let mainWindow: BrowserWindow | null = null;
// 真正退出标志:仅托盘「退出」/ before-quit 时置 true。关窗(X)默认只隐藏到后台。
let isQuitting = false;
let realQuitCleanupStarted = false;
// 闪记全局热键被占用时的降级提示文案(register 早于建窗,暂存待主窗口就绪后 best-effort 推送)。
let notesHotkeyToast: string | null = null;
// 当前已注册的闪记热键 accelerator(精确 unregister 用,避免 unregisterAll 误伤其它全局键)。
// 空串 = 当前无任何已注册绑定。
let currentNotesAccelerator = "";

// 精确解绑当前已注册的闪记热键(若有),并清空 currentNotesAccelerator。
// 仅解绑自己注册的那一个,不调 unregisterAll(避免误伤其它全局键)。
function unregisterNotesHotkey(): void {
  if (!currentNotesAccelerator) return;
  try {
    globalShortcut.unregister(currentNotesAccelerator);
  } catch {
    // 解绑失败忽略(可能本就未注册)。
  }
  currentNotesAccelerator = "";
}

// 注册闪记热键:先精确解绑当前已注册的旧键,再注册新键。仅在 register 成功时
// 更新 currentNotesAccelerator。返回 resolveHotkeyRegistration 归一化结果。
// 注意:不做格式校验(调用方保证 accelerator 合法),也不调 unregisterAll。
function registerNotesHotkey(accelerator: string): HotkeyRegistration {
  unregisterNotesHotkey();
  const ok = globalShortcut.register(accelerator, toggleNotesOverlay);
  if (ok) currentNotesAccelerator = accelerator;
  return resolveHotkeyRegistration(ok);
}

// ── 快捷回复助手（reply，U7）生命周期 ─────────────────────────────────────────────
// 仅 macOS：非 mac 平台完全不 spawn helper、不注册任何 reply 入口（守卫在 initReply 调用处）。
let replyHelper: ReplyHelperClient | null = null;
let replyFallbackRegistered = false;
let dictationController: DictationController | null = null;
// 首次聊天键需要异步读取原前台窗口；其间后续按键只能登记为停止请求，不能并发读取并覆盖
// 已冻结的 pid。这样「快按两次」也能在浮层加载完成后稳定地开始再停止。
let openingVoiceChatPromise: Promise<void> | null = null;
let pendingVoiceChatStop = false;

/** 在浮层获得焦点前冻结原前台 app 的 pid，供可选屏幕上下文准确截图。 */
function openVoiceChatFromHotkey(): Promise<void> {
  // 第二次按聊天键是「停止并提交」，此时浮层已经是前台窗口。绝不能重新冻结 pid，
  // 否则会把首次唤起时正确保存的原应用上下文替换成 Cortex 自己。
  if (getVoiceChatWindow()?.isVisible()) {
    toggleVoiceChatFromHotkey();
    return Promise.resolve();
  }

  if (openingVoiceChatPromise) {
    pendingVoiceChatStop = true;
    return openingVoiceChatPromise;
  }

  const opening = (async (): Promise<void> => {
    try {
      const snapshot = replyHelper ? await replyHelper.axCapture() : null;
      const pid = snapshot && typeof snapshot.pid === "number" ? snapshot.pid : null;
      setVoiceChatScreenContextPid(pid);
    } catch {
      // 没有 AX 权限时仍允许打开聊天；截图请求会返回可见错误而非错误截取 Cortex 浮层。
      setVoiceChatScreenContextPid(null);
    }
    toggleVoiceChatFromHotkey();
    if (pendingVoiceChatStop) {
      pendingVoiceChatStop = false;
      toggleVoiceChatFromHotkey();
    }
  })();
  openingVoiceChatPromise = opening;
  void opening.finally(() => {
    if (openingVoiceChatPromise === opening) openingVoiceChatPromise = null;
  });
  return opening;
}

// 注册 reply 兜底 accelerator（KTD7）：辅助功能未授权 / helper 降级时以此组合键手动触发起草。幂等。
function registerReplyFallbackHotkey(): void {
  if (replyFallbackRegistered) return;
  const ok = globalShortcut.register(REPLY_HOTKEY_ACCELERATOR, triggerReplyDraft);
  if (ok) replyFallbackRegistered = true;
  else log.warn(`[reply] 兜底热键 ${REPLY_HOTKEY_ACCELERATOR} 被占用,无法降级到快捷键入口`);
}

// 精确解绑 reply 兜底键（切回手势模式时）。
function unregisterReplyFallbackHotkey(): void {
  if (!replyFallbackRegistered) return;
  try {
    globalShortcut.unregister(REPLY_HOTKEY_ACCELERATOR);
  } catch {
    // 忽略（可能本就未注册）。
  }
  replyFallbackRegistered = false;
}

// 依辅助功能授权在「手势模式」与「兜底 accelerator」间切换（KTD7）：
// 授权 → 起 events 长驻 tap（双击起草键手势）并撤兜底键；未授权 → 只挂兜底键、不 spawn events
// （免在未授权时反复建 tap → 立即降级的空转）。授权后再次调用（如 resume）即自动切回手势。
async function syncReplyInputMode(): Promise<void> {
  if (!replyHelper) return;
  let granted = false;
  try {
    const helper = replyHelper;
    const perms = await queryReplyPermissions(() => helper.permissions(), process.platform, undefined, log);
    granted = perms.accessibility === "granted";
  } catch (err) {
    log.warn("[reply] 权限查询失败,降级到兜底热键", err);
  }
  if (granted) {
    unregisterReplyFallbackHotkey();
    replyHelper.startEvents();
  } else {
    registerReplyFallbackHotkey();
  }
}

// ── 用户记忆（做梦式持久记忆）接线 ─────────────────────────────────────────────
// 跨平台（区别于 macOS-only 的 reply 域）。做梦调度的清理函数,真正退出时调用。
let stopMemoryDream: (() => void) | null = null;

// 初始化用户记忆做梦管线：组装 Dreamer 依赖（LLM 直连 + 存储 + 推送）,注入 IPC 域,
// 启动混合触发调度（深睡 03:00 / 启动与唤醒补跑 / 会话空闲小睡）。
function initUserMemory(): void {
  const memoryLog = createLogger("memory");
  // 做梦蒸馏的 LLM 闭包：经 Pi Model Gateway 出站,模型走全局默认（resolveReplyModel 传 null
  // settings 即跳过 reply 专属级,纯函数复用）;未配置时抛错,被 Dreamer catch 后静默跳过、水位不动。
  // 全局默认已被 §5 清理时同样落到这条抛错分支——做梦是后台行为,宁可跳过也不能自动挑一个模型。
  const dreamGenerate = async (prompt: DreamPrompt): Promise<string> => {
    const target = resolveReplyModel(null, await getDefaultModelRef());
    if (!target) throw new Error("memory: 生成模型未配置，跳过做梦整理");
    return postChatCompletion({
      providerId: target.providerId,
      modelId: target.modelId,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      // 低温求确定：提炼稳定事实,不要发散（对齐 reply 蒸馏的 0.2）。
      temperature: 0.2,
    });
  };
  const dreamer = new Dreamer({
    // 记忆总开关：显式 false 才关（缺省开启,与渲染端 buildMemoryAppend 门控一致）。
    isEnabled: async () => (await getPersistedState()).generalSettings?.memoryEnabled !== false,
    getEpisodes: () =>
      readEpisodicInputs({
        chatsDir,
        // 会话标题来自 personal-workspace.json 的 sessions 元数据（喂给蒸馏 prompt 做上下文标注）。
        getSessionTitles: async () => {
          const sessions = (await getPersistedState()).sessions ?? [];
          return new Map(sessions.map((s) => [s.id, s.title] as const));
        },
        logger: memoryLog,
      }),
    getExistingAuto: async (scope) => (await userMemoryStore.getMemory())[scope].auto,
    generate: dreamGenerate,
    persistLearned: (scope, auto) => userMemoryStore.setFile(scope, { auto }),
    stateStore: dreamStateStore,
    // 做梦写回后推全量记忆给渲染端刷新只读缓存（buildMemoryAppend 下一轮即用新记忆）。
    onMemoryChanged: () => {
      void userMemoryStore
        .getMemory()
        .then((memory) => mainWindow?.webContents.send("memory:changed", memory));
    },
    logger: memoryLog,
  });
  setMemoryDreamer(dreamer);
  stopMemoryDream = initMemoryDream({
    dreamNow: (trigger) => dreamer.dreamNow(trigger),
    getLastDreamAt: async () => (await dreamStateStore.load()).lastDreamAt,
    logger: memoryLog,
  });
}

// 初始化 reply 编排器 + helper 生命周期（仅 macOS 调用）。
async function initReply(): Promise<void> {
  replyHelper = new ReplyHelperClient({
    binaryPath: resolveReplyHelperBinary(),
    logger: createLogger("Cortex_Helper"),
    onEvent: (event) => {
      if (event.event === "dictation-start") void dictationController?.holdStart();
      else if (event.event === "dictation-end") void dictationController?.holdEnd();
      else getReplyController()?.handleEvent(event);
    },
    // tap 不可用 / events 连续崩溃超上限 → 兜底 accelerator 接管（helper-client 内部触发）。
    onDegrade: () => registerReplyFallbackHotkey(),
  });
  // 权限中心 IPC（reply:getPermissions）的 helper 兜底源：与 syncReplyInputMode 用同一 one-shot 命令。
  const helperForPerms = replyHelper;
  // 听写与快捷回复共用唯一 events helper。controller 固定录音开始时的前台 pid，
  // 结果回来再复查后才通过 helper.paste 写入，防止用户切窗时口述内容泄露到错误应用。
  dictationController = new DictationController({
    helper: helperForPerms,
    settings: async () => ({
      dictationBarAlwaysVisible: (await getPersistedState()).voiceSettings?.dictationBarAlwaysVisible ?? false,
    }),
    pushState: pushDictationBarState,
    // 转写 LLM 纠错(voiceSettings.transcriptPolish 门控;失败/未配模型静默回退原文)。
    polish: polishTranscriptIfEnabled,
  });
  setDictationResultHandler((result) => dictationController?.handleResult(result));
  setVoiceScreenshotProvider(() => {
    const pid = getVoiceChatScreenContextPid();
    // 不能把 null 退化为 helper.screenshot()：浮层获得焦点后，该无参数分支会截到 Cortex 自己。
    if (pid == null) return Promise.reject(new Error("无法确定语音聊天唤起前的前台窗口"));
    return helperForPerms.screenshot(pid);
  });
  const syncDictationHoldHotkey = (holdHotkey: string): void => {
    const mapped = holdHotkey ? mapAcceleratorToMacKeyCode(holdHotkey) : null;
    // 传空 modifiers 是 Swift 协议中明确的「禁用」配置，不能只省略字段；省略会让 events
    // 进程继续保留上一组按住键，造成设置页已清除但仍暗中吞键的危险裂脑。
    helperForPerms.sendConfig({
      dictation: mapped?.ok ? mapped.config : { modifiers: [], keyCode: null },
    });
  };
  setVoiceHotkeyCallbacks({
    onDictationToggleHotkey: () => void dictationController?.toggle(),
    onVoiceHotkeysChanged: (hotkeys) => syncDictationHoldHotkey(hotkeys.dictationHoldHotkey),
  });
  const voiceSettings = (await getPersistedState()).voiceSettings;
  syncDictationHoldHotkey(voiceSettings?.dictationHoldHotkey ?? "");
  // 「始终显示」是持久化承诺，不能等用户下一次触发快捷键才出现；showInactive 保持原 app 焦点。
  if (voiceSettings?.dictationBarAlwaysVisible) pushDictationBarState("idle", true);
  setReplyHelperPermissionsSource(() => helperForPerms.permissions());
  // 日历 MCP 能力（capabilities/calendar）共用同一个 helper 二进制。
  // 注入放在这里（而非 whenReady）本身就是门控：initReply 只在 darwin 上调用，
  // 非 mac 上 helper 恒为 null → buildCalendarMcpServerConfig 自然返回 null，
  // 不必把平台判断散落到两处。
  setCalendarHelper(helperForPerms);
  // reply 生成模型解析（KTD3）：每次唤起/蒸馏时现解析——最新 reply 设置（快照）+ 全局默认模型
  // 走回退链（专属 → 全局默认 → null）。现解析保证设置变更即时生效，无需快照同步机制。
  const resolveModel = async () =>
    resolveReplyModel(getLastReplySnapshot()?.settings ?? null, await getDefaultModelRef());
  // 语气蒸馏（U10 / R11）：写回成功 → 采样 → 后台模型直连蒸馏（温度 0.2）→ 分区 auto 要点回推渲染端持久化。
  // generate 闭包走 chatComplete 取原始输出（不套 cleanAgentOutput，交 cleanDistilledRules 过滤）；
  // 生成模型未配置时抛错，被蒸馏器 catch 后静默跳过。
  const distiller = new ReplyDistiller({
    getSnapshot: getLastReplySnapshot,
    generate: async (prompt) => {
      const target = await resolveModel();
      if (!target) throw new Error("reply: 生成模型未配置，跳过蒸馏");
      return chatComplete({ prompt, target, temperature: REPLY_TEMPERATURES.distill });
    },
    // 读某分区已学 auto 要点（KTD6 修订：main-owned memory-store 为唯一真源）。
    getExistingAuto: async (scope) => (await replyMemoryStore.getMemory())[scope].auto,
    // 持久化 sink（KTD6 修订）：直写 memory-store（main 唯一写者），随后推全量记忆给渲染端
    // 刷新设置页缓存。只落要点、不落样本（KTD8：样本不落盘）。
    persistLearned: (scope, auto) => {
      void replyMemoryStore
        .setFile(scope, { auto })
        .then(async () =>
          mainWindow?.webContents.send("reply:memoryChanged", await replyMemoryStore.getMemory()),
        );
    },
    logger: createLogger("reply-distill"),
  });
  // 「立即重新学习」（源项目 relearn 恢复版）：依据已落盘回复历史（KTD8 修订后的样本来源）
  // 重建 im/email 分区的语气要点——existingAuto 传空串是刻意的：relearn 语义是从头重建而非
  // 增量合并。成功后失效蒸馏器 localAuto 缓存并推送记忆刷新。用户显式点击即为授权，不受
  // learningEnabled 后台开关门控。
  const relearnFromHistory = async (): Promise<ReplyRelearnResult> => {
    const entries = await replyHistoryStore.list();
    if (entries.length === 0) return { ok: false, error: "no-history" };
    const buckets = collectRelearnSamples(entries);
    if (buckets.size === 0) return { ok: false, error: "no-samples" };
    const target = await resolveModel();
    if (!target) return { ok: false, error: "model-not-configured" };
    let learned = 0;
    for (const [scope, samples] of buckets) {
      try {
        const prompt = buildDistillPrompt(scope, samples, "");
        const output = await chatComplete({ prompt, target, temperature: REPLY_TEMPERATURES.distill });
        const rules = cleanDistilledRules(output);
        if (rules.length === 0) continue; // 模型只吐解释：该分区跳过，不清空原有要点
        await replyMemoryStore.setFile(scope, { auto: rules });
        learned += 1;
      } catch (err) {
        log.warn("[reply] 重新学习失败:", err);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    distiller.resetLocalAuto();
    mainWindow?.webContents.send("reply:memoryChanged", await replyMemoryStore.getMemory());
    return { ok: true, learned };
  };
  setReplyRelearnHandler(relearnFromHistory);

  // 对话级记忆蒸馏器：写回成功 → 后台蒸馏「关于对话对象的事实/偏好」→ 写回 conversation-store。
  // 与 ReplyDistiller 共用同一 generate 通道（供应商直连，温度 0.2），互不缠绕（分桶键/采集目标不同）。
  const conversationLearner = new ConversationLearner({
    getSnapshot: getLastReplySnapshot,
    generate: async (prompt) => {
      const target = await resolveModel();
      if (!target) throw new Error("reply: 生成模型未配置，跳过对话记忆蒸馏");
      return chatComplete({ prompt, target, temperature: REPLY_TEMPERATURES.distill });
    },
    getExistingSummary: (bundleId, counterpart) => replyConversationStore.getSummary(bundleId, counterpart),
    persistSummary: (update) =>
      replyConversationStore.setSummary({
        appBundleId: update.appBundleId,
        appName: update.appName,
        counterpart: update.counterpart,
        summary: update.summary,
        now: Date.now(),
      }),
    logger: createLogger("reply-conv-learner"),
  });
  // 历史存档 sink（KTD8 边界修订，经用户确认）：只记已采纳写回的会话，含对话原文与
  // 当轮全部候选，落 ~/.cortex-desktop/reply/history.json。historyEnabled 关（或快照
  // 缺失）→ 零副作用；append 内部串行落盘且吞错，不阻塞、不打扰写回主流程。
  const recordReplyHistory = (info: DraftAcceptedInfo): void => {
    const settings = getLastReplySnapshot()?.settings;
    if (!settings?.historyEnabled) return;
    void replyHistoryStore.append({
      id: newReplyHistoryId(),
      ts: Date.now(),
      appName: info.appName,
      appBundleId: info.appBundleId,
      counterpart: info.counterpart,
      conversation: info.conversation,
      candidates: info.candidates,
      acceptedIndex: info.acceptedIndex,
      acceptedText: info.draft,
    });
  };
  initReplyController({
    helper: replyHelper,
    getSnapshot: getLastReplySnapshot,
    // 生成模型解析（KTD3 回退链）：null → 气泡 modelNotConfigured 错误态引导去设置，不回退 agent CLI。
    resolveModel,
    // 语音意图转写用的 ASR 配置：从个人工作区持久化态读取（内存镜像，store:save 即时刷新）。
    getAsrSettings: async () => (await getPersistedState()).asrSettings ?? null,
    // 写回成功 → fan-out 给三个消费者：语气蒸馏（学习开关门控）+ 历史存档（历史开关门控）
    // + 对话级记忆（学习开关门控：最近回复即时记录，摘要走 learner 后台蒸馏）。
    onDraftAccepted: (info) => {
      distiller.onDraftAccepted(info);
      recordReplyHistory(info);
      if (getLastReplySnapshot()?.settings.learningEnabled) {
        void replyConversationStore.recordAccepted({
          appBundleId: info.appBundleId,
          appName: info.appName,
          counterpart: info.counterpart,
          draft: info.draft,
          now: Date.now(),
        });
        conversationLearner.onDraftAccepted(info);
      }
    },
    // 起草时按 app+counterpart 注入对话级记忆段（无记录 → 空串跳段）。
    getConversationMemory: (bundleId, counterpart) => replyConversationStore.getComposed(bundleId, counterpart),
    // 全局分区记忆现读（KTD6 修订：main-owned memory.json，快照不再携带 memory）。
    getMemoryState: () => replyMemoryStore.getMemory(),
    // 气泡「去设置」：显示主窗 + 通知渲染端打开设置页并跳到快捷回复分区（仅 showMainWindow 时窗口
    // 已可见则看似无反应，故须再发导航事件）。渲染端监听 reply:openSettings 调 openSettings("reply")。
    onOpenSettings: () => {
      showMainWindow();
      mainWindow?.webContents.send("reply:openSettings");
    },
    logger: createLogger("reply"),
  });
  await syncReplyInputMode();
}

function normalizedOS(): "macos" | "windows" | "linux" | "unknown" {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}

function createWindow(): void {
  // macOS:启用原生侧栏 vibrancy(NSVisualEffectView「sidebar」材质),让左侧菜单栏透出桌面壁纸,
  // 并随壁纸明暗自适应磨砂质感。要让材质透出,窗口背景必须透明(#00000000)——否则不透明底色会盖在
  // vibrancy 之上;非 macOS 保持原不透明底色。CSS 侧由渲染端 <html data-vibrancy="sidebar"> 驱动,
  // 把侧栏背后的背景链一路打透到窗口(见 packages/views/cortex-desktop/cortex-desktop.css §Sidebar vibrancy)。
  // 二者门控条件一致——都仅 macOS;此处不设 transparent:true(那是给镂空/穿透窗用的,会让 vibrancy 失效)。
  const isMacOS = process.platform === "darwin";
  mainWindow = new BrowserWindow(createMainWindowOptions({
    isMacOS,
    icon: appIconPath,
    preload: join(__dirname, "../preload/index.js"),
  }));

  // 启动最小化：不显示主窗口（仅托盘常驻）;否则就绪即显示。
  mainWindow.on("ready-to-show", () => {
    if (!getDesktopBehavior().startMinimized) mainWindow?.show();
  });

  // 关窗：closeToTray 开 → 隐藏到后台（托盘常驻,定时任务继续触发）;关 → 关窗即退出。
  // 真正退出（托盘退出 / before-quit）置 isQuitting,直接放行。
  mainWindow.on("close", (e) => {
    if (isQuitting) return;
    if (getDesktopBehavior().closeToTray) {
      e.preventDefault();
      mainWindow?.hide();
      // macOS 兜底:万一进程类型仍残留在 accessory(曾切过),hide 到托盘后 Dock 图标会消失。
      // 显式 dock.show() 拉回 regular,保证「关窗隐藏到托盘、Dock 图标继续保留、可从程序坞点回」。
      if (process.platform === "darwin") void app.dock?.show();
    } else {
      markRealQuit();
      app.quit();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  // 主窗重获焦点 → 清空独立通知窗体(回到应用即不再用外部窗体打扰;应用内 toast 接管)。
  mainWindow.on("focus", () => clearNotifications());

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function markRealQuit(): void {
  isQuitting = true;
}

// 显示主窗口（隐藏则恢复,已销毁则重建）。托盘点击 / 第二实例 / activate 共用。
function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

// 单实例锁:防止多开导致多个调度器重复触发同一定时任务。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

  // 同步 app 信息给 preload 桥。
  ipcMain.on("app:get-info", (event) => {
    event.returnValue = {
      version: getRuntimeAppVersion(),
      os: normalizedOS(),
      devMode: is.dev && !!process.env["ELECTRON_RENDERER_URL"],
    };
  });

  // 闪记热键降级提示:渲染端 mount 后拉取一次性消费(consume-pending,仿 spotlight,
  // 避免 push 早于 listener 注册而丢提示);无降级返回 null。
  ipcMain.handle("notes:consumeHotkeyDegraded", () => {
    const t = notesHotkeyToast;
    notesHotkeyToast = null;
    return t;
  });

  // 渲染端在设置里改闪记热键 → 主进程即时重注册(仿 desktop:setBehavior 的即时通路)。
  // 流程:格式校验 → 构造三级兜底候选链(新键 → 旧键 → 默认键,去重)→ 先精确解绑当前键 →
  // 逐个 register,首个成功即停 → resolveRebindChain 决策。三级全失败则无可用绑定、明确降级。
  // 返回 HotkeyRegistration(preload 适配成 bridge 契约 { ok, toast })。
  ipcMain.handle("notes:setHotkey", (_e, acc: string): HotkeyRegistration => {
    if (!isValidAccelerator(acc)) {
      return { registered: false, degraded: true, toast: NOTES_HOTKEY_INVALID_TOAST };
    }
    const oldAcc = currentNotesAccelerator;
    const candidates = rebindCandidates(acc, oldAcc);
    // 先解绑当前键,再逐个尝试候选;首个 register 成功即停,记录其下标。
    unregisterNotesHotkey();
    let successIdx = -1;
    for (let i = 0; i < candidates.length; i += 1) {
      if (globalShortcut.register(candidates[i]!, toggleNotesOverlay)) {
        currentNotesAccelerator = candidates[i]!;
        successIdx = i;
        break;
      }
    }
    const decision = resolveRebindChain(oldAcc, acc, candidates, successIdx);
    return { registered: decision.registered, degraded: decision.degraded, toast: decision.toast };
  });

  app.whenReady().then(async () => {
    // pi gateway 预热（fire-and-forget）：常驻化的收益就在这里兑现——fork + 三包 ESM 加载
    // （每会话冷启动的大头）在建窗前后台完成，用户首次开会话只剩 createAgentSession。
    // 只在选路确为 gateway 时预热：binary/inproc 用户不该白付一个 worker 进程。
    if (isPiGatewayEnabled()) primePiGatewayRuntime();

    electronApp.setAppUserModelId("ai.cortex.work");
    if (process.platform === "darwin" && app.dock) app.dock.setIcon(appIconPath);
    app.on("browser-window-created", (_, window) => optimizer.watchWindowShortcuts(window));

    // 最前接管 console（幂等,默认启用）,捕获 ensureMigrated 等启动期错误入文件日志;
    // initLogger 稍后读设置再调整开关 + 清理过期。
    patchConsole();
    await ensureMigrated();
    // 内嵌浏览器 <webview> 安全闸门须在任何 webview 可能 attach 之前装好(建窗之前)。
    installBrowserWebviewGuards();
    configureBrowserPartition();
    // 真任务系统 v1→v2 迁移：必须在 registerIpcHandlers（store:load/save/tasks:*）之前 eager+await，
    // 使 renderer 的一切 store 访问都排在迁移之后处理，从根上消除「renderer 首个 save 先于迁移
    // 抹掉源 todos」的竞态（数据安全，见 U3/KTD2）。migratedAt 幂等，已迁移则纯 no-op。
    await runTaskMigration();
    registerIpcHandlers({
      update: { beforeInstall: markRealQuit },
      agentTraceDevMode: is.dev && !!process.env["ELECTRON_RENDERER_URL"],
    });
    // 阶段 4 接上聊天键；dictationToggle 回调仍由阶段 5 另行安装。setter 只替换给定字段，
    // 不会重复 ipcMain.handle 或短暂解除本阶段已生效的 globalShortcut。
    setVoiceHotkeyCallbacks({ onChatHotkey: () => void openVoiceChatFromHotkey() });
    registerAgentTraceWindowHandlers({ devMode: is.dev && !!process.env["ELECTRON_RENDERER_URL"] });
    registerDesktopHandlers();
    registerLogHandlers();
    registerSpotlightHandlers({ showMainWindow, getMainWindow: () => mainWindow });
    // 「项目管理」独立窗口 → 主窗口的委派意图中继（KTD10）。lazy getMainWindow：建窗在后（见下方 createWindow）。
    registerProjectsDelegateRelay({ showMainWindow, getMainWindow: () => mainWindow });
    registerNotesOverlayHandlers();
    registerNotificationWindowHandlers();
    registerPetHandlers();
    registerPetdexHandlers(); // 公共宠物图鉴:拉取 + 磁盘缓存 + cortex-petdex:// 协议
    // 内置 agent-browser 默认启用。Chrome 检测/下载在后台进行，不阻塞主窗口和 agent 启动。
    void getPersistedState().then((state) => {
      syncAgentBrowserRuntime(state.generalSettings?.agentBrowser?.enabled !== false);
    }).catch((err) => log.warn("[agent-browser] 启动检查失败", err));
    // Computer Use（pi 操作真实桌面 GUI）默认启用:后台预装 pi-computer-use package 到 ~/.pi。
    // fire-and-forget + marker 幂等——装过就只做一次 statSync,没装过才联网走 npm,失败仅 warn
    // 并在下次启动重试。绝不阻塞建窗（首装可能耗数秒）。
    // 注:总开关关闭时仍预装。预装只是把包放到本地,是否给 Agent 由 inject.ts 的门控决定;
    // 这样用户在设置里打开开关后能立即可用,不必等下次启动。
    void ensureComputerUsePackage().catch((err) => log.warn("[computer-use] 预装失败", err));
    // 研究引擎（CRE）：先同步设置快照,再跑启动恢复（非终态 Session → interrupted、
    // 未提交 operation 标记可重试、清理过期 tmp）。引擎关闭时 runResearchStartupTasks 是
    // no-op——连数据库都不会打开。fire-and-forget:恢复失败已内部降级,不阻塞建窗。
    void getPersistedState()
      .then(async (state) => {
        syncResearchEngineRuntime(state.generalSettings?.researchEngine);
        await runResearchStartupTasks();
      })
      .catch((err) => log.warn("[research] 启动恢复失败", err));
    // 全局热键唤起闪记浮层(全仓首次用 globalShortcut)。读用户配置的 notesHotkey,
    // 无效或缺失则回退默认 NOTES_HOTKEY_ACCELERATOR。register 返回 false = 被占用 →
    // 不抛错,降级到仅窗口图标入口,并把提示文案在主窗口就绪后 best-effort 推给渲染端 toast。
    const configuredHotkey = (await getPersistedState()).generalSettings?.notesHotkey;
    const startupAccelerator =
      configuredHotkey && isValidAccelerator(configuredHotkey) ? configuredHotkey : NOTES_HOTKEY_ACCELERATOR;
    const hotkey = registerNotesHotkey(startupAccelerator);
    if (hotkey.degraded && hotkey.toast) {
      log.warn(`[notes] 全局热键注册失败: ${hotkey.toast}`);
      notesHotkeyToast = hotkey.toast;
    }
    // 语音快捷键默认全关；若用户已在设置中启用，则启动时经与 IPC 相同的事务恢复绑定。
    // 回调暂为 no-op（语音聊天浮层 / 听写 controller 分别在后续阶段接线），这样本阶段先
    // 完整兑现「设置即生效、重启仍生效」而不提前创建窗口或录音资源。
    const voiceHotkeyResults = applyVoiceHotkeys((await getPersistedState()).voiceSettings ?? {
      chatHotkey: "",
      dictationHoldHotkey: "",
      dictationToggleHotkey: "",
    });
    if (Object.values(voiceHotkeyResults).some((result) => !result.ok)) {
      log.warn("[voice] 启动恢复全局快捷键失败", voiceHotkeyResults);
    }
    // 启动恢复桌面行为（登录项 + 供 ready-to-show 读 startMinimized）,须在建窗前。
    await initDesktopBehavior();
    // 日志初始化不得拖垮启动:initLogger 抛错(读设置/清理/electron-log 装配失败)若冒泡,
    // whenReady 续体 reject → 建窗及后续永不执行 → 主窗口永不出现(reliability 评审指出)。
    // console 接管已在更早的 patchConsole() 完成,故此处失败仅丢「读设置/清理」,降级继续。
    try {
      await initLogger();
    } catch (err) {
      console.error("[main] initLogger 失败,降级继续(不阻断建窗)", err);
    }
    // 先建托盘:即使建窗失败也保留后台入口与调度。
    createTray({
      onShow: showMainWindow,
      onQuit: () => {
        markRealQuit();
        app.quit();
      },
      onToggleSpotlight: toggleSpotlight,
    });
    await initScheduler();
    // 阶段③·4.1：抹掉写作 / 日报设置里残留的明文凭据（旧档才有）。
    // 与 providerAuth 那侧的 purgeLegacyProviderSettings 分开：那个删的是整块 providerSettings，
    // 这个只摘掉凭据字段、保留用户调过的行为参数。失败只记日志——抹不掉不该拦住启动。
    void purgeLegacyPlaintextCredentials().catch((err) => {
      log.warn("[store] 清除残留明文凭据失败（下次启动重试）:", err);
    });
    // 媒体生成明文密钥一次性迁移（设计 §4.3）：明文 apiKey → safeStorage 金库 + `${secret:}` 引用。
    // 与上面的 purge 同一注册点、同样不阻断启动；金库不可用 / 失败只记日志，下次启动重试。
    void migrateMediaGenPlaintextKeys().catch((err) => {
      log.warn("[store] 媒体生成明文密钥迁移失败（下次启动重试）:", err);
    });
    // 用户记忆做梦管线（跨平台）：Dreamer 依赖注入 + 混合触发调度。失败不阻断启动。
    try {
      initUserMemory();
    } catch (err) {
      log.error("[memory] 用户记忆初始化失败:", err);
    }
    // 任务提醒调度器（U11）：读初始 opt-in（内部原生通知）+ 当前任务快照建 Cron/补跑错过项。
    // setEnabled 先行（此时快照空，为 no-op），再 sync 真实任务；开机补跑「只补一次」靠 firedAt 闸门。
    {
      const state = await getPersistedState();
      tasksReminderScheduler.setEnabled(isTasksReminderOptInEnabled(state));
      tasksReminderScheduler.sync(await tasksStore.list());
    }
    // 工作流运行时（loop 引擎）：独立于 automation，与之并列。
    // fire-and-forget：调度器初始化快，失败已内部降级，不阻塞建窗。
    const workflowRuntime = initWorkflowRuntime()
    // P1 Fix-2：启动时标记残留的 running run 为 error（崩溃/强退后留下的孤儿 run）。
    // 对齐 automation/scheduler.ts initScheduler 中 markOrphanRunsKilled 的做法。
    markOrphanRunsKilled().catch((err) => {
      log.error('[workflow] markOrphanRunsKilled 失败:', err)
    })
    loadWorkflows().then((workflows) => {
      // P1 Fix-9（去重调度）：只保留一条初始化路径——initWorkflowScheduler 负责 catch-up，
      // sync() 主要负责 webhook server 启停。两者都调用 rescheduleWorkflows/runFn 会导致
      // catch-up 在 initWorkflowScheduler + sync() 内各触发一次（重复 run）。
      // 修：initWorkflowScheduler 做 catch-up + 建 cron job，sync() 只管 webhook server。
      initWorkflowScheduler(workflows, workflowRuntime.runNow)
      workflowRuntime.sync().catch((err) => {
        log.error('[workflow] sync 失败:', err)
      })
    }).catch((err) => {
      log.error('[workflow] loadWorkflows 失败:', err)
    })
    // 浏览器控制 MCP server:随主进程常驻(U2)。工具由 U5 注入;是否注入给 agent 由 U3 按总开关 gate。
    // fire-and-forget:listen 快且失败已内部降级,不阻塞建窗。
    // 注入运行时能力:openPanel 让 agent 的 browser_navigate 在面板未开时打开内置浏览器(经渲染端)。
    void startMcpHost((mcp, toolCtx) =>
      registerBrowserTools(mcp, toolCtx, {
        openPanel: (url) => mainWindow?.webContents.send("browser:open-panel", url),
      }),
    );
    // 文档抽取 MCP host:独立实例(独立 port/token),常驻可用;agent 经 extract_document 按需读附件。
    void startDocExtractHost();
    // 媒体生成 MCP host:独立实例,常驻;四模态全关时注入侧返回 null 不连接,host 仍在后台静默运行(U5)。
    void startMediaGenHost();
    // Loop 工作流 MCP host:独立实例,常驻;无 enabled+callable 工作流时注入侧返回 null（U14）。
    void startLoopWorkflowsHost();
    // 委派 MCP host:独立实例,常驻;本轮无被 @ 协作者时注入侧返回 null。主 agent 经 ask_<id> 自主委派。
    void startDelegateHost();
    // 设计委派 MCP host:给设计工作台多页并行提供 delegate_task 工具。
    void startDesignDelegateHost();
    // 研究 MCP host:给 agent 提供 web_search / web_read（+ 开了深度研究时的 deep_research）。
    // 常驻;研究引擎未开启或搜索后端未配置时,注入侧返回 null 不连接。
    void startResearchHost();
    // 自动化 MCP host:让 agent 在会话中管理定时任务。常驻;总开关关闭时注入侧返回 null。
    void startAutomationHost();
    // 系统日历 MCP host:常驻;非 macOS / 未取得「完全访问」授权时注入侧返回 null。
    void startCalendarHost();
    // 安装自定义主菜单(去除 macOS View 菜单重复的全屏项),须在建窗前就位。
    installAppMenu();
    createWindow();
    // 桌面宠物 overlay 窗口:懒加载单例,随主窗口一起起(不等用户触发,宠物默认显示)。
    ensurePetOverlayWindow();

    // 快捷回复助手（U7）：仅 macOS 接线（非 mac 完全不 spawn helper / 不注册 reply 入口）。
    // fire-and-forget：权限查询 + helper spawn 失败已内部降级到兜底热键，不阻塞建窗。
    if (process.platform === "darwin") {
      void initReply().catch((err) => log.error("[reply] 初始化失败:", err));
    }

    app.on("activate", () => {
      // 排除 Spotlight / 闪记浮层 / 宠物 overlay:避免「主窗口已关、只剩浮窗」时点 Dock 不重建主窗口。
      const real = BrowserWindow.getAllWindows().filter(
        (w) =>
          w !== getSpotlightWindow() &&
          w !== getNotesOverlayWindow() &&
          w !== getAgentTraceWindow() &&
          w !== getPetOverlayWindow(),
      );
      if (real.length === 0) createWindow();
      else showMainWindow();
    });

    // 休眠唤醒后补漏 + 重建定时器（内存定时器在睡眠期间会漂移/错过）。
    powerMonitor.on("resume", () => {
      void rescheduleAll();
      // 唤醒后重估 reply 输入模式：睡眠期间用户可能刚授权辅助功能 → 自动切回手势（KTD7）。
      if (process.platform === "darwin") void syncReplyInputMode();
      // 同理失效日历授权缓存：睡眠期间用户可能刚在系统设置里改过日历权限。
      invalidateCalendarAccessCache();
    });
  });

  // 关窗后所有平台都常驻后台（托盘）。清理交互式会话/终端/监听（renderer 已无,
  // 事件无人接收）,但 automation 调度器与 runningAutomations 独立存活,不受影响。
  // 不调用 app.quit()。
  app.on("window-all-closed", () => {
    killAllCli();
    killAllAsk();
    killAllPiSessions();
    // pi gateway 常驻 worker：会话已随上一行逐个 close，这里收掉进程本身。
    // 窗口关闭即收（而不是留到 app 退出）：无窗口时不该有 pi runtime 挂着吃内存。
    shutdownPiGatewayRuntime();
    killAllPty();
    closeAllWatchers();
    killAllOrchestrations(); // 编排链路随窗口关闭终止（chat 级进程，不同于 automation）
    killAllRoundtables(); // 圆桌编排随窗口关闭终止
    killAllDelegates(); // 委派编排随窗口关闭终止
    killAllDesignDelegates(); // 设计委派随窗口关闭终止
    clearAllSlidesSessions(); // Slides 会话状态随窗口关闭失效
  });

  // 真正退出（托盘退出 / 系统关机）:停调度 + 终止所有自动化进程 + 常规清理。
  const onRealQuit = () => {
    if (realQuitCleanupStarted) return;
    realQuitCleanupStarted = true;
    markRealQuit();
    stopScheduler();
    stopMemoryDream?.(); // 停做梦调度（深睡 Cron + 补跑监听 + 小睡计时器）
    tasksReminderScheduler.stop(); // 停任务提醒 Cron + 释放 powerSaveBlocker
    stopMcpHost();
    stopDocExtractHost();
    stopMediaGenHost();
    stopLoopWorkflowsHost();
    stopDelegateHost();
    stopDesignDelegateHost();
    stopResearchHost();
    stopAutomationHost();
    stopCalendarHost();
    stopSlidesHost();
    clearAllSlidesSessions();
    killAllAutomations();
    killAllWorkflows();
    killAllOrchestrations(); // 编排链路回收（真正退出时）
    killAllRoundtables(); // 圆桌编排回收
    killAllDelegates(); // 委派编排回收
    killAllDesignDelegates(); // 设计委派回收
    killAllCli();
    killAllAsk();
    killAllPiSessions();
    shutdownPiGatewayRuntime(); // 常驻 worker 与 Research Worker 同理,不随主进程退出自动消失
    killAllPty();
    killAllResearchWorkers(); // Research Worker(utilityProcess)不随主进程退出自动消失,必须显式杀
    closeAllWatchers();
    destroyTray();
    destroySpotlight();
    destroyNotesOverlay();
    destroyAgentTraceWindow();
    destroyNotificationWindow();
    destroyPetOverlayWindow();
    // reply（U7）：停 events 长驻进程 + 释放编排器 + 解绑兜底键（气泡窗随窗口体系统一销毁）。
    disposeReplyController();
    replyHelper?.stopEvents();
    replyHelper = null;
    dictationController = null;
    setDictationResultHandler(null);
    setVoiceScreenshotProvider(null);
    destroyDictationWindow();
    unregisterReplyFallbackHotkey();
    globalShortcut.unregisterAll();
  };
  app.on("before-quit", onRealQuit);
  // 自动更新「重启更新」(autoUpdater.quitAndInstall)会先关窗口再正常退出;
  // 若不提前进入真实退出态,closeToTray 会把窗口关动作拦成 hide,导致安装流程卡住。
  // before-quit-for-update 是 Electron 原生 autoUpdater 事件,不是 app 事件。
  electronAutoUpdater.on("before-quit-for-update", onRealQuit);
}

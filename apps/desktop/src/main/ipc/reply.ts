// 快捷回复助手（reply）IPC 域 —— U5 骨架。
//
// 本文件只搭「渲染端 → 主进程」的通道形状，返回空实现 / 内存 stub；真正的原生能力
// （权限查询、渠道 fetch + safeStorage 加密、调试环形缓冲、起草触发、设置快照消费）
// 由 U7（controller / debug-log / draft-generator）与 U9（渠道校验 fetch）填实。
//
// 通道命名与 preload personal.reply* / DesktopBridge 的 reply* 方法一一对应。
// 仿 ipc/notification-window.ts 的注册风格（一个 registerXxxHandlers 收口）。

import { ipcMain, safeStorage, shell } from "electron";
import type {
  ChannelId,
  ReplyBubbleAction,
  ReplyBubbleVoiceResult,
  ReplyChannelVerifyResult,
  ReplyDataSummary,
  ReplyDebugEntry,
  ReplyPermissionKind,
  ReplyPermissionState,
  ReplyRelearnResult,
  ReplySyncSnapshot,
} from "./reply-types";
// 回复历史 / 对话级记忆 / 全局分区记忆存储（main-owned 文件，~/.cortex-desktop/reply/ 下；
// 写入方为 index.ts 的 onDraftAccepted sink 与蒸馏管线，此处注册读写/清空 handler，共用单例）。
import { promises as fsp } from "fs";
import { ReplyHistoryStore } from "../reply/history-store";
import { ReplyConversationStore } from "../reply/conversation-store";
import { ReplyMemoryStore } from "../reply/memory-store";
import {
  replyConversationMemoryPath,
  replyDataDir,
  replyEventsDir,
  replyHistoryPath,
  replyMemoryDir,
  replyMemoryPath,
} from "../paths";
import { getPersistedState } from "./store";
import type { MemoryFile, MemoryScope, MemoryState } from "./reply-types";
import { createLogger } from "../log";
// 权限真实查询（node-mac-permissions → helper 兜底 → 全未决），U9 权限中心消费。
import {
  normalizeCalendarAccess,
  queryReplyPermissions,
  requestReplyPermissionAccess,
  type CalendarAccessState,
  type HelperPermissionsFn,
} from "../reply/permissions";
import { openReplyPermissionSettings } from "../reply/permission-settings";
import { invalidateCalendarAccessCache } from "../capabilities/calendar/helper";
import {
  resizeReplyBubble,
  dispatchReplyBubbleAction,
  dispatchReplyBubbleVoiceResult,
} from "../reply/bubble-window";
// U7 controller 填实起草触发与调试记录读取（controller 单例不依赖本模块，单向引用无环）。
import { triggerReplyDraft, getReplyDebugEntries } from "../reply/controller";
// 渠道请求构造/响应解析纯函数在 core（app 可依赖 core，反向禁止）。
import type { ChannelRequest, VerifiedIdentity } from "@cortex-work/core/reply/channels";
import {
  makeSlackRequest,
  parseSlack,
  makeLarkRequest,
  parseLark,
  makeGoogleRequest,
  parseGoogle,
  ChannelVerifyError,
} from "@cortex-work/core/reply/channels";

// ── 渠道校验（构造请求 + 解析响应，纯函数在 core；此处只做网络往返与错误归一化）──────

// 渠道校验 fetch 超时（毫秒）：主进程 fetch 无默认超时，对端「连上但不回包」时
// Promise 永不 settle，渲染端连接中无限转圈。用 AbortSignal.timeout 兜底强制中止。
const CHANNEL_VERIFY_TIMEOUT_MS = 10_000;

/// 按渠道分派请求构造 + 响应解析器；不支持的渠道（日历类）返回 null。
function channelVerifier(
  channelId: ChannelId,
  token: string,
): { request: ChannelRequest; parse: (raw: string) => VerifiedIdentity } | null {
  switch (channelId) {
    case "slack":
      return { request: makeSlackRequest(token), parse: parseSlack };
    case "lark":
      return { request: makeLarkRequest(token), parse: parseLark };
    case "gmail":
      // Gmail 粘贴的是 Google access token → tokeninfo 校验（env 凭据流程见后续）。
      return { request: makeGoogleRequest(token), parse: parseGoogle };
    default:
      return null;
  }
}

/// 校验渠道凭据：core 构造请求 → main 侧 fetch → core 解析 → safeStorage 加密 token。
/// Slack/Lark 业务失败也返回 HTTP 200（读 ok/code 判定），故非 2xx 才归为 httpStatus（对齐源项目 send）。
async function verifyChannel(channelId: ChannelId, token: string): Promise<ReplyChannelVerifyResult> {
  const verifier = channelVerifier(channelId, token);
  if (!verifier) {
    return { ok: false, errorKind: "invalidResponse", errorDetail: "unsupported-channel" };
  }
  try {
    const { request, parse } = verifier;
    const res = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // 超时兜底：到点由 AbortSignal.timeout 抛 TimeoutError 中止 fetch（见下方 catch 归一化）。
      signal: AbortSignal.timeout(CHANNEL_VERIFY_TIMEOUT_MS),
    });
    // 非 2xx 先于解析抛 httpStatus（Slack/Lark 的业务错误走 200，不会落这里）。
    if (!res.ok) {
      throw new ChannelVerifyError("httpStatus", String(res.status));
    }
    const raw = await res.text();
    const identity = parse(raw);
    // 校验通过后加密 token；safeStorage 不可用（如无钥匙串）时密文置空，仅记连接态。
    const ciphertext = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(token).toString("base64")
      : "";
    return {
      ok: true,
      accountName: identity.accountName,
      accountDetail: identity.accountDetail,
      ciphertext,
    };
  } catch (err) {
    if (err instanceof ChannelVerifyError) {
      return { ok: false, errorKind: err.kind, errorDetail: err.detail };
    }
    // 超时/中止（AbortSignal.timeout 抛 TimeoutError，手动 abort 抛 AbortError）：
    // 归一化为可读文案，不透传底层 message（底层文案含义模糊，渲染端无法直呈用户）。
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { ok: false, errorKind: "httpStatus", errorDetail: "校验请求超时，请检查网络后重试" };
    }
    // 其它网络层异常(DNS/离线等)归为 httpStatus，携带原始信息便于诊断。
    return {
      ok: false,
      errorKind: "httpStatus",
      errorDetail: err instanceof Error ? err.message : "network-error",
    };
  }
}

// helper permissions one-shot 兜底源：main/index.ts 建好 ReplyHelperClient 后注入
// （node-mac-permissions 加载失败时 queryReplyPermissions 用它兜底）。未注入也可查——
// 只是少一级兜底，最终落全 notDetermined。
let helperPermissionsSource: HelperPermissionsFn | undefined;

/// 注入 helper permissions 命令作为权限查询兜底（initReply 建好 helper 后调用）。
export function setReplyHelperPermissionsSource(fn: HelperPermissionsFn): void {
  helperPermissionsSource = fn;
}

const log = createLogger("reply-ipc");

// 回复历史存储单例（events 按应用分目录）：ipc handler（读/清）与 index.ts 的写回 sink 共用。
export const replyHistoryStore = new ReplyHistoryStore({
  eventsDir: replyEventsDir,
  legacyJsonPath: replyHistoryPath,
  logger: log,
});

// 对话级记忆存储单例：controller 注入读取、learner 写摘要、ipc handler 清空，三方共用。
export const replyConversationStore = new ReplyConversationStore({
  storePath: replyConversationMemoryPath,
  logger: log,
});

// 全局分区记忆存储单例（KTD6 二次修订：markdown 分区文件）：main 唯一写者。
// 迁移链：memory.json（上一版）→ md;更早的 personal-workspace.json replyMemory 分片 → md。
export const replyMemoryStore = new ReplyMemoryStore({
  memoryDir: replyMemoryDir,
  legacyJsonPath: replyMemoryPath,
  loadLegacy: async () => (await getPersistedState()).replyMemory as MemoryState | undefined,
  logger: log,
});

// 「立即重新学习」实现由 index.ts 注入（需要模型解析 + chatComplete 闭包，与蒸馏管线同源）；
// 未注入（非 mac / 未初始化）时 handler 返回 unavailable。
let relearnHandler: (() => Promise<ReplyRelearnResult>) | null = null;

/// 注入重新学习编排（initReply 建好蒸馏依赖后调用）。
export function setReplyRelearnHandler(fn: () => Promise<ReplyRelearnResult>): void {
  relearnHandler = fn;
}

// renderer 的 store 是 reply 设置真源；main 侧缓存快照的同时把触发键变化交给 index.ts
// 接线到原生 helper。回调在 macOS initReply 完成前为空，快照仍会保留供初始化时补同步。
let settingsSyncHandler: ((snapshot: ReplySyncSnapshot) => void) | null = null;

export function setReplySettingsSyncHandler(fn: (snapshot: ReplySyncSnapshot) => void): void {
  settingsSyncHandler = fn;
}

// U5 stub：设置快照最近值只驻内存（进程退出即弃）。U7 draft-generator 会从此处读默认 agent。
let lastSyncedSnapshot: ReplySyncSnapshot | null = null;

/// 供 U7 controller 读取渲染端最近推送的设置快照（默认 agent / 记忆 / 触发键）。
export function getLastReplySnapshot(): ReplySyncSnapshot | null {
  return lastSyncedSnapshot;
}

/// 注册 reply IPC 域。U5 为骨架：全部返回安全默认，不触碰任何原生能力。
export function registerReplyHandlers(): void {
  // 权限查询：node-mac-permissions 优先，失败走注入的 helper permissions 兜底，再失败全未决。
  // ReplyPermissions 三态是 ReplyPermissionStatus（含 unknown）的子集，可直接作为 IPC 返回。
  ipcMain.handle(
    "reply:getPermissions",
    (): Promise<ReplyPermissionState> =>
      queryReplyPermissions(helperPermissionsSource, process.platform, undefined, log),
  );

  // 打开系统权限设置面板：直达对应隐私子页（授权引导）。
  ipcMain.handle("reply:openPermissionSettings", async (_e, kind: ReplyPermissionKind): Promise<void> => {
    // 日历要先向 helper 取一次五态授权档。node-mac-permissions 看不见 writeOnly（把它报成
    // notDetermined），不喂这个值的话「仅添加」授权下点「去授权」会完全没反应——既不弹窗
    // 也不开设置面板。详见 reply/permissions.ts 的 case "calendar"。
    // 取失败不阻断：退回原有行为（undefined 即不特判）。
    let calendarAccess: CalendarAccessState | undefined;
    if (kind === "calendar" && helperPermissionsSource) {
      calendarAccess = await helperPermissionsSource()
        .then((res) => normalizeCalendarAccess(res.calendarAccess))
        .catch(() => undefined);
    }
    try {
      return await openReplyPermissionSettings(kind, {
        requestAccess: (k) => requestReplyPermissionAccess(k, process.platform, undefined, log, calendarAccess),
        openExternal: (url) => shell.openExternal(url),
      });
    } finally {
      // 用户刚被引到授权弹窗/设置面板，授权档随时可能变 —— 失效缓存，
      // 免得下一次 pi:open 还拿着 15s 内的旧结论决定不注入日历工具。
      if (kind === "calendar") invalidateCalendarAccessCache();
    }
  });

  // 渠道凭据校验：core 纯函数构造请求/解析响应，main fetch + safeStorage 加密 token。
  ipcMain.handle(
    "reply:verifyChannel",
    (_e, channelId: ChannelId, token: string): Promise<ReplyChannelVerifyResult> =>
      verifyChannel(channelId, token),
  );

  // 断开渠道：密文由渲染端 store 持有（safeStorage 无持久态），main 侧无残留可清，空实现即可。
  ipcMain.handle("reply:disconnectChannel", (_e, _channelId: ChannelId): void => {
    // safeStorage 只做加解密、不持久化；密文清除在渲染端 store（disconnectChannel）完成。
  });

  // 调试记录：读 controller 的环形缓冲（最近 20 条，仅内存，进程退出即清）。
  ipcMain.handle("reply:getDebugLog", (): ReplyDebugEntry[] => getReplyDebugEntries());

  // 手动触发起草：转 controller.startDraftSession（兜底 accelerator / 设置页调试入口共用）。
  // controller 未初始化（非 mac / 尚未接线）时安全 no-op。
  ipcMain.handle("reply:triggerDraft", (): void => triggerReplyDraft());

  // 设置快照推送：U5 仅缓存最近值供 U7 读取；不做副作用。
  ipcMain.handle("reply:syncSettings", (_e, snapshot: ReplySyncSnapshot): void => {
    lastSyncedSnapshot = snapshot;
    settingsSyncHandler?.(snapshot);
  });

  // 数据摘要：设置页「数据」分区展示落盘数据规模。
  ipcMain.handle("reply:getDataSummary", async (): Promise<ReplyDataSummary> => ({
    historyCount: await replyHistoryStore.count(),
    conversationCount: await replyConversationStore.count(),
  }));

  // 清空回复历史（设置页数据清理）。
  ipcMain.handle("reply:clearHistory", (): Promise<void> => replyHistoryStore.clear());

  // 清空对话级记忆（设置页数据清理）。
  ipcMain.handle("reply:clearConversationMemory", (): Promise<void> => replyConversationStore.clear());

  // 在 Finder 显示数据文件夹（记忆/历史/对话记忆均为本机 JSON，供用户直接查看备份）。
  // 首次点击时目录可能还不存在（尚无任何落盘），先 mkdir 兜底再打开。
  ipcMain.handle("reply:openDataFolder", async (): Promise<void> => {
    await fsp.mkdir(replyDataDir(), { recursive: true });
    await shell.openPath(replyDataDir());
  });

  // 立即重新学习（源项目 relearn 恢复版）：依据已落盘回复历史重建语气要点。
  ipcMain.handle(
    "reply:relearn",
    (): Promise<ReplyRelearnResult> =>
      relearnHandler ? relearnHandler() : Promise.resolve({ ok: false, error: "unavailable" }),
  );

  // ── 全局分区记忆（KTD6 修订：main-owned memory.json，设置页经此读写）────────────────

  // 读全部分区（含首启迁移旧分片；恒返回字段完整的 MemoryState）。
  ipcMain.handle("reply:getMemory", (): Promise<MemoryState> => replyMemoryStore.getMemory());

  // 写单分区手写区/自动区（设置页 MemoryManager 编辑）。
  ipcMain.handle(
    "reply:setMemoryFile",
    (_e, scope: MemoryScope, patch: Partial<MemoryFile>): Promise<void> =>
      replyMemoryStore.setFile(scope, patch),
  );

  // 清空记忆：all=手写+自动；auto=仅自动学习要点（设置页数据清理）。
  ipcMain.handle("reply:clearMemory", (_e, kind: "all" | "auto"): Promise<void> =>
    kind === "auto" ? replyMemoryStore.clearAuto() : replyMemoryStore.clearAll(),
  );

  // 启动即触发首启迁移（时序关键）：渲染端改版后整表 store:save 不再携带 replyMemory，
  // 一旦其首次保存先于迁移执行，旧分片会随整表覆盖从磁盘消失。本注册函数在窗口创建前
  // 运行，而渲染端保存最早也要等 loadState+变更节流之后，故此处触发可稳定赢得该时序。
  // ensureMaterialized 内部先 getMemory（触发旧分片读入）再落盘物化（无旧分片也写空结构）；
  // 历史/对话记忆同样启动物化——三个文件启动即存在，数据目录对用户自解释
  // （不再出现「打开文件夹是空的」）。
  void replyMemoryStore.ensureMaterialized();
  void replyHistoryStore.ensureMaterialized();
  void replyConversationStore.ensureMaterialized();

  // ── 候选气泡窗通道（U6）──────────────────────────────────────────────────────────
  // 气泡渲染端 → 主进程（单向 send，非 invoke）：实测高度上报 + 鼠标动作上行。
  // 状态推送（主进程 → 气泡端）不在此注册——由 bubble-window.ts 直接 webContents.send。
  // 键盘动作不经此通道（窗口 focusable:false，键由 helper 吞键 → controller 驱动）。

  // 气泡实测内容高度上报 → 重定位并（必要时）显示。
  ipcMain.on("reply-bubble:resize", (_e, height: number) => resizeReplyBubble(height));

  // 气泡鼠标动作（翻牌/重试/关闭/选择/去设置）→ 分发到 U7 注入的处理器（未注入则安全忽略）。
  ipcMain.on("reply-bubble:action", (_e, action: ReplyBubbleAction) => dispatchReplyBubbleAction(action));

  // 气泡语音转写结果（U8）→ 分发到 controller 注入的处理器（口述意图起草 / 空失败提示）。
  ipcMain.on("reply-bubble:voice-result", (_e, result: ReplyBubbleVoiceResult) =>
    dispatchReplyBubbleVoiceResult(result),
  );
}

// Slides 助手会话的单一生命周期控制器：
// - 可见 ChatBlock 镜像与真实 Agent resume 指针共同落到文稿目录；
// - 文稿切换用 generation 隔离迟到加载；
// - 保存/重置/删除按 doc 串行，保证删除后不会被旧写入重新创建。
import type { DesktopBridge } from "../desktop/bridge";
import type { ChatBlock, NormalizedThread } from "./compat/agent-types";
import { useChatStore } from "./compat/chat-store";
import { documentDirPath } from "./design-document-persistence";

export const DESIGN_ASSISTANT_SESSION_VERSION = 1 as const;
export const DESIGN_ASSISTANT_SESSION_FILE = "assistant-session.json";

export type DesignAssistantSessionV1 = {
  version: typeof DESIGN_ASSISTANT_SESSION_VERSION;
  documentId: string;
  updatedAt: string;
  thread: NormalizedThread | null;
  blocks: ChatBlock[];
  liveAssistant: string;
  resumeKey?: string;
  resumeSessionId?: string;
};

type ActiveSession = {
  workspaceRoot: string;
  documentId: string;
  load: Promise<void>;
  // 慢加载被新文稿抢占时不等待、不回写；只有已完成加载的来源镜像才需要切换前 flush。
  loaded: boolean;
};

let installedBridge: DesktopBridge | null = null;
let activeSession: ActiveSession | null = null;
let loadGeneration = 0;
let mirrorUnsubscribe: (() => void) | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let suppressMirrorSave = false;
let cancelRunsForDocument: ((documentId: string) => Promise<void>) | null = null;
const resumeByConfig = new Map<string, string>();
const activeResumeKeyByDocument = new Map<string, string>();
const writeQueues = new Map<string, Promise<void>>();
const deletedSessionKeys = new Set<string>();

function absoluteSessionPath(workspaceRoot: string, documentId: string): string {
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  return `${root}/${documentDirPath(documentId)}/${DESIGN_ASSISTANT_SESSION_FILE}`;
}

function sessionStorageKey(workspaceRoot: string, documentId: string): string {
  return `${workspaceRoot}\u0000${documentId}`;
}

function cancelScheduledSave(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
}

function scheduleActiveSessionSave(): void {
  if (suppressMirrorSave || !activeSession) return;
  const scheduled = activeSession;
  cancelScheduledSave();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (activeSession !== scheduled) return;
    void flushDesignAssistantSession(scheduled.documentId);
  }, 200);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const CHAT_BLOCK_KINDS = new Set([
  "user",
  "assistant",
  "reasoning",
  "tool",
  "compaction",
  "review",
  "system",
  "approval",
  "user_input",
]);

function isChatBlock(value: unknown): value is ChatBlock {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    CHAT_BLOCK_KINDS.has(value.kind)
  );
}

function parseSession(raw: string, documentId: string): DesignAssistantSessionV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== DESIGN_ASSISTANT_SESSION_VERSION) return null;
  if (parsed.documentId !== documentId || !Array.isArray(parsed.blocks)) return null;
  const thread = isRecord(parsed.thread) && typeof parsed.thread.id === "string"
    ? (parsed.thread as NormalizedThread)
    : null;
  return {
    version: DESIGN_ASSISTANT_SESSION_VERSION,
    documentId,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    thread,
    blocks: parsed.blocks.filter(isChatBlock),
    liveAssistant: typeof parsed.liveAssistant === "string" ? parsed.liveAssistant : "",
    ...(typeof parsed.resumeKey === "string" ? { resumeKey: parsed.resumeKey } : {}),
    ...(typeof parsed.resumeSessionId === "string" ? { resumeSessionId: parsed.resumeSessionId } : {}),
  };
}

function recoveredBlocks(session: DesignAssistantSessionV1): ChatBlock[] {
  const blocks = session.blocks.map((block) => {
    if (block.kind === "tool" && block.status === "running") {
      return { ...block, status: "error" as const };
    }
    if (block.kind === "compaction" && block.status === "running") {
      return { ...block, status: "error" as const };
    }
    if (block.kind === "review" && block.status === "running") {
      return { ...block, status: "error" as const };
    }
    return block;
  });
  if (!session.liveAssistant.trim()) return blocks;
  return [
    ...blocks,
    {
      kind: "assistant",
      id: `a_recovered_${Date.now().toString(36)}`,
      text: session.liveAssistant,
    },
  ];
}

export function installDesignAssistantSessionPersistence(bridge: DesktopBridge): void {
  if (installedBridge === bridge) return;
  cancelScheduledSave();
  installedBridge = bridge;
  activeSession = null;
  loadGeneration += 1;
  resumeByConfig.clear();
  activeResumeKeyByDocument.clear();
  if (!mirrorUnsubscribe) {
    mirrorUnsubscribe = useChatStore.subscribe((state, previous) => {
      if (
        state.blocks !== previous.blocks ||
        state.liveAssistant !== previous.liveAssistant ||
        state.threads !== previous.threads ||
        state.activeThreadId !== previous.activeThreadId
      ) {
        scheduleActiveSessionSave();
      }
    });
  }
}

export function setDesignAssistantSessionRunCanceller(
  canceller: ((documentId: string) => Promise<void>) | null,
): void {
  cancelRunsForDocument = canceller;
}

function enqueueSessionWrite(
  workspaceRoot: string,
  documentId: string,
  operation: () => Promise<void>,
): Promise<void> {
  // 同一文稿的保存、清空与删除必须共用队列；跨文稿互不阻塞。
  const key = sessionStorageKey(workspaceRoot, documentId);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  writeQueues.set(key, next);
  const cleanup = (): void => {
    if (writeQueues.get(key) === next) writeQueues.delete(key);
  };
  void next.then(cleanup, cleanup);
  return next;
}

export async function ensureDesignAssistantSessionLoaded(
  workspaceRoot: string,
  documentId: string,
  persistent: boolean,
): Promise<void> {
  if (!installedBridge || !workspaceRoot || !documentId) return;
  if (!persistent) {
    const generation = ++loadGeneration;
    const previous = activeSession;
    if (previous) {
      cancelScheduledSave();
      await cancelRunsForDocument?.(previous.documentId);
      if (previous.loaded) await flushDesignAssistantSession(previous.documentId);
      if (generation === loadGeneration && activeSession === previous) {
        activeSession = null;
        suppressMirrorSave = true;
        useChatStore.getState().resetMirror();
        suppressMirrorSave = false;
      }
    }
    return;
  }
  deletedSessionKeys.delete(sessionStorageKey(workspaceRoot, documentId));
  if (
    activeSession?.workspaceRoot === workspaceRoot &&
    activeSession.documentId === documentId
  ) {
    await activeSession.load;
    return;
  }

  const generation = ++loadGeneration;
  const previous = activeSession;
  if (previous) {
    // 先让旧 run 停止产生事件；旧文件仍在时把当前镜像落定，再开始目标文稿的加载。
    cancelScheduledSave();
    await cancelRunsForDocument?.(previous.documentId);
    if (previous.loaded) await flushDesignAssistantSession(previous.documentId);
    if (generation !== loadGeneration) return;
    if (activeSession === previous) {
      activeSession = null;
      suppressMirrorSave = true;
      useChatStore.getState().resetMirror();
      suppressMirrorSave = false;
    }
  }
  const bridge = installedBridge;
  if (!bridge || generation !== loadGeneration) return;
  const nextSession: ActiveSession = {
    workspaceRoot,
    documentId,
    load: Promise.resolve(),
    loaded: false,
  };
  activeSession = nextSession;
  const load = (async () => {
    let session: DesignAssistantSessionV1 | null = null;
    try {
      const result = await bridge.readFile(absoluteSessionPath(workspaceRoot, documentId));
      if (!result.truncated) session = parseSession(result.content, documentId);
    } catch {
      // 首次使用或会话文件损坏时按空会话启动。
    }
    if (
      generation !== loadGeneration ||
      installedBridge !== bridge ||
      activeSession !== nextSession
    ) {
      return;
    }

    if (session?.resumeKey && session.resumeSessionId) {
      activeResumeKeyByDocument.set(documentId, session.resumeKey);
      resumeByConfig.set(session.resumeKey, session.resumeSessionId);
    }
    suppressMirrorSave = true;
    useChatStore.setState({
      threads: session?.thread ? [session.thread] : [],
      activeThreadId: session?.thread?.id ?? null,
      blocks: session ? recoveredBlocks(session) : [],
      liveAssistant: "",
      busy: false,
      currentTurnId: null,
      currentTurnUserId: null,
    });
    suppressMirrorSave = false;
    nextSession.loaded = true;
  })();
  nextSession.load = load;
  await load;
}

export function getDesignResumeSession(resumeKey: string): string | undefined {
  return resumeByConfig.get(resumeKey);
}

export function setDesignResumeSession(documentId: string, resumeKey: string, sessionId: string): void {
  activeResumeKeyByDocument.set(documentId, resumeKey);
  resumeByConfig.set(resumeKey, sessionId);
  scheduleActiveSessionSave();
}

export function isDesignResumeKeyActive(documentId: string, resumeKey: string): boolean {
  return activeResumeKeyByDocument.get(documentId) === resumeKey;
}

export function prepareDesignResumeSession(
  documentId: string,
  resumeKey: string,
): { resumeSessionId?: string; configurationChanged: boolean } {
  const previousResumeKey = activeResumeKeyByDocument.get(documentId);
  const configurationChanged = !!previousResumeKey && previousResumeKey !== resumeKey;
  if (previousResumeKey && previousResumeKey !== resumeKey) {
    resumeByConfig.delete(previousResumeKey);
  }
  activeResumeKeyByDocument.set(documentId, resumeKey);
  scheduleActiveSessionSave();
  const resumeSessionId = getDesignResumeSession(resumeKey);
  return {
    ...(resumeSessionId ? { resumeSessionId } : {}),
    configurationChanged,
  };
}

export function clearDesignAssistantResumeSessions(documentId?: string): void {
  if (!documentId) {
    resumeByConfig.clear();
    activeResumeKeyByDocument.clear();
    scheduleActiveSessionSave();
    return;
  }
  const keyPrefix = `${documentId}\u0000`;
  for (const key of resumeByConfig.keys()) {
    if (key.startsWith(keyPrefix)) resumeByConfig.delete(key);
  }
  activeResumeKeyByDocument.delete(documentId);
  scheduleActiveSessionSave();
}

export function clearLostDesignResumeSession(
  documentId: string,
  resumeKey: string,
  resumeSessionId: string,
): void {
  if (
    activeResumeKeyByDocument.get(documentId) === resumeKey &&
    resumeByConfig.get(resumeKey) === resumeSessionId
  ) {
    resumeByConfig.delete(resumeKey);
    scheduleActiveSessionSave();
  }
}

export async function flushDesignAssistantSession(documentId?: string): Promise<void> {
  const active = activeSession;
  const bridge = installedBridge;
  if (
    !active ||
    !bridge ||
    typeof bridge.writeFile !== "function" ||
    (documentId && active.documentId !== documentId)
  ) {
    return;
  }
  cancelScheduledSave();
  await active.load;
  if (activeSession !== active || installedBridge !== bridge) return;

  const mirror = useChatStore.getState();
  const resumeKey = activeResumeKeyByDocument.get(active.documentId);
  const resumeSessionId = resumeKey ? resumeByConfig.get(resumeKey) : undefined;
  const thread =
    mirror.threads.find((item) => item.id === mirror.activeThreadId) ??
    mirror.threads.find((item) => item.id === `design-${active.documentId}`) ??
    null;
  const payload: DesignAssistantSessionV1 = {
    version: DESIGN_ASSISTANT_SESSION_VERSION,
    documentId: active.documentId,
    updatedAt: new Date().toISOString(),
    thread,
    blocks: mirror.blocks,
    liveAssistant: mirror.liveAssistant,
    ...(resumeKey ? { resumeKey } : {}),
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
  await enqueueSessionWrite(active.workspaceRoot, active.documentId, async () => {
    if (
      installedBridge !== bridge ||
      deletedSessionKeys.has(sessionStorageKey(active.workspaceRoot, active.documentId))
    ) {
      return;
    }
    await bridge.writeFile(
      absoluteSessionPath(active.workspaceRoot, active.documentId),
      JSON.stringify(payload),
    );
  }).catch(() => undefined);
}

export async function deleteDesignAssistantSession(
  workspaceRoot: string,
  documentId: string,
): Promise<void> {
  if (!workspaceRoot || !documentId) return;
  const key = sessionStorageKey(workspaceRoot, documentId);
  // tombstone 在排队删除之前建立，使任何已安排但尚未执行的 flush 都安全 no-op。
  deletedSessionKeys.add(key);
  cancelScheduledSave();
  loadGeneration += 1;
  await cancelRunsForDocument?.(documentId);
  clearDesignAssistantResumeSessions(documentId);
  if (activeSession?.workspaceRoot === workspaceRoot && activeSession.documentId === documentId) {
    activeSession = null;
    suppressMirrorSave = true;
    useChatStore.getState().resetMirror();
    suppressMirrorSave = false;
  }
  const bridge = installedBridge;
  await enqueueSessionWrite(workspaceRoot, documentId, async () => {
    if (bridge && typeof bridge.deleteChat === "function") {
      await bridge.deleteChat(`design-${documentId}`);
    }
  }).catch(() => undefined);
}

export async function resetDesignAssistantSession(documentId: string): Promise<void> {
  const active = activeSession;
  const bridge = installedBridge;
  clearDesignAssistantResumeSessions(documentId);
  if (!active || active.documentId !== documentId || !bridge) return;

  loadGeneration += 1;
  cancelScheduledSave();
  suppressMirrorSave = true;
  useChatStore.getState().resetMirror();
  suppressMirrorSave = false;
  await enqueueSessionWrite(active.workspaceRoot, documentId, async () => {
    if (typeof bridge.deleteEntry === "function") {
      await bridge.deleteEntry(absoluteSessionPath(active.workspaceRoot, documentId));
    }
    if (typeof bridge.deleteChat === "function") {
      await bridge.deleteChat(`design-${documentId}`);
    }
  }).catch(() => undefined);
}

// 个人工作区持久化 wiring：mount 时从主进程加载 → hydrate store；
// 之后订阅持久化切片（projects/promptRoot/sessions）变更，节流回写主进程。
// 仅在 desktopBridge 存在（桌面端）时生效。

import { useEffect, useRef } from "react";
import { useDesktopBridge } from "../provider";
import { usePersonalStore, toPersistedState, type PersonalState } from "../store/personal";
import { useReplyStore, replyToPersisted, replySaveUrgency } from "../store/reply";
import { useMemoryStore } from "../store/memory";
import type { DesktopBridge } from "./bridge";
import type { PersistedState } from "./types";

const SAVE_THROTTLE_MS = 500;
const UUID_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBAGENT_TASK_UID = "subagent-task-";

export type SaveUrgency = "none" | "immediate" | "throttled";

// 保存紧迫度（纯函数,便于单测）：projects/promptRoot 是主进程 fs 路径白名单的
// 数据源,变更必须立即落盘——否则「添加项目 → 马上扫描目录」会被白名单误拒;
// 其余切片高频变更,维持节流。
export function saveUrgency(s: PersonalState, prev: PersonalState): SaveUrgency {
  if (!s.hydrated) return "none";
  // projects/promptRoot 是 fs 白名单数据源;generalSettings 被主进程消费
  //（workspaceRoot 兜底 cwd、桌面行为）—— 均须立即落盘,避免主进程读到旧值。
  if (
    s.projects !== prev.projects ||
    s.promptRoot !== prev.promptRoot ||
    s.generalSettings !== prev.generalSettings ||
    s.lastActiveProjectId !== prev.lastActiveProjectId // 浮层经主进程 cached 读它,必须立即落盘绕过 500ms 节流
  )
    return "immediate";
  if (
    s.sessions !== prev.sessions ||
    s.todos !== prev.todos ||
    s.pushSettings !== prev.pushSettings ||
    s.ttsSettings !== prev.ttsSettings ||
    s.mediaGenSettings !== prev.mediaGenSettings ||
    s.asrSettings !== prev.asrSettings ||
    s.voiceSettings !== prev.voiceSettings ||
    s.writingLlmSettings !== prev.writingLlmSettings ||
    s.providerSettings !== prev.providerSettings ||
    s.profile !== prev.profile ||
    s.rightPanelWidth !== prev.rightPanelWidth ||
    s.lastAgent !== prev.lastAgent ||
    s.lastModel !== prev.lastModel ||
    s.lastProviderId !== prev.lastProviderId
  )
    return "throttled";
  return "none";
}

function messagesOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as { messages?: unknown[] }).messages)) {
    return (raw as { messages: unknown[] }).messages;
  }
  return [];
}

/**
 * 从子会话自身的持久消息 UID 中提取委派 callId。
 *
 * 恢复工具曾把缺少父卡片 `childSessionId` 的 UUID 聊天重建为普通会话。`subagent-task-*`
 * 是 createSubagentSession 独占的内部 UID；以它为真值可覆盖执行中断、尚未产生 reply 的子会话，
 * 同时避免仅凭 UUID 误伤历史上的普通会话。
 */
function persistedSubagentCallId(raw: unknown): string | undefined {
  const taskIds = new Set<string>();
  for (const message of messagesOf(raw)) {
    if (!message || typeof message !== "object") continue;
    const uid = (message as { uid?: unknown }).uid;
    if (typeof uid !== "string") continue;
    if (uid.startsWith(SUBAGENT_TASK_UID)) taskIds.add(uid.slice(SUBAGENT_TASK_UID.length));
  }
  const matches = [...taskIds].filter((callId) => callId.length > 0);
  return matches.length === 1 ? matches[0] : undefined;
}

async function repairRecoveredSubagentSessions(
  bridge: Pick<DesktopBridge, "loadChat">,
  state: PersistedState,
): Promise<{ state: PersistedState; repaired: boolean }> {
  const suspects = state.sessions.filter(
    (session) => session.relation !== "side" && UUID_SESSION_ID.test(session.id),
  );
  if (suspects.length === 0) return { state, repaired: false };

  const detected = new Map<string, string>();
  await Promise.all(suspects.map(async (session) => {
    try {
      const callId = persistedSubagentCallId(await bridge.loadChat(session.id));
      if (callId) detected.set(session.id, callId);
    } catch {
      // 单个聊天损坏或暂时不可读时保持原元数据；不能让兼容迁移阻断整个工作区 hydrate。
    }
  }));
  if (detected.size === 0) return { state, repaired: false };

  const sessions = state.sessions.map((session) => {
    const callId = detected.get(session.id);
    if (!callId) return session;
    // 旧父卡片可能已在 HMR 事故中丢失。只有时间窗内唯一的普通会话才补作父级；若不唯一，
    // 仍将确证的子会话隐藏为 side，但不猜测导航目标。
    const parents = state.sessions.filter(
      (candidate) =>
        candidate.id !== session.id &&
        !detected.has(candidate.id) &&
        candidate.relation !== "side" &&
        candidate.createdAt <= session.createdAt &&
        candidate.updatedAt >= session.createdAt,
    );
    const parent = parents.length === 1 ? parents[0] : undefined;
    return {
      ...session,
      relation: "side" as const,
      ...(parent ? {
        parentSessionId: parent.id,
        projectId: parent.projectId,
        noProjectDir: parent.noProjectDir,
      } : {}),
      parentSubagentCallId: callId,
    };
  });
  return { state: { ...state, sessions }, repaired: true };
}

export function usePersonalPersistence(): void {
  const bridge = useDesktopBridge();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    // HMR/renderer 重载时，各 Zustand 模块可能以不同顺序恢复：reply 等分片已经 hydrated，
    // personal 权威态却仍是 projects/sessions 为空的初始值。两个 store 共用全量保存通道，
    // 因此不能只依赖各自的 hydrated 标记；必须等本次 effect 的 loadState 真正完成后才允许
    // 任意分片触发保存，否则一次无关设置变化就会把全部项目与会话覆盖为空。
    let personalSnapshotLoaded = false;

    // 合并序列化（KTD6 内定「倾向前者」）：个人分片 + reply 三分片同写一份 PersistedState，
    // 复用既有单条 store:save 通道，避免另建独立节流管线。
    const buildPersisted = (): PersistedState => ({
      ...toPersistedState(usePersonalStore.getState()),
      ...replyToPersisted(useReplyStore.getState()),
    });

    // 两个 store 的订阅共用同一节流计时器与保存例程；urgency 由各自的判定函数给出。
    const scheduleSave = (urgency: SaveUrgency): void => {
      if (!personalSnapshotLoaded || urgency === "none") return;
      if (timer.current) clearTimeout(timer.current);
      if (urgency === "immediate") {
        // 立即发起保存（含全部切片）,同源 IPC 按序处理,保证先于后续 fs 调用。
        timer.current = null;
        void bridge.saveState(buildPersisted());
        return;
      }
      timer.current = setTimeout(() => {
        void bridge.saveState(buildPersisted());
      }, SAVE_THROTTLE_MS);
    };

    bridge
      .loadState()
      .then(async (state) => {
        if (cancelled) return;
        const repaired = await repairRecoveredSubagentSessions(bridge, state);
        if (cancelled) return;
        usePersonalStore.getState().hydrate(repaired.state);
        // reply 持久化分片一并 hydrate（缺失/半缺分片由 store 内部补空默认）。
        useReplyStore.getState().hydrateReply(repaired.state);
        // 两个持久化分片都装填完成后再开放写入。hydrate 本身触发的订阅通知应被上面的
        // 门控忽略：加载权威快照不是用户变更，没有必要立即原样写回一次。
        personalSnapshotLoaded = true;
        if (repaired.repaired) {
          // 修复必须同步回权威索引，否则下一次冷启动仍会把这些子会话放回左栏。此时 personal
          // 与 reply 均已 hydrate，可以安全复用完整快照格式，不会重演空索引覆盖事故。
          // 回写失败不能落入外层 loadState 失败兜底（该兜底会 hydrate 空工作区）；内存态已修复，
          // 后续任一正常状态变化仍会通过订阅再次保存。
          try {
            await bridge.saveState(buildPersisted());
          } catch {
            // 保留已经 hydrate 的工作区，等待后续正常保存重试。
          }
        }
        // 分区记忆缓存装填（KTD6 修订）：真源在 main 侧 memory.json（含首启旧分片迁移），
        // 经 IPC 读入渲染端只读缓存；bridge 无此方法（Web/旧壳）则保持空缓存。
        void bridge
          .replyGetMemory?.()
          .then((memory) => {
            if (!cancelled) useReplyStore.getState().hydrateMemory(memory);
          })
          .catch(() => {});
        // 用户记忆缓存装填：真源在 main 侧 ~/.cortex-desktop/memory/*.md,读入只读缓存
        // 供 buildMemoryAppend 注入各工作台 prompt;bridge 无此方法（Web/旧壳）则保持空缓存。
        void bridge
          .memoryGet?.()
          .then((memory) => {
            if (!cancelled) useMemoryStore.getState().hydrateMemory(memory);
          })
          .catch(() => {});
        // 启动时重扫 Skills 库文件树（全部文件,不持久化树本身;与 PromptPanel 手动刷新同源）。
        if (repaired.state.promptRoot) {
          try {
            const tree = await bridge.scanDirTree(repaired.state.promptRoot);
            if (!cancelled) usePersonalStore.getState().setPromptTree(tree);
          } catch {
            // 目录可能已被删除/移动，保留 promptRoot 让 UI 提示重新选择。
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          usePersonalStore.getState().hydrate({ version: 1, projects: [], sessions: [] });
          useReplyStore.getState().hydrateReply({});
          // loadState 明确失败时允许用户从空态继续创建内容；此前仍禁止落盘，避免把一次
          // 暂时性的 IPC 失败误当成“用户清空全部数据”。
          personalSnapshotLoaded = true;
        }
      });

    const unsubPersonal = usePersonalStore.subscribe((s, prev) => scheduleSave(saveUrgency(s, prev)));
    const unsubReply = useReplyStore.subscribe((s, prev) => scheduleSave(replySaveUrgency(s, prev)));

    // U10 / KTD6 修订：main 蒸馏直写 memory-store 后推全量记忆 → 刷新渲染端只读缓存。
    // 缓存变更不触发保存（replySaveUrgency 不看 memory），持久化真源在 main。
    const unsubMemoryChanged =
      bridge.onReplyMemoryChanged?.((memory) => {
        useReplyStore.getState().hydrateMemory(memory);
      }) ?? (() => {});

    // 用户记忆变更推送：main 做梦写回后推全量记忆 → 刷新只读缓存（下一轮会话即注入新记忆）。
    // 缓存变更不触发持久化保存（真源在 main）。
    const unsubUserMemoryChanged =
      bridge.onMemoryChanged?.((memory) => {
        useMemoryStore.getState().hydrateMemory(memory);
      }) ?? (() => {});

    return () => {
      cancelled = true;
      unsubPersonal();
      unsubReply();
      unsubMemoryChanged();
      unsubUserMemoryChanged();
      if (personalSnapshotLoaded && timer.current) {
        clearTimeout(timer.current);
        // 卸载前冲刷一次，避免丢最后一笔变更。
        void bridge.saveState(buildPersisted());
      }
    };
  }, [bridge]);
}

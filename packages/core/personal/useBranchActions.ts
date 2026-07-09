// 分支回复动作层:刷新重新生成(regenerate)与分页器切换(switchBranch)。
// 纯数据变换在 branches.ts;这里编排副作用——底层会话指针快照/交换(pi 快照文件、
// claude/codex resume id)、React Query 缓存写入与落盘、经 usePersonalActions.send 重发。
//
// 核心不变量(与 branches.ts 文件头一致):主 messages[] 与 SessionMeta 的会话指针永远属于
// active 分支;归档分支各自持有 tail 快照 + 指针快照。regenerate/switchBranch 的职责就是
// 维持这一不变量下的原子交换。

import { useCallback } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Message } from "../types";
import type { SessionMeta, TrimSessionRequest } from "../desktop/types";
import type { DesktopBridge } from "../desktop/bridge";
import { useDesktopBridge } from "../provider";
import { usePersonalStore } from "../store/personal";
import {
  agentSessionPatch,
  clearAgentSessionPatch,
  clearProcess,
  clearRunEvents,
  ensureChatLoaded,
  flushChat,
  forkPiAtEditedMessage,
  personalBranchKeys,
  personalChatKeys,
  prewarmPiSession,
  sameTextOrdinal,
  sanitizeForSave,
  sessionResumeId,
  setBranchGroups,
  uid,
  usePersonalActions,
} from "./messages";
import { calibratePiSessionFile, closePiSession, isPiSessionOpen, switchPiToSessionFile } from "./pi-session";
import {
  applySwitch,
  mergeTail,
  splitAtAnchor,
  upsertRegenerate,
  type BranchGroup,
  type BranchSessionPointer,
  type BranchVariant,
} from "./branches";

export interface BranchActions {
  // 刷新:把当前回复归档为分支,按原问题(沿用引用文件/图片)重新生成一份新回复。
  regenerate: (session: SessionMeta, projectPath: string, anchorUid: string) => Promise<void>;
  // 分页器切换分支。返回 "ok" | "degraded"(目标分支会话记忆不完整,续聊上下文可能缺失) | null(未切换)。
  switchBranch: (
    session: SessionMeta,
    projectPath: string,
    anchorUid: string,
    targetVariantId: string,
  ) => Promise<"ok" | "degraded" | null>;
}

// 捕获「当前 live 分支」的底层会话指针快照。
// pi:优先经 pi:snapshotSession 复制不可变快照;快照失败时,仅当 live 文件此后不会再被写
// (liveFileInert:切换分支要切走 / 会话冷着)才允许直接引用 session.piSessionFile——
// regenerate 的 fork 会原地改写 live 文件,那时引用它会让旧分支被污染,只能标只读。
// claude/codex:resume id 本身就指向不可变的磁盘文件(新分支走 trim-into-copy 不动源文件)。
async function captureLivePointer(
  bridge: DesktopBridge,
  session: SessionMeta,
  branchId: string,
  liveFileInert: boolean,
): Promise<BranchSessionPointer> {
  if (session.agent === "pi") {
    const snap = bridge.piSnapshotSession
      ? await bridge.piSnapshotSession(session.id, branchId).catch(() => null)
      : null;
    if (snap?.path) return { piSessionFile: snap.path };
    if ((liveFileInert || !isPiSessionOpen(session.id)) && session.piSessionFile) {
      return { piSessionFile: session.piSessionFile };
    }
    return { readOnly: true };
  }
  const resumeId = sessionResumeId(session);
  return resumeId ? { agentSessionIds: { [session.agent]: resumeId } } : {};
}

// 读取会话的消息与分支组缓存(调用方已 ensureChatLoaded)。
function readCaches(qc: QueryClient, sessionId: string): { prev: Message[]; groups: BranchGroup[] } {
  return {
    prev: qc.getQueryData<Message[]>(personalChatKeys.detail(sessionId)) ?? [],
    groups: qc.getQueryData<BranchGroup[]>(personalBranchKeys.detail(sessionId)) ?? [],
  };
}

export function useBranchActions(): BranchActions {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  const { send } = usePersonalActions();

  const regenerate = useCallback<BranchActions["regenerate"]>(
    async (session, projectPath, anchorUid) => {
      if (!bridge) return;
      // 运行中不允许分支操作(与 editResend 同款守卫),避免与流式写入打架。
      if (usePersonalStore.getState().runningBySession[session.id]) return;
      await ensureChatLoaded(qc, bridge, session.id);
      const { prev, groups } = readCaches(qc, session.id);
      const split = splitAtAnchor(prev, anchorUid);
      const anchor = prev.find((m) => m.uid === anchorUid);
      if (!split || anchor?.kind !== "text" || typeof anchor.text !== "string") return;
      const text = anchor.text;
      const originalImages = anchor.images;
      const originalFiles = anchor.files;
      const occurrence = sameTextOrdinal(prev, anchorUid, text);

      // pi 冷会话先预热:快照与 fork 都要求会话就绪;预热失败静默,走下方 fork 失败的降级路径。
      if (session.agent === "pi" && !isPiSessionOpen(session.id)) {
        await prewarmPiSession(qc, bridge, session, projectPath);
      }

      // 1. 有已生成的回复才归档为分支(纯重发不建组);指针快照必须在 fork/trim 之前捕获。
      const archivedTail = sanitizeForSave(split.tail);
      const hasTail = archivedTail.length > 0;
      const group = groups.find((g) => g.anchorUid === anchorUid);
      let nextGroups = groups;
      let archived: BranchVariant | undefined;
      if (hasTail) {
        const archivedId = group?.activeId ?? uid("br");
        const pointer = await captureLivePointer(bridge, session, archivedId, /* liveFileInert */ false);
        archived = {
          id: archivedId,
          createdAt: group?.variants.find((v) => v.id === archivedId)?.createdAt ?? Date.now(),
          tail: archivedTail,
          pointer,
        };
        const newLive: BranchVariant = { id: uid("br"), createdAt: Date.now(), tail: null, pointer: null };
        nextGroups = upsertRegenerate(groups, anchorUid, archived, newLive);
      }

      // 2. 底层会话准备新 live 分支(语义对齐 editResend,但 claude/codex 优先非破坏的 trim-into-copy)。
      let sendSession = session;
      if (session.agent === "pi") {
        usePersonalStore.getState().clearPiUiForSession(session.id);
        const forked = await forkPiAtEditedMessage(bridge, session.id, prev, anchorUid).catch(() => false);
        if (forked) {
          // fork 可能换文件:校准 live sessionFile,防冷恢复/下一轮回写指向 fork 前的旧文件。
          const live = await calibratePiSessionFile(bridge, session.id);
          if (live && live !== session.piSessionFile) {
            usePersonalStore.getState().updateSession(session.id, { piSessionFile: live });
            sendSession = { ...session, piSessionFile: live };
          }
        } else {
          // fork 失败(冷/映射不中):关会话重开,新分支以全新上下文重答(旧分支快照不受影响)。
          await closePiSession(bridge, session.id);
          usePersonalStore.getState().setPiRuntime(session.id, undefined);
          usePersonalStore.getState().updateSession(session.id, { piSessionFile: undefined });
          sendSession = { ...session, piSessionFile: undefined };
        }
      } else {
        const truncated = sanitizeForSave(prev.slice(0, prev.findIndex((m) => m.uid === anchorUid)));
        const resumeId = sessionResumeId(session);
        if (truncated.length === 0) {
          // 刷新的是首条:新分支直接开全新会话,旧分支保留原 resume id,无需动任何文件。
          const patch = clearAgentSessionPatch(session, session.agent);
          usePersonalStore.getState().updateSession(session.id, patch);
          sendSession = { ...session, ...patch };
        } else if (resumeId) {
          const req: TrimSessionRequest = { agent: session.agent, agentSessionId: resumeId, promptText: text, occurrence };
          const copied = bridge.trimSessionIntoCopy ? await bridge.trimSessionIntoCopy(req).catch(() => null) : null;
          if (copied?.newSessionId) {
            const patch = agentSessionPatch(session, session.agent, copied.newSessionId);
            usePersonalStore.getState().updateSession(session.id, patch);
            sendSession = { ...session, ...patch };
          } else if (bridge.trimAgentSession) {
            // 降级:回落破坏式截断(旧行为)。旧分支的记忆文件被截,标只读——切回可看不可保真续聊。
            await bridge.trimAgentSession(req).catch(() => false);
            if (archived?.pointer) archived.pointer.readOnly = true;
          }
        }
      }

      // 3. UI 截断到 anchor 之前(anchor 本身由 send 重新 append)+ 清过程流,写回并落盘。
      const head = sanitizeForSave(prev.slice(0, prev.findIndex((m) => m.uid === anchorUid)));
      clearProcess(qc, session.id);
      clearRunEvents(qc, session.id);
      qc.setQueryData<Message[]>(personalChatKeys.detail(session.id), head);
      setBranchGroups(qc, session.id, nextGroups);
      flushChat(qc, session.id);

      // 4. 按原问题重发(引用文件/图片经 presaved 通道原样带回;附件 pill 无法从消息还原,沿用旧刷新行为传空)。
      await send(sendSession, projectPath, text, [], undefined, undefined, originalImages, undefined, undefined, originalFiles);

      // 5. send 重新 append 的用户消息 uid 是新的 → 分支组锚点迁移到新 uid(下次刷新/分页器据此定位)。
      if (hasTail) {
        const after = qc.getQueryData<Message[]>(personalChatKeys.detail(session.id)) ?? [];
        const newAnchor = [...after].reverse().find((m) => m.kind === "text" && m.who === "me");
        if (newAnchor?.uid && newAnchor.uid !== anchorUid) {
          const gs = qc.getQueryData<BranchGroup[]>(personalBranchKeys.detail(session.id)) ?? [];
          setBranchGroups(
            qc,
            session.id,
            gs.map((g) => (g.anchorUid === anchorUid ? { ...g, anchorUid: newAnchor.uid! } : g)),
          );
        }
      }
    },
    [bridge, qc, send],
  );

  const switchBranch = useCallback<BranchActions["switchBranch"]>(
    async (session, projectPath, anchorUid, targetVariantId) => {
      void projectPath; // 预留:冷恢复经下一轮 send 的 resumeFrom 完成,当前无需项目路径。
      if (!bridge) return null;
      if (usePersonalStore.getState().runningBySession[session.id]) return null;
      await ensureChatLoaded(qc, bridge, session.id);
      const { prev, groups } = readCaches(qc, session.id);
      const group = groups.find((g) => g.anchorUid === anchorUid);
      if (!group || group.activeId === targetVariantId) return null;
      const split = splitAtAnchor(prev, anchorUid);
      if (!split) return null;

      // 1. 物化当前 active 变体(tail + 指针快照)。切走后 live 文件不再被写 → liveFileInert。
      const pointer = await captureLivePointer(bridge, session, group.activeId, /* liveFileInert */ true);
      const materialized: BranchVariant = {
        id: group.activeId,
        createdAt: group.variants.find((v) => v.id === group.activeId)?.createdAt ?? Date.now(),
        tail: sanitizeForSave(split.tail),
        pointer,
      };
      const r = applySwitch(groups, anchorUid, materialized, targetVariantId);
      if (!r) return null;

      // 2. 恢复 target 的消息尾 + 清过程流(截断重写后过程流与新历史不再对应)。
      clearProcess(qc, session.id);
      clearRunEvents(qc, session.id);
      qc.setQueryData<Message[]>(personalChatKeys.detail(session.id), mergeTail(split.head, r.target.tail ?? []));
      setBranchGroups(qc, session.id, r.groups);

      // 3. 交换底层会话指针,使续聊上下文与目标分支一致。
      const store = usePersonalStore.getState();
      let degraded = !!r.target.pointer?.readOnly;
      if (session.agent === "pi") {
        const file = r.target.pointer?.piSessionFile;
        if (file) {
          if (isPiSessionOpen(session.id)) {
            try {
              // 温会话实时切换(内部同步句柄 sessionFile,防下一轮回写旧指针)。
              const live = await switchPiToSessionFile(bridge, session.id, file);
              store.updateSession(session.id, { piSessionFile: live });
            } catch {
              // 实时切换失败 → 关会话,指针照写;下一轮 send 冷启经 resumeFrom 恢复。
              await closePiSession(bridge, session.id);
              store.setPiRuntime(session.id, undefined);
              store.updateSession(session.id, { piSessionFile: file });
            }
          } else {
            // 冷会话只改指针,下一轮 send 经 ensurePiSession({resumeFrom}) 恢复。
            store.updateSession(session.id, { piSessionFile: file });
          }
        } else {
          // 目标分支无 pi 指针(快照失败过):续聊将以全新上下文开始。
          degraded = true;
          await closePiSession(bridge, session.id);
          store.setPiRuntime(session.id, undefined);
          store.updateSession(session.id, { piSessionFile: undefined });
        }
      } else {
        const resumeId = r.target.pointer?.agentSessionIds?.[session.agent];
        // 无 resume id 也是合法态(该分支从首条开的全新会话):清指针,下一轮开新会话。
        store.updateSession(
          session.id,
          resumeId ? agentSessionPatch(session, session.agent, resumeId) : clearAgentSessionPatch(session, session.agent),
        );
      }
      flushChat(qc, session.id);
      return degraded ? "degraded" : "ok";
    },
    [bridge, qc],
  );

  return { regenerate, switchBranch };
}

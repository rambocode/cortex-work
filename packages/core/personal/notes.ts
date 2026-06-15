// 闪记（Flash Notes）数据层 —— 服务主窗口收件箱/时间线。main 是 owner,这是
// 「服务端数据」,走 React Query 而非 zustand（KTD9）。query key 以 projectId 命名
//（桌面端无 wsId 概念,useWorkspaceId 返回占位值,绝不用 wsId,否则同桌面所有项目
// 笔记串到同一 key）。notes:changed 事件只触发 invalidateQueries,不直接 setState、
// 不写 Zustand（遵 CLAUDE.md「事件只触发 invalidation」）;窗口重获焦点 refetch 兜底
// 事件丢失。
//
// 浮层（独立 BrowserWindow 裸 React root,无 CoreProvider/QueryClient,KTD10）严禁用
// 本文件的 hook —— 浮层直连 window.desktopAPI.personal.notesAdd / loadState,只复用
// 本文件导出的纯函数 resolveDefaultNoteProject。

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DesktopBridge } from "../desktop/bridge";
import type { NoteInput, NoteMeta, NoteStatus } from "../desktop/types";
import { useDesktopBridge } from "../provider";

// 无项目（未归类）的稳定占位段——绝不用 wsId。
const NO_PROJECT = "no-project";

// query key（与 timelineKeys 形态对齐,均以 projectId 命名空间）。
export const notesKeys = {
  all: ["personal", "notes"] as const,
  byProject: (projectId: string) => ["personal", "notes", projectId] as const,
};

// 更新入参：复用 NoteInput 的可改字段 + 深化推进所需的状态/链接数组（完整数组替换）。
export type NotePatch = Partial<NoteInput> & {
  status?: NoteStatus;
  conversationIds?: string[];
  docPaths?: string[];
};

// ── 纯函数（供浮层与测试复用,无 React 依赖）──────────────────────────────

// 闪记能力是否可用（无 bridge / web 端 / 旧壳缺方法 → UI 隐藏入口）。
export function notesAvailable(bridge: DesktopBridge | null): boolean {
  return !!bridge?.notesList;
}

// 默认归属推导：当前会话.projectId ?? activeProjectId ?? lastActiveProjectId；
// 都没有 → undefined（未归类）。取「第一个有值」的来源后校验该 projectId 仍在
// projects 中,失效则回落 undefined（不继续往下找,避免归到无关项目）。
export function resolveDefaultNoteProject(args: {
  currentSessionProjectId?: string;
  activeProjectId?: string;
  lastActiveProjectId?: string;
  projects: { id: string }[];
}): string | undefined {
  const candidate =
    args.currentSessionProjectId ?? args.activeProjectId ?? args.lastActiveProjectId;
  if (!candidate) return undefined;
  return args.projects.some((p) => p.id === candidate) ? candidate : undefined;
}

// ── 查询（主窗口）─────────────────────────────────────────────────────────

// 单项目闪记列表（收件箱按项目分组 / 时间线合成用）。
export function useProjectNotes(projectId: string | undefined) {
  const bridge = useDesktopBridge();
  return useQuery<NoteMeta[]>({
    queryKey: notesKeys.byProject(projectId ?? NO_PROJECT),
    enabled: !!bridge?.notesList, // 缺桥/旧壳 → 关闭,UI 降级隐藏入口
    queryFn: () => bridge!.notesList!(projectId),
    staleTime: Infinity,
    refetchOnWindowFocus: true, // 兜底事件丢失（窗口重获焦点 refetch）
  });
}

// 全量闪记（收件箱按项目分组用）。
export function useAllNotes() {
  const bridge = useDesktopBridge();
  return useQuery<NoteMeta[]>({
    queryKey: notesKeys.all,
    enabled: !!bridge?.notesList,
    queryFn: () => bridge!.notesList!(),
    staleTime: Infinity,
    refetchOnWindowFocus: true,
  });
}

// 闪记能力是否可用（hook 形态,供 UI 降级隐藏入口）。
export function useNotesAvailable(): boolean {
  return notesAvailable(useDesktopBridge());
}

// ── 变更（成功后 invalidate notesKeys,让 RQ 重拉 main 的权威值）────────────

export function useAddNote() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<NoteMeta, Error, NoteInput>({
    mutationFn: (input) => bridge!.notesAdd!(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notesKeys.all });
    },
  });
}

export function useUpdateNote() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<NoteMeta | null, Error, { id: string; patch: NotePatch }>({
    mutationFn: (vars) => bridge!.notesUpdate!(vars.id, vars.patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notesKeys.all });
    },
  });
}

export function useDeleteNote() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => bridge!.notesDelete!(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notesKeys.all });
    },
  });
}

// ── 事件订阅（工作区根部挂载一次）──────────────────────────────────────────
// notes:changed 推全量快照,但这里只 invalidate,不 setQueryData(list)、不写 Zustand,
// 让 React Query 重新 notesList 拉权威值。onNotesChanged 返回 removeListener,卸载即清。
export function useNotesChangeSubscription(): void {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  useEffect(() => {
    if (!bridge?.onNotesChanged) return;
    return bridge.onNotesChanged(() => {
      qc.invalidateQueries({ queryKey: notesKeys.all });
    });
  }, [bridge, qc]);
}

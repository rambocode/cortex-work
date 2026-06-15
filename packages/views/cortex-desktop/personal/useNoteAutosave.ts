// 闪记去抖自动保存 hook。停止输入 ~500ms 后自动写回 + 保留手动 save();切到别的闪记 /
// 卸载时 flush 挂起的保存(不丢尾字,R10)。
//
// 防回灌(R11 / 计划 KTD5,doc-review 关键修正):draft 仅在 noteId 切换时复位,
// **绝不**因 content 变化(notes:changed → React Query refetch 回灌)而复位 ——
// 否则会用旧/异内容覆盖正在编辑的草稿。这与现有 NotesView.tsx:194-198 的
// `[note.id, note.content]` 复位 effect 相反:那段在 always-editing + 自动保存下会丢字,
// 故此处不照搬(参见 doc-review 反馈)。

import { useCallback, useEffect, useRef, useState } from "react";

export type NoteSaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export function useNoteAutosave({
  noteId,
  content,
  onSave,
  onError,
  debounceMs = 500,
}: {
  noteId: string;
  content: string;
  onSave: (content: string) => Promise<void>;
  onError?: (err: unknown) => void;
  debounceMs?: number;
}): {
  draft: string;
  setDraft: (next: string) => void;
  save: () => Promise<void>;
  status: NoteSaveStatus;
} {
  const [draft, setDraftState] = useState(content);
  const [status, setStatus] = useState<NoteSaveStatus>("idle");

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedRef = useRef(content); // 当前 note 已落盘内容(去抖去重基线)
  const draftRef = useRef(content);
  const onSaveRef = useRef(onSave);
  const onErrorRef = useRef(onError);
  onSaveRef.current = onSave;
  onErrorRef.current = onError;
  // 捕获「离开当前 note 时应 flush 的保存」:绑定当前 noteId 的 onSave + 待存内容。
  // 用捕获(而非读 onSaveRef.current)避免切 note 后用新 note 的 onSave 存旧内容。
  const pendingRef = useRef<{ content: string; save: (c: string) => Promise<void> } | null>(null);

  const clearTimer = (): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const runSave = useCallback(async (next: string, saveFn: (c: string) => Promise<void>) => {
    pendingRef.current = null;
    if (next === savedRef.current) {
      setStatus("idle");
      return;
    }
    setStatus("saving");
    try {
      await saveFn(next);
      savedRef.current = next;
      // 若保存期间又有新输入,保持 dirty;否则置 saved。
      setStatus(draftRef.current === next ? "saved" : "dirty");
    } catch (err) {
      setStatus("error");
      onErrorRef.current?.(err);
    }
  }, []);

  const setDraft = useCallback(
    (next: string) => {
      setDraftState(next);
      draftRef.current = next;
      setStatus(next === savedRef.current ? "idle" : "dirty");
      clearTimer();
      const saveFn = onSaveRef.current;
      pendingRef.current = { content: next, save: saveFn };
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void runSave(next, saveFn);
      }, debounceMs);
    },
    [debounceMs, runSave],
  );

  // 手动保存(Cmd+S / 按钮):立即 flush 挂起内容。
  const save = useCallback(async () => {
    clearTimer();
    const pending = pendingRef.current ?? { content: draftRef.current, save: onSaveRef.current };
    await runSave(pending.content, pending.save);
  }, [runSave]);

  // 离开当前 note(切走 / 卸载):flush 挂起的保存,用捕获的旧 onSave,fire-and-forget。
  useEffect(() => {
    return () => {
      clearTimer();
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) void pending.save(pending.content);
    };
  }, [noteId]);

  // 切 note:强制复位基线到新内容。
  useEffect(() => {
    setDraftState(content);
    draftRef.current = content;
    savedRef.current = content;
    setStatus("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  // 同一 noteId 下 content 外部变化(异步加载完成 / notes:changed refetch):
  // 仅当 draft 仍是「干净」的(等于基线,无未保存编辑)才采纳新内容;一旦用户编辑过
  // (draft 偏离基线)就保留编辑中草稿,不被回灌覆盖(防回灌,R11)。
  useEffect(() => {
    if (draftRef.current === savedRef.current && content !== savedRef.current) {
      setDraftState(content);
      draftRef.current = content;
      savedRef.current = content;
      setStatus("idle");
    }
  }, [content]);

  return { draft, setDraft, save, status };
}

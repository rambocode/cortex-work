// 任务附件录入控件（U13）。列出 task.attachments（名字 + 大小 + 移除）+「添加附件」按钮。
// 复用聊天文档附件采集（docIntake：扩展名/大小预检、File→srcPath 优先），经 bridge.taskDocSave 落盘、
// bridge.taskDocDelete 删除。落盘/删除后 main 广播 tasks:changed → RQ 失效 → task prop 自动带上新
// attachments（本组件不本地改状态，遵循「事件只触发 invalidation」约定）。
//
// 取舍：本期附件**仅限文档类型**（pdf/docx/xlsx/pptx/csv/txt/md，由 DOC_ACCEPT_ATTR + checkDocFile
// 与主进程 extToDocExt allowlist 三处同口径把关），图片附件延后——故不在此扩 accept/校验。
// 降级：web/旧壳无 bridge.taskDocSave 时隐藏「添加/移除」，仅只读列出既有附件。
import { useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge } from "@cortex-work/core";
import type { TaskMeta } from "@cortex-work/core/desktop/types";
import { DOC_ACCEPT_ATTR, checkDocFile, docRejectText, fileToPendingDocFile } from "./docIntake";

// 字节数 → 人读大小（与 SttLocalWhisperPanel.formatBytes 同手感）。
function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

export function TaskAttachments({ task, onToast }: { task: TaskMeta; onToast?: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const attachments = task.attachments ?? [];
  // 编辑能力需 save + delete 两个桥方法都在（缺一即降级为只读）。
  const canEdit = !!bridge?.taskDocSave && !!bridge?.taskDocDelete;
  const toast = (m: string) => onToast?.(m);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // 清空以允许重复选同一文件
    if (!bridge?.taskDocSave || files.length === 0) return;
    setBusy(true);
    try {
      for (const f of files) {
        const reason = checkDocFile(f); // 不支持类型/超限 → 友好提示（主进程仍是权威闸门）
        if (reason) {
          toast(docRejectText(reason, f.name));
          continue;
        }
        try {
          const p = await fileToPendingDocFile(f); // 优先 srcPath，避免大 ArrayBuffer 过 IPC
          await bridge.taskDocSave(task.id, {
            name: p.name,
            mimeType: p.mimeType,
            srcPath: p.srcPath,
            data: p.data,
          });
        } catch (err) {
          toast(`附件添加失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (path: string) => {
    if (!bridge?.taskDocDelete) return;
    try {
      await bridge.taskDocDelete(task.id, path);
    } catch (err) {
      toast(`附件移除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <span className="pw-task-attachments">
      {attachments.length === 0 && <span className="pw-task-meta-ro">（无附件）</span>}
      {attachments.map((a) => (
        <span key={a.path} className="pw-task-badge is-attachment">
          <Icon.File size={12} />
          <span className="pw-task-attach-name" title={a.name}>
            {a.name}
          </span>
          <span className="pw-task-attach-size">{formatBytes(a.sizeBytes)}</span>
          {canEdit && (
            <button className="pw-task-tag-x" title="移除附件" onClick={() => void onRemove(a.path)}>
              ×
            </button>
          )}
        </span>
      ))}
      {canEdit && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept={DOC_ACCEPT_ATTR}
            multiple
            hidden
            onChange={(e) => void onPick(e)}
          />
          <button className="pw-task-meta-btn" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? "上传中…" : "＋添加附件"}
          </button>
        </>
      )}
    </span>
  );
}

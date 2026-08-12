// 写作左栏重命名弹窗：双击文件/目录名唤起（替代原先的行内输入 + 常显编辑图标）。
// 走 createPortal 挂到 body：左栏是可滚动容器，弹窗留在树里会被裁切/跟着滚。
// 输入框里只有去后缀名（左栏隐藏 md 系后缀），保留的后缀在输入框右侧以只读后缀片展示，
// 让用户明确「改的是名字，后缀不会丢」；提交由上层 applyWritingRenameName 补回。
import { useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function WritingRenameDialog({
  initialName,
  keptExt,
  isDir,
  error,
  onCommit,
  onCancel,
}: {
  // 预填的展示名（已去 md 系后缀）。
  initialName: string;
  // 提交时会补回的后缀（含点）；无隐藏后缀（目录 / pdf 等）时为空串，不渲染后缀片。
  keptExt: string;
  isDir: boolean;
  // 上层提交失败的原因（重名/非法等）：弹窗保持打开并就地展示，避免用户改完又被弹回重来。
  error: string | null;
  onCommit: (name: string) => void;
  onCancel: () => void;
}): ReactElement {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 打开即聚焦并全选：绝大多数重命名是整体改写，省一次手动选中。
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = (): void => {
    const trimmed = value.trim();
    if (!trimmed) return; // 空名直接吞掉，不劳烦上层报错
    onCommit(trimmed);
  };

  return createPortal(
    <div
      className="pw-writing-rename-mask"
      role="dialog"
      aria-modal="true"
      aria-label={isDir ? "重命名目录" : "重命名文件"}
      onMouseDown={(e) => {
        // 只在点到遮罩本身时关闭（点弹窗内部不关）。
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="pw-writing-rename-card">
        <div className="pw-writing-rename-head">
          <span className="pw-writing-rename-title">{isDir ? "重命名目录" : "重命名文件"}</span>
          <button type="button" aria-label="关闭" onClick={onCancel}>
            <X size={14} strokeWidth={1.9} />
          </button>
        </div>
        <div className="pw-writing-rename-body">
          <div className="pw-writing-rename-field">
            <input
              ref={inputRef}
              aria-label="重命名"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") onCancel();
              }}
            />
            {keptExt ? <span className="pw-writing-rename-ext">{keptExt}</span> : null}
          </div>
          {error ? <div className="pw-writing-rename-error">{error}</div> : null}
        </div>
        <div className="pw-writing-rename-foot">
          <button type="button" className="pw-writing-rename-btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="pw-writing-rename-btn is-primary"
            disabled={!value.trim()}
            onClick={commit}
          >
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

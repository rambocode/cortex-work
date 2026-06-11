// Prompt md 文件预览/编辑器（右栏）。原生 textarea，保存写回磁盘。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge } from "@cortex-work/core";

export function PromptEditor({
  path,
  name,
  onBack,
  onToast,
}: {
  path: string;
  name: string;
  onBack: () => void;
  onToast: (text: string) => void;
}) {
  const bridge = useDesktopBridge();
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setDirty(false);
    setError(null);
    bridge
      ?.readFile(path)
      .then((res) => {
        if (cancelled) return;
        setContent(res.content);
        setTruncated(res.truncated);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, path]);

  const save = async () => {
    if (!bridge || content === null || truncated) return;
    try {
      await bridge.writeFile(path, content);
      setDirty(false);
      onToast(`已保存 ${name}`);
    } catch (err) {
      onToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="pw-editor">
      <div className="pw-editor-h">
        <button className="pw-icon-btn" title="返回列表" onClick={onBack}>
          <Icon.Back size={14} />
        </button>
        <span className="pw-editor-name">
          {name}
          {dirty ? <span className="pw-dirty">●</span> : null}
        </span>
        <div className="spacer" />
        {truncated ? <span className="pw-readonly">文件过大 · 只读</span> : null}
        <button className="btn primary" onClick={save} disabled={!dirty || truncated || content === null}>
          <Icon.Check size={13} />
          保存
        </button>
      </div>
      {error ? (
        <div className="pw-editor-error">{error}</div>
      ) : content === null ? (
        <div className="pw-editor-loading">加载中…</div>
      ) : (
        <textarea
          className="pw-editor-ta"
          value={content}
          readOnly={truncated}
          onChange={(e) => {
            setContent(e.target.value);
            setDirty(true);
          }}
          spellCheck={false}
        />
      )}
    </div>
  );
}

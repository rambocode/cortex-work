// 服务器目录浏览器（目录模式创建工作区的「选择目录」弹层）：经后端 browse API 中继到
// daemon 列目录，单层下钻（.. 返回上级），底部「选用此目录」确认。imperative 调用
// browseServerDir（core 纯函数，兜平同步/异步服务端实现），组件内只持浏览 UI 态。

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { browseServerDir, useCoreContext } from "@cortex-work/core";
import type { ServerDirEntry } from "@cortex-work/core/api/types";

export function ServerDirectoryBrowser({
  runtimeId,
  initialPath,
  onPick,
  onClose,
}: {
  runtimeId: string;
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { apiClient } = useCoreContext();
  const [path, setPath] = useState<string | undefined>(initialPath || undefined);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<ServerDirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  // 竞态防护：快速连点目录时只采纳最后一次请求的结果。
  const seq = useRef(0);

  const load = useCallback(
    (target?: string) => {
      if (!apiClient) return;
      const mySeq = ++seq.current;
      setLoading(true);
      setError(null);
      void browseServerDir(apiClient, runtimeId, target)
        .then((res) => {
          if (seq.current !== mySeq) return;
          if (res.status === "ok") {
            setPath(res.path);
            setParent(res.parent ?? null);
            setEntries((res.entries ?? []).filter((e) => e.is_dir));
          } else {
            setError(res.error || t("serverWs.browseFailed"));
          }
        })
        .catch(() => {
          if (seq.current === mySeq) setError(t("serverWs.browseFailed"));
        })
        .finally(() => {
          if (seq.current === mySeq) setLoading(false);
        });
    },
    [apiClient, runtimeId, t],
  );

  useEffect(() => load(initialPath || undefined), [load, initialPath]);

  // 点击外部关闭（与 ServerWorkspacePicker 同款：捕获阶段判定）。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  return (
    <div className="serverws-dirbrowser" ref={ref} role="dialog" aria-label={t("serverWs.browseTitle")}>
      <div className="serverws-dirbrowser-head">
        <span className="serverws-dirbrowser-path" title={path}>
          {path || "~"}
        </span>
        <button className="icon-btn" title={t("serverWs.browseClose")} onClick={onClose}>
          <Icon.X size={12} />
        </button>
      </div>
      <div className="serverws-dirbrowser-list">
        {loading ? (
          <div className="serverws-empty-hint">{t("loading")}</div>
        ) : error ? (
          <div className="serverws-empty-hint serverws-status-error">{error}</div>
        ) : (
          <>
            {parent ? (
              <button className="serverws-dirbrowser-row" onClick={() => load(parent)}>
                <Icon.Folder size={13} />
                <span>..</span>
              </button>
            ) : null}
            {entries.length === 0 && !parent ? <div className="serverws-empty-hint">{t("serverWs.browseEmpty")}</div> : null}
            {entries.map((e) => (
              <button key={e.path} className="serverws-dirbrowser-row" onClick={() => load(e.path)}>
                <Icon.Folder size={13} />
                <span>{e.name}</span>
                {e.has_git ? <em className="serverws-mode-badge">git</em> : null}
              </button>
            ))}
          </>
        )}
      </div>
      <div className="serverws-dirbrowser-foot">
        <button
          className="mc-primary-btn"
          disabled={!path || loading}
          onClick={() => {
            if (path) onPick(path);
            onClose();
          }}
        >
          {t("serverWs.browsePick")}
        </button>
      </div>
    </div>
  );
}

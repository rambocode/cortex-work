// 写作日志设置卡(对齐 Kun 写作建议日志):设置 → 写作 底部「写作日志」卡,点「查看最近调用」弹窗显示。
// 数据来自主进程内存环形缓冲(bridge.writingDebugLog),排查续写/改写是否响应、耗时、错误。
// 无桌面能力(web/旧壳无 writingDebugLog)时整卡不渲染。
import { useCallback, useState } from "react";
import { useDesktopBridge } from "@cortex-work/core/provider";
import type { WritingDebugLogEntry } from "@cortex-work/core/desktop/types";
import { useTranslation } from "@cortex-work/core/i18n";
import { Icon } from "@cortex-work/ui/icons";

import { SettingCard } from "./settingsControls";

// 时间戳 → HH:MM:SS(本地),日志展示够用。
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function WritingDebugLogSection() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<WritingDebugLogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!bridge?.writingDebugLog) return;
    setLoading(true);
    try {
      setEntries(await bridge.writingDebugLog());
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  const clear = useCallback(async (): Promise<void> => {
    if (!bridge?.writingDebugLogClear) return;
    await bridge.writingDebugLogClear();
    setEntries([]);
  }, [bridge]);

  // 打开弹窗即拉取一次。
  const openDialog = (): void => {
    setOpen(true);
    void load();
  };

  // 无能力(web/旧壳)→ 不渲染整卡。
  if (!bridge?.writingDebugLog) return null;

  return (
    <SettingCard title={t("writing.debugLogCard")}>
      <div className="pw-srow">
        <div className="pw-srow-l">
          <span className="pw-srow-desc">{t("writing.debugLogDesc")}</span>
        </div>
        <button type="button" className="pw-ftb-btn" onClick={openDialog}>
          {t("writing.debugLogView")}
        </button>
      </div>

      {open ? (
        // 复用居中模态外壳(pw-dlg-overlay/pw-dlg):点遮罩/Esc/关闭按钮关闭。
        <div className="pw-dlg-overlay" onClick={() => setOpen(false)}>
          <div
            className="pw-dlg pw-wdl-dlg"
            role="dialog"
            aria-modal="true"
            aria-label={t("writing.debugLogCard")}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              }
            }}
          >
            <div className="pw-wdl-head">
              <span className="pw-wdl-dlg-title">{t("writing.debugLogCard")}</span>
              <div className="pw-wdl-head-actions">
                <button type="button" className="pw-ftb-btn" onClick={() => void load()} disabled={loading}>
                  {t("writing.debugLogRefresh")}
                </button>
                {entries.length > 0 ? (
                  <button type="button" className="pw-ftb-btn" onClick={() => void clear()}>
                    {t("writing.debugLogClear")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="pw-icon-btn"
                  title={t("writing.debugLogClose")}
                  aria-label={t("writing.debugLogClose")}
                  onClick={() => setOpen(false)}
                >
                  <Icon.X size={15} />
                </button>
              </div>
            </div>

            <div className="pw-wdl-body">
              {entries.length === 0 ? (
                <div className="pw-srow-desc">{t("writing.debugLogEmpty")}</div>
              ) : (
                <ul className="pw-wdl-list">
                  {entries.map((e) => (
                    <li key={e.id} className="pw-wdl-item" data-ok={e.ok ? "1" : "0"}>
                      <span className="pw-wdl-kind">
                        {e.kind === "edit" ? t("writing.debugLogKindEdit") : t("writing.debugLogKindComplete")}
                      </span>
                      <span className="pw-wdl-time">{fmtTime(e.ts)}</span>
                      <span className="pw-wdl-model" title={e.model}>
                        {e.model}
                      </span>
                      <span className="pw-wdl-status">
                        {e.ok ? `${t("writing.debugLogOk")} · ${e.chars}字` : t("writing.debugLogFail")}
                      </span>
                      <span className="pw-wdl-ms">{e.ms}ms</span>
                      {!e.ok && e.error ? (
                        <span className="pw-wdl-err" title={e.error}>
                          {e.error}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </SettingCard>
  );
}

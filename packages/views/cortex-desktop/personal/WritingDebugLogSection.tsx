// 写作日志设置卡(对齐 Kun 写作建议日志):查看最近的续写/改写 LLM 调用记录(元信息)。
// 数据来自主进程内存环形缓冲(bridge.writingDebugLog),用于排查:模型是否响应、耗时、错误。
// 无桌面能力(web/旧壳无 writingDebugLog)时整卡不渲染。
import { useCallback, useState } from "react";
import { useDesktopBridge } from "@cortex-work/core/provider";
import type { WritingDebugLogEntry } from "@cortex-work/core/desktop/types";
import { useTranslation } from "@cortex-work/core/i18n";

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
  const [entries, setEntries] = useState<WritingDebugLogEntry[] | null>(null);
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

  // 无能力(web/旧壳)→ 不渲染整卡。
  if (!bridge?.writingDebugLog) return null;

  return (
    <SettingCard title={t("writing.debugLogCard")}>
      <div className="pw-srow-desc">{t("writing.debugLogDesc")}</div>
      <div className="pw-wdl-actions">
        <button type="button" className="pw-ftb-btn" onClick={() => void load()} disabled={loading}>
          {entries === null ? t("writing.debugLogView") : t("writing.debugLogRefresh")}
        </button>
        {entries && entries.length > 0 ? (
          <button type="button" className="pw-ftb-btn" onClick={() => void clear()}>
            {t("writing.debugLogClear")}
          </button>
        ) : null}
      </div>

      {entries !== null ? (
        entries.length === 0 ? (
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
                  {e.ok ? `${t("writing.debugLogOk")} · ${e.chars}字` : `${t("writing.debugLogFail")}`}
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
        )
      ) : null}
    </SettingCard>
  );
}

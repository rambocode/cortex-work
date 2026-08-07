// SenseVoiceSmall 本地模型面板：下载源、状态、进度、下载/取消/删除。
// 进度只保存在组件和 bridge hook 中，不写 Zustand，避免高频字节进度触发全局持久化。

import { useCallback, useEffect, useState } from "react";
import { useDesktopBridge } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  LOCAL_ASR_DOWNLOAD_SOURCES,
  LOCAL_ASR_MODELS,
  type LocalAsrDownloadSourceId,
  type LocalAsrModelId,
  type LocalAsrModelStatus,
  type LocalAsrSourceStatus,
} from "@cortex-work/core/asr/local-models";
import { useModelDownloadState } from "@cortex-work/core/desktop/useModelDownloadState";
import { BareSelect, SettingCard, SRow } from "./settingsControls";

function formatBytes(bytes?: number): string {
  if (!bytes) return "";
  const mb = bytes / 1024 / 1024;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

interface Props {
  selectedModelId: string;
  sourceId: LocalAsrDownloadSourceId;
  onSourceChange: (sourceId: LocalAsrDownloadSourceId) => void;
  onModelSelect: (modelId: LocalAsrModelId) => void;
}

export function SttLocalSenseVoicePanel({
  selectedModelId,
  sourceId,
  onSourceChange,
  onModelSelect,
}: Props) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const model = LOCAL_ASR_MODELS[0];
  const downloadState = useModelDownloadState(model.id);
  const [status, setStatus] = useState<LocalAsrModelStatus | null>(null);
  const [sources, setSources] = useState<LocalAsrSourceStatus[] | null>(null);
  const [busy, setBusy] = useState<"idle" | "download" | "cancel" | "delete" | "check">("idle");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!bridge?.getLocalAsrModelStatus) return;
    setStatus(await bridge.getLocalAsrModelStatus(model.id));
  }, [bridge, model.id]);

  const checkSources = useCallback(async (): Promise<void> => {
    if (!bridge?.checkLocalAsrSources) return;
    setBusy("check");
    try {
      setSources((await bridge.checkLocalAsrSources(model.id)).sources);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("idle");
    }
  }, [bridge, model.id]);

  useEffect(() => {
    void refresh().catch(() => undefined);
    void checkSources();
  }, [checkSources, refresh]);

  useEffect(() => {
    if (downloadState.status === "done") void refresh().catch(() => undefined);
  }, [downloadState.status, refresh]);

  const runtimeState = downloadState.status === "downloading" ? "downloading" : (status?.state ?? "missing");
  const progress = downloadState.status === "downloading" ? downloadState.progress : null;
  const selectedSource = sources?.find((source) => source.sourceId === sourceId);

  const run = async (action: "download" | "cancel" | "delete"): Promise<void> => {
    setBusy(action);
    setError(null);
    try {
      if (action === "download") {
        if (selectedSource?.state === "unavailable") throw new Error(t("stt.sourceUnavailableHint"));
        const result = await bridge?.downloadLocalAsrModel?.({ modelId: model.id, sourceId });
        if (result?.status) setStatus(result.status);
        if (result && !result.ok) throw new Error(result.message || t("stt.modelStateError"));
      } else if (action === "cancel") {
        const result = await bridge?.cancelLocalAsrDownload?.(model.id);
        if (result?.status) setStatus(result.status);
      } else {
        const result = await bridge?.deleteLocalAsrModel?.(model.id);
        if (result?.status) setStatus(result.status);
        if (result && !result.ok) throw new Error(result.message || t("stt.modelStateError"));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("idle");
    }
  };

  const percent = progress?.percent ?? (
    progress?.totalBytes ? Math.round(progress.downloadedBytes / progress.totalBytes * 100) : 0
  );

  return (
    <SettingCard title={t("stt.modelsCard")}>
      <SRow label={t("stt.downloadSourceLabel")} desc={t("stt.downloadSourceDesc")} end>
        <BareSelect
          value={sourceId}
          options={LOCAL_ASR_DOWNLOAD_SOURCES.map((source) => ({ label: source.label, value: source.id }))}
          onChange={(value) => onSourceChange(value as LocalAsrDownloadSourceId)}
        />
      </SRow>
      <div
        role="button"
        tabIndex={0}
        className={`pw-stt-model-card${selectedModelId === model.id ? " pw-stt-model-card-selected" : ""}`}
        onClick={() => onModelSelect(model.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onModelSelect(model.id);
          }
        }}
      >
        <span className="pw-stt-model-card-header">
          <span className="pw-stt-model-label">{model.label}</span>
          <span className={`pw-stt-badge pw-stt-badge-${runtimeState}`}>
            {t(`stt.modelState${runtimeState[0]?.toUpperCase()}${runtimeState.slice(1)}`)}
          </span>
          <span className="pw-stt-badge pw-stt-badge-recommended">{t("stt.recommended")}</span>
        </span>
        <span className="pw-stt-model-meta">
          <span>{t("stt.modelSize", { size: formatBytes(model.sizeBytes) })}</span>
          <span>{t("stt.modelMemory", { memory: model.resourceEstimate.memory })}</span>
          <span>{t("stt.modelThreads", { threads: model.resourceEstimate.cpuThreads })}</span>
        </span>
        {runtimeState === "downloading" ? (
          <span className="pw-stt-progress-row" onClick={(event) => event.stopPropagation()}>
            <span className="pw-stt-progress-bar">
              <span className="pw-stt-progress-fill" style={{ width: `${percent}%` }} />
            </span>
            <span className="pw-stt-progress-label">
              {Math.round(percent)}% · {formatBytes(progress?.downloadedBytes)}
            </span>
          </span>
        ) : null}
        <span className="pw-stt-model-actions" onClick={(event) => event.stopPropagation()}>
          {error ? <span className="pw-stt-error-msg">{error}</span> : null}
          {runtimeState === "missing" || runtimeState === "error" ? (
            <button type="button" className="pw-btn pw-stt-action-btn" disabled={busy !== "idle"} onClick={() => void run("download")}>
              {busy === "download" ? t("stt.downloading") : t("stt.download")}
            </button>
          ) : null}
          {runtimeState === "downloading" ? (
            <button type="button" className="pw-btn pw-stt-action-btn" disabled={busy !== "idle"} onClick={() => void run("cancel")}>
              {t("stt.cancel")}
            </button>
          ) : null}
          {runtimeState === "ready" ? (
            <button type="button" className="pw-btn-sm pw-stt-action-btn-delete" disabled={busy !== "idle"} onClick={() => void run("delete")}>
              {t("stt.delete")}
            </button>
          ) : null}
          {sources?.every((source) => source.state === "unavailable") ? (
            <button type="button" className="pw-btn-sm" disabled={busy !== "idle"} onClick={() => void checkSources()}>
              {t("stt.retry")}
            </button>
          ) : null}
        </span>
      </div>
    </SettingCard>
  );
}

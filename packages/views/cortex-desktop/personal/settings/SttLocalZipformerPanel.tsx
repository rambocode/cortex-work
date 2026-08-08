// 流式 Zipformer 本地模型面板：下载源、状态、进度、下载/取消/删除。
//
// 与 SttLocalSenseVoicePanel 结构一致（同一套 pw-stt-* 样式与交互），差别只有走的 bridge 通道：
// 这里用 stt:streaming:* 一族。刻意不与 SenseVoice 面板合并成一个泛型组件——两者的模型清单
// 类型、id 取值域都不同，合并后需要大量类型擦除，反而比这份重复更难读。
//
// 进度只保存在组件和 bridge hook 中，不写 Zustand，避免高频字节进度触发全局持久化。

import { useCallback, useEffect, useState } from "react";
import { useDesktopBridge } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  STREAMING_ASR_DOWNLOAD_SOURCES,
  STREAMING_ASR_MODELS,
  streamingAsrModelTotalBytes,
  type StreamingAsrDownloadSourceId,
  type StreamingAsrModelId,
  type StreamingAsrModelStatus,
  type StreamingAsrSourceStatus,
} from "@cortex-work/core/asr/streaming-models";
import { useModelDownloadState } from "@cortex-work/core/desktop/useModelDownloadState";
import { BareSelect, SettingCard, SRow } from "./settingsControls";

function formatBytes(bytes?: number): string {
  if (!bytes) return "";
  const mb = bytes / 1024 / 1024;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

interface Props {
  selectedModelId: string;
  sourceId: StreamingAsrDownloadSourceId;
  onSourceChange: (sourceId: StreamingAsrDownloadSourceId) => void;
  onModelSelect: (modelId: StreamingAsrModelId) => void;
}

export function SttLocalZipformerPanel({
  selectedModelId,
  sourceId,
  onSourceChange,
  onModelSelect,
}: Props) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const model = STREAMING_ASR_MODELS[0];
  const downloadState = useModelDownloadState(model.id, "streaming");
  const [status, setStatus] = useState<StreamingAsrModelStatus | null>(null);
  const [sources, setSources] = useState<StreamingAsrSourceStatus[] | null>(null);
  const [busy, setBusy] = useState<"idle" | "download" | "cancel" | "delete" | "check">("idle");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!bridge?.getStreamingAsrModelStatus) return;
    setStatus(await bridge.getStreamingAsrModelStatus(model.id));
  }, [bridge, model.id]);

  const checkSources = useCallback(async (): Promise<void> => {
    if (!bridge?.checkStreamingAsrSources) return;
    setBusy("check");
    try {
      setSources((await bridge.checkStreamingAsrSources(model.id)).sources);
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
        const result = await bridge?.downloadStreamingAsrModel?.({ modelId: model.id, sourceId });
        if (result?.status) setStatus(result.status);
        if (result && !result.ok) throw new Error(result.message || t("stt.modelStateError"));
      } else if (action === "cancel") {
        const result = await bridge?.cancelStreamingAsrDownload?.(model.id);
        if (result?.status) setStatus(result.status);
      } else {
        const result = await bridge?.deleteStreamingAsrModel?.(model.id);
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
  // 总大小取自清单而非进度事件：missing 态下还没有进度事件，卡片也要能如实展示体积。
  const totalBytes = streamingAsrModelTotalBytes(model.id);

  return (
    <SettingCard title={t("stt.modelsCard")}>
      <SRow label={t("stt.downloadSourceLabel")} desc={t("stt.downloadSourceDesc")} end>
        <BareSelect
          value={sourceId}
          options={STREAMING_ASR_DOWNLOAD_SOURCES.map((source) => ({ label: source.label, value: source.id }))}
          onChange={(value) => onSourceChange(value as StreamingAsrDownloadSourceId)}
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
          <span className="pw-stt-badge pw-stt-badge-recommended">{t("stt.realtimeBadge")}</span>
        </span>
        <span className="pw-stt-model-meta">
          <span>{t("stt.modelSize", { size: formatBytes(totalBytes) })}</span>
          <span>{t("stt.modelMemory", { memory: model.resourceEstimate.memory })}</span>
          <span>{t("stt.modelThreads", { threads: model.resourceEstimate.cpuThreads })}</span>
        </span>
        {/*
          下载的是四个文件、总计约 199MB，其中 encoder 独占 91%。只显示总百分比会让人觉得
          「卡住了」，所以额外标出当前正在下的文件名，让长时间停在同一个百分比区间有解释。
        */}
        {runtimeState === "downloading" ? (
          <span className="pw-stt-progress-row" onClick={(event) => event.stopPropagation()}>
            <span className="pw-stt-progress-bar">
              <span className="pw-stt-progress-fill" style={{ width: `${percent}%` }} />
            </span>
            <span className="pw-stt-progress-label">
              {Math.round(percent)}% · {formatBytes(progress?.downloadedBytes)} / {formatBytes(totalBytes)}
              {progress?.fileName ? ` · ${progress.fileName}` : ""}
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

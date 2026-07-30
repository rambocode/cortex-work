// 本地 Whisper 面板：下载源健康检查 + 模型卡片列表（下载/取消/删除/进度）。
// 从 SttSettingsSection 拆出，防止主文件超过 1200 行上限（U6 KTD5）。
// 进度走 bridge 回调，不进 Zustand；状态用 useModelDownloadState hook 订阅。

import { useCallback, useEffect, useRef, useState } from "react";
import { useDesktopBridge } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  WHISPER_DOWNLOAD_SOURCES,
  WHISPER_MODELS,
  type LocalWhisperModelId,
  type LocalWhisperModelStatus,
  type LocalWhisperSourceStatus,
  type WhisperDownloadSourceId,
} from "@cortex-work/core/whisper/models";
import { useModelDownloadState } from "@cortex-work/core/desktop/useModelDownloadState";
import { BareSelect, SettingCard, SRow } from "./settingsControls";

// ── 格式化工具 ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "";
  const mb = bytes / 1024 / 1024;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function formatTransferBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.max(1, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`;
  }
  const mb = bytes / 1024 / 1024;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function formatTransferRate(bytesPerSecond: number | undefined, pendingLabel: string): string {
  const formatted = formatTransferBytes(bytesPerSecond);
  return formatted ? `${formatted}/s` : pendingLabel;
}

// ── 单个模型卡片（含进度订阅） ────────────────────────────────────────────────

interface ModelCardProps {
  model: (typeof WHISPER_MODELS)[number];
  status: LocalWhisperModelStatus | undefined;
  selected: boolean;
  sourceId: WhisperDownloadSourceId;
  sourceAvailable: boolean | null; // null 表示检测中/未检测
  onSelect: () => void;
  onStatusUpdate: (status: LocalWhisperModelStatus) => void;
}

function ModelCard({
  model,
  status,
  selected,
  sourceId,
  sourceAvailable,
  onSelect,
  onStatusUpdate,
}: ModelCardProps) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();

  // 订阅当前模型的下载进度（本地 state，不进 Zustand，符合 KTD5）
  const downloadState = useModelDownloadState(model.id);

  const [busy, setBusy] = useState<"idle" | "download" | "cancel" | "delete">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 用 ref 保存 onStatusUpdate，避免每次渲染创建新函数引用导致 useEffect 无限循环。
  const onStatusUpdateRef = useRef(onStatusUpdate);
  useEffect(() => { onStatusUpdateRef.current = onStatusUpdate; });

  // 从 downloadState 同步进度到父级 status map。
  // 注意：依赖只写 downloadState + model.id + bridge，不写 onStatusUpdate（通过 ref 访问）。
  useEffect(() => {
    if (downloadState.status === "downloading") {
      onStatusUpdateRef.current({
        modelId: model.id as LocalWhisperModelId,
        label: model.label,
        fileName: model.fileName,
        sha256: model.sha256,
        sizeBytes: model.sizeBytes,
        maxBytes: model.maxBytes,
        resourceEstimate: model.resourceEstimate,
        qualityTier: model.qualityTier,
        recommended: model.recommended,
        state: "downloading",
        downloadedBytes: downloadState.progress.downloadedBytes,
        totalBytes: downloadState.progress.totalBytes,
        speedBytesPerSecond: downloadState.progress.speedBytesPerSecond,
      });
    } else if (downloadState.status === "done") {
      // 完成时触发一次状态补拉，以获取正确的 path/sizeBytes 等字段
      void bridge?.getWhisperModelStatus?.(model.id).then((s) => {
        onStatusUpdateRef.current(s);
      }).catch(() => undefined);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadState, model.id, bridge]);

  // 当前模型的运行态。
  // 优先：下载进度 push 到达 → 立即为 downloading（不等父级 status prop 更新）；
  // 其次：父级 status prop；兜底：missing。
  // 此设计避免 push 到达到 effect→setState→父级重渲染 之间出现 UI 空窗。
  const modelState: LocalWhisperModelStatus["state"] =
    downloadState.status === "downloading"
      ? "downloading"
      : downloadState.status === "done"
        ? "ready"
        : (status?.state ?? "missing");

  // 下载进度（来自 downloadState 或 status 字段）
  const downloadedBytes =
    downloadState.status === "downloading"
      ? downloadState.progress.downloadedBytes
      : status?.downloadedBytes;
  const totalBytes =
    downloadState.status === "downloading"
      ? downloadState.progress.totalBytes
      : status?.totalBytes;
  const speedBps =
    downloadState.status === "downloading"
      ? downloadState.progress.speedBytesPerSecond
      : status?.speedBytesPerSecond;

  const progressPercent =
    totalBytes && totalBytes > 0
      ? Math.round(((downloadedBytes ?? 0) / totalBytes) * 100)
      : 0;

  // 状态徽标样式
  const stateBadgeClass =
    modelState === "ready"
      ? "pw-stt-badge pw-stt-badge-ready"
      : modelState === "downloading"
        ? "pw-stt-badge pw-stt-badge-downloading"
        : modelState === "error"
          ? "pw-stt-badge pw-stt-badge-error"
          : "pw-stt-badge pw-stt-badge-missing";

  const stateBadgeLabel =
    modelState === "ready"
      ? t("stt.modelStateReady")
      : modelState === "downloading"
        ? t("stt.modelStateDownloading")
        : modelState === "error"
          ? t("stt.modelStateError")
          : t("stt.modelStateMissing");

  // 下载按钮：对不可达源给出错误提示
  const handleDownload = async (): Promise<void> => {
    if (!bridge?.downloadWhisperModel) return;
    // 源不可达时给出提示（sourceAvailable === false 表示已检测不可达）
    if (sourceAvailable === false) {
      setErrorMsg(t("stt.sourceUnavailableHint"));
      return;
    }
    setErrorMsg(null);
    setBusy("download");
    try {
      const result = await bridge.downloadWhisperModel({ modelId: model.id, sourceId });
      if (result.status) onStatusUpdate(result.status);
      if (!result.ok) {
        setErrorMsg(t("stt.downloadFailed", { message: result.message ?? "" }));
      }
    } finally {
      setBusy("idle");
    }
  };

  const handleCancel = async (): Promise<void> => {
    if (!bridge?.cancelWhisperDownload) return;
    setErrorMsg(null);
    setBusy("cancel");
    try {
      const result = await bridge.cancelWhisperDownload(model.id);
      if (result.status) onStatusUpdate(result.status);
    } finally {
      setBusy("idle");
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!bridge?.deleteWhisperModel) return;
    setErrorMsg(null);
    setBusy("delete");
    try {
      const result = await bridge.deleteWhisperModel(model.id);
      if (result.status) onStatusUpdate(result.status);
    } finally {
      setBusy("idle");
    }
  };

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`pw-stt-model-card${selected ? " pw-stt-model-card-selected" : ""}`}
    >
      {/* 顶行：标题 + 徽标 */}
      <span className="pw-stt-model-card-header">
        <span className="pw-stt-model-label">{model.label}</span>
        <span className={stateBadgeClass}>{stateBadgeLabel}</span>
        {model.recommended ? (
          <span className="pw-stt-badge pw-stt-badge-recommended">{t("stt.recommended")}</span>
        ) : null}
      </span>

      {/* 元数据行 */}
      <span className="pw-stt-model-meta">
        <span>{t("stt.modelSize", { size: formatBytes(model.sizeBytes) })}</span>
        <span>{t("stt.modelMemory", { memory: model.resourceEstimate.memory })}</span>
        <span>{t("stt.modelThreads", { threads: model.resourceEstimate.cpuThreads })}</span>
        <span>{t("stt.modelQuality", { quality: t(`stt.quality_${model.qualityTier}`) })}</span>
      </span>

      {/* 下载进度条（downloading 或 error 态展示） */}
      {(modelState === "downloading" || (modelState === "error" && status?.error)) ? (
        <span className="pw-stt-progress-row" onClick={(e) => e.stopPropagation()}>
          {modelState === "downloading" ? (
            <>
              <span className="pw-stt-progress-bar">
                <span className="pw-stt-progress-fill" style={{ width: `${progressPercent}%` }} />
              </span>
              <span className="pw-stt-progress-label">
                {progressPercent}% · {formatBytes(downloadedBytes)} ·{" "}
                {formatTransferRate(speedBps, t("stt.speedPending"))}
              </span>
            </>
          ) : (
            <span className="pw-stt-error-msg">
              {t("stt.downloadFailed", { message: status?.error ?? "" })}
            </span>
          )}
        </span>
      ) : null}

      {/* 操作按钮区（阻止卡片 onClick 冒泡） */}
      <span className="pw-stt-model-actions" onClick={(e) => e.stopPropagation()}>
        {/* 错误态的客户端错误提示（非 status.error） */}
        {errorMsg ? <span className="pw-stt-error-msg">{errorMsg}</span> : null}

        {modelState === "missing" || modelState === "error" ? (
          // 缺失/错误态：下载 / 重试
          <button
            type="button"
            className="pw-btn pw-stt-action-btn"
            disabled={busy !== "idle"}
            onClick={() => void handleDownload()}
          >
            {busy === "download" ? t("stt.downloading") : modelState === "error" ? t("stt.retry") : t("stt.download")}
          </button>
        ) : null}

        {modelState === "downloading" ? (
          // 下载中：取消
          <button
            type="button"
            className="pw-btn pw-stt-action-btn"
            disabled={busy !== "idle"}
            onClick={() => void handleCancel()}
          >
            {busy === "cancel" ? t("stt.cancelling") : t("stt.cancel")}
          </button>
        ) : null}

        {modelState === "ready" ? (
          // 就绪：删除
          <button
            type="button"
            className="pw-btn-sm pw-stt-action-btn-delete"
            disabled={busy !== "idle"}
            onClick={() => void handleDelete()}
          >
            {busy === "delete" ? t("stt.deleting") : t("stt.delete")}
          </button>
        ) : null}
      </span>
    </button>
  );
}

// ── 主面板组件 ────────────────────────────────────────────────────────────────

interface SttLocalWhisperPanelProps {
  /** 当前选中的模型 id */
  selectedModelId: string;
  /** 当前选中的下载源 id */
  sourceId: WhisperDownloadSourceId;
  /** 选择下载源时触发 */
  onSourceChange: (sourceId: WhisperDownloadSourceId) => void;
  /** 选择模型时触发 */
  onModelSelect: (modelId: LocalWhisperModelId) => void;
}

export function SttLocalWhisperPanel({
  selectedModelId,
  sourceId,
  onSourceChange,
  onModelSelect,
}: SttLocalWhisperPanelProps) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();

  // 各模型状态 map（本地态，不进 Zustand，符合 KTD5）
  const [modelStatuses, setModelStatuses] = useState<
    Partial<Record<LocalWhisperModelId, LocalWhisperModelStatus>>
  >({});

  // 下载源健康检查结果
  const [sourceStatuses, setSourceStatuses] = useState<LocalWhisperSourceStatus[] | null>(null);
  const [sourceCheckBusy, setSourceCheckBusy] = useState(false);

  // 选中源是否可达（用于下载前的校验）
  const selectedSourceStatus = sourceStatuses?.find((s) => s.sourceId === sourceId);
  const selectedSourceAvailable =
    selectedSourceStatus == null ? null : selectedSourceStatus.state === "available";

  // 是否所有源都不可达（全不可用才显示重试按钮）
  const allSourcesUnavailable =
    sourceStatuses != null &&
    sourceStatuses.length > 0 &&
    sourceStatuses.every((s) => s.state === "unavailable");

  // 更新单个模型状态。用 useCallback 稳定引用，避免子卡片 useEffect 因函数引用变化重复触发。
  const handleStatusUpdate = useCallback((status: LocalWhisperModelStatus): void => {
    setModelStatuses((prev) => ({ ...prev, [status.modelId]: status }));
  }, []);

  // 挂载时：拉取所有模型状态 + 健康检查
  useEffect(() => {
    // 初始化拉取所有模型状态
    if (bridge?.listWhisperModels) {
      void bridge.listWhisperModels().then((list) => {
        setModelStatuses((prev) => {
          const next = { ...prev };
          for (const s of list) next[s.modelId] = s;
          return next;
        });
      }).catch(() => undefined);
    }

    // 健康检查
    void runSourceCheck();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runSourceCheck = async (): Promise<void> => {
    if (!bridge?.checkWhisperSources) return;
    setSourceStatuses(null);
    setSourceCheckBusy(true);
    try {
      const result = await bridge.checkWhisperSources();
      setSourceStatuses(result.sources);
    } catch {
      setSourceStatuses([]);
    } finally {
      setSourceCheckBusy(false);
    }
  };

  // 下载源选项
  const sourceOptions = WHISPER_DOWNLOAD_SOURCES.map((s) => ({
    label: s.label,
    value: s.id,
  }));

  return (
    <>
      {/* 下载源配置 */}
      <SettingCard title={t("stt.downloadSourceCard")}>
        <SRow label={t("stt.downloadSourceLabel")} desc={t("stt.downloadSourceDesc")} end>
          <BareSelect
            value={sourceId}
            options={sourceOptions}
            onChange={(v) => onSourceChange(v as WhisperDownloadSourceId)}
          />
        </SRow>

        {/* 健康检查结果 */}
        <div className="pw-stt-source-check">
          {sourceCheckBusy && !sourceStatuses ? (
            <span className="pw-srow-desc">{t("stt.sourceChecking")}</span>
          ) : null}

          {sourceStatuses != null ? (
            <div className="pw-stt-source-list">
              {sourceStatuses.map((s) => {
                const available = s.state === "available";
                const isSelected = s.sourceId === sourceId;
                return (
                  <span
                    key={s.sourceId}
                    className={`pw-stt-source-item${isSelected ? " pw-stt-source-item-active" : ""}${available ? " pw-stt-source-ok" : " pw-stt-source-fail"}`}
                  >
                    <span className={`pw-stt-source-dot${available ? " pw-stt-source-dot-ok" : " pw-stt-source-dot-fail"}`} />
                    <span>
                      {available
                        ? t("stt.sourceAvailable", {
                            source: s.label,
                            ms: s.responseTimeMs ?? 0,
                          })
                        : t("stt.sourceUnavailable", {
                            source: s.label,
                            message: s.message ?? (s.httpStatus ? `HTTP ${s.httpStatus}` : t("stt.sourceUnknownError")),
                          })}
                    </span>
                  </span>
                );
              })}
            </div>
          ) : null}

          {/* 全不可用时显示重试按钮 */}
          {allSourcesUnavailable ? (
            <button
              type="button"
              className="pw-btn pw-stt-retry-btn"
              disabled={sourceCheckBusy}
              onClick={() => void runSourceCheck()}
            >
              {t("stt.retrySourceCheck")}
            </button>
          ) : null}
        </div>
      </SettingCard>

      {/* 模型卡片列表 */}
      <SettingCard title={t("stt.modelsCard")}>
        <div className="pw-srow-desc">{t("stt.modelsDesc")}</div>
        <div className="pw-stt-model-list">
          {WHISPER_MODELS.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              status={modelStatuses[model.id as LocalWhisperModelId]}
              selected={model.id === selectedModelId}
              sourceId={sourceId}
              sourceAvailable={selectedSourceAvailable}
              onSelect={() => onModelSelect(model.id as LocalWhisperModelId)}
              onStatusUpdate={handleStatusUpdate}
            />
          ))}
        </div>
      </SettingCard>
    </>
  );
}

// ApprovalNodeForm.tsx — human-approval / generate-image 节点配置表单。
// human-approval：title / instruction / timeoutMs / onTimeout。
// generate-image：prompt / providerId / model / size / outputDir。

import { usePersonalStore } from "@cortex-work/core";
import type { WorkflowNode } from "@cortex-work/core";
import type {
  WorkflowHumanApprovalConfig,
  WorkflowGenerateImageConfig,
  WorkflowApprovalDecision,
} from "@cortex-work/core";
import { INPUT_CLS, FIELD_LABEL_CLS } from "./TriggerNodeForm";

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** 常见图片尺寸预设（可手动输入其他值）。 */
const IMAGE_SIZE_PRESETS = [
  "256x256",
  "512x512",
  "1024x1024",
  "1024x1792",
  "1792x1024",
];

const TIMEOUT_OPTIONS = [
  { label: "无限制", value: 0 },
  { label: "1 分钟", value: 60000 },
  { label: "5 分钟", value: 300000 },
  { label: "30 分钟", value: 1800000 },
  { label: "1 小时", value: 3600000 },
  { label: "24 小时", value: 86400000 },
];

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  node: WorkflowNode & { type: "human-approval" | "generate-image" };
  onChange: (updated: WorkflowNode) => void;
};

// ── human-approval 表单 ───────────────────────────────────────────────────────

function HumanApprovalForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "human-approval" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowHumanApprovalConfig;

  function updateConfig(patch: Partial<WorkflowHumanApprovalConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  // 检测是否是预设的超时值
  const isPresetTimeout = TIMEOUT_OPTIONS.some((o) => o.value === cfg.timeoutMs);

  return (
    <div className="flex flex-col gap-4">
      {/* 标题 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>审批标题</label>
        <input
          className={INPUT_CLS}
          value={cfg.title}
          placeholder="需要审批"
          onChange={(e) => updateConfig({ title: e.target.value })}
        />
      </div>

      {/* 说明 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>审批说明</label>
        <textarea
          className={`${INPUT_CLS} min-h-[80px] resize-y`}
          value={cfg.instruction}
          placeholder="请审核以下内容并决定是否批准…支持 {{变量}} 插值。"
          onChange={(e) => updateConfig({ instruction: e.target.value })}
        />
      </div>

      {/* 超时 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>超时时间</label>
        <select
          className={INPUT_CLS}
          value={isPresetTimeout ? cfg.timeoutMs : "custom"}
          onChange={(e) => {
            const v = e.target.value;
            if (v !== "custom") updateConfig({ timeoutMs: Number(v) });
          }}
        >
          {TIMEOUT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {!isPresetTimeout ? (
            <option value="custom">自定义 ({cfg.timeoutMs}ms)</option>
          ) : null}
        </select>
        {cfg.timeoutMs > 0 ? (
          <p className="text-[11px] text-ds-faint">
            超时后按下方策略自动处理
          </p>
        ) : null}
      </div>

      {/* 超时策略 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>超时策略</label>
        <select
          className={INPUT_CLS}
          value={cfg.onTimeout}
          onChange={(e) => updateConfig({ onTimeout: e.target.value as WorkflowApprovalDecision })}
        >
          <option value="approved">自动批准</option>
          <option value="rejected">自动拒绝</option>
        </select>
      </div>
    </div>
  );
}

// ── generate-image 表单 ───────────────────────────────────────────────────────

function GenerateImageForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "generate-image" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowGenerateImageConfig;
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const providers = providerSettings?.providers ?? [];

  // 当前 provider 的模型列表
  const currentProvider = providers.find((p) => p.id === cfg.providerId);
  const models = currentProvider?.models ?? [];

  function updateConfig(patch: Partial<WorkflowGenerateImageConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  function handleProviderChange(pid: string) {
    const p = providers.find((x) => x.id === pid);
    updateConfig({
      providerId: pid,
      model: p?.models?.[0]?.id ?? "",
    });
  }

  const isPresetSize = IMAGE_SIZE_PRESETS.includes(cfg.size);

  return (
    <div className="flex flex-col gap-4">
      {/* 提示词 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>生成提示词</label>
        <textarea
          className={`${INPUT_CLS} min-h-[80px] resize-y`}
          value={cfg.prompt}
          placeholder="A beautiful landscape with mountains and a lake at sunset…支持 {{变量}} 插值。"
          onChange={(e) => updateConfig({ prompt: e.target.value })}
        />
      </div>

      {/* 供应商 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>供应商</label>
        <select
          className={INPUT_CLS}
          value={cfg.providerId}
          onChange={(e) => handleProviderChange(e.target.value)}
        >
          <option value="">选择供应商…</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* 模型 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>模型</label>
        <select
          className={INPUT_CLS}
          value={cfg.model}
          onChange={(e) => updateConfig({ model: e.target.value })}
          disabled={!currentProvider}
        >
          <option value="">选择模型…</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label ?? m.id}
            </option>
          ))}
        </select>
      </div>

      {/* 图片尺寸 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>图片尺寸</label>
        <select
          className={INPUT_CLS}
          value={isPresetSize ? cfg.size : "custom"}
          onChange={(e) => {
            if (e.target.value !== "custom") updateConfig({ size: e.target.value });
          }}
        >
          {IMAGE_SIZE_PRESETS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
          {!isPresetSize ? (
            <option value="custom">自定义 ({cfg.size})</option>
          ) : null}
        </select>
      </div>

      {/* 输出目录 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>输出目录（可选）</label>
        <input
          className={INPUT_CLS}
          value={cfg.outputDir}
          placeholder="留空 = <工作区>/workflow-images"
          onChange={(e) => updateConfig({ outputDir: e.target.value })}
        />
      </div>
    </div>
  );
}

// ── 主导出 ───────────────────────────────────────────────────────────────────

export function ApprovalNodeForm({ node, onChange }: Props) {
  if (node.type === "human-approval") {
    return (
      <HumanApprovalForm
        node={node as WorkflowNode & { type: "human-approval" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "generate-image") {
    return (
      <GenerateImageForm
        node={node as WorkflowNode & { type: "generate-image" }}
        onChange={onChange}
      />
    );
  }
  return null;
}

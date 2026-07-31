// AiNodeForm.tsx — ai-agent / parameter-extractor / question-classifier 节点配置表单。
// 模型选择复用全局 ModelRefField（Provider Catalog 驱动,能力只读,悬空引用进阻断态）。
// reasoningEffort 三档选择；categories/fields 列表编辑。

import type { WorkflowNode } from "@cortex-work/core";
import type {
  WorkflowAiAgentConfig,
  WorkflowParameterExtractorConfig,
  WorkflowQuestionClassifierConfig,
  WorkflowInputField,
  WorkflowInputFieldType,
  WorkflowClassifierCategory,
} from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { INPUT_CLS, FIELD_LABEL_CLS, SECTION_LABEL_CLS } from "./TriggerNodeForm";
import { ModelRefField } from "../../settings/provider/ModelRefField";

// ── 常量 ─────────────────────────────────────────────────────────────────────

const REASONING_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "auto", label: "自动" },
  { value: "off", label: "关闭" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "max", label: "最高" },
];

const MODE_OPTIONS = [
  { value: "agent", label: "Agent（自动执行）" },
  { value: "plan", label: "Plan（只读分析）" },
];

const FIELD_TYPES: WorkflowInputFieldType[] = [
  "text",
  "paragraph",
  "number",
  "boolean",
  "select",
  "json",
];
const FIELD_TYPE_LABELS: Record<WorkflowInputFieldType, string> = {
  text: "文本",
  paragraph: "段落",
  number: "数值",
  boolean: "布尔",
  select: "选项",
  json: "JSON",
};

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  node: WorkflowNode & { type: "ai-agent" | "parameter-extractor" | "question-classifier" };
  onChange: (updated: WorkflowNode) => void;
};

// ── 共享：provider/model 联动选择器 ─────────────────────────────────────────

/**
 * workflow AI 节点的模型选择：改为 Catalog 驱动的单一 {providerId, modelId}（计划 §4.2/§5）。
 * 旧版是「供应商下拉 + 模型下拉」两级联动，数据源是被废弃的 providerSettings.providers，
 * 且切供应商时会自动落到「第一个模型」——工作流是自动执行的，静默换模型没人会察觉。
 * 这里改成显式选择 + 悬空引用阻断，绝不自动回退。
 */
function ProviderModelPicker({
  providerId,
  model,
  onProviderChange,
  onModelChange,
}: {
  providerId: string;
  model: string;
  onProviderChange: (pid: string) => void;
  onModelChange: (mid: string) => void;
}) {
  return (
    <ModelRefField
      label="模型"
      value={providerId && model ? { providerId, modelId: model } : undefined}
      onChange={(ref) => {
        onProviderChange(ref.providerId);
        onModelChange(ref.modelId);
      }}
    />
  );
}

// ── ai-agent 表单 ─────────────────────────────────────────────────────────────

function AiAgentForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "ai-agent" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowAiAgentConfig;

  function updateConfig(patch: Partial<WorkflowAiAgentConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 提示词 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>提示词</label>
        <textarea
          className={`${INPUT_CLS} min-h-[100px] resize-y font-mono text-[12px]`}
          value={cfg.prompt}
          placeholder="输入给 AI 的指令，支持 {{变量}} 插值…"
          onChange={(e) => updateConfig({ prompt: e.target.value })}
        />
        <p className="text-[11px] text-ds-faint">
          可用 {"{{$input}}"}、{"{{$nodes.节点id.json.字段}}"} 引用上游输出。
        </p>
      </div>

      {/* 运行模式 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>运行模式</label>
        <select
          className={INPUT_CLS}
          value={cfg.mode}
          onChange={(e) => updateConfig({ mode: e.target.value as "agent" | "plan" })}
        >
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* 工作区目录 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>工作区目录</label>
        <input
          className={INPUT_CLS}
          value={cfg.workspaceRoot}
          placeholder="~/.cortex/workspace"
          onChange={(e) => updateConfig({ workspaceRoot: e.target.value })}
        />
      </div>

      {/* 供应商 / 模型 */}
      <ProviderModelPicker
        providerId={cfg.providerId}
        model={cfg.model}
        onProviderChange={(pid) => updateConfig({ providerId: pid })}
        onModelChange={(mid) => updateConfig({ model: mid })}
      />

      {/* 推理强度 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>推理强度</label>
        <select
          className={INPUT_CLS}
          value={cfg.reasoningEffort}
          onChange={(e) =>
            updateConfig({
              reasoningEffort: e.target.value as WorkflowAiAgentConfig["reasoningEffort"],
            })
          }
        >
          {REASONING_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ── parameter-extractor 表单 ─────────────────────────────────────────────────

function ParameterExtractorForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "parameter-extractor" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowParameterExtractorConfig;

  function updateConfig(patch: Partial<WorkflowParameterExtractorConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  function updateField(idx: number, patch: Partial<WorkflowInputField>) {
    const fields = cfg.fields.map((f, i) => (i === idx ? { ...f, ...patch } : f));
    updateConfig({ fields });
  }

  function addField() {
    updateConfig({
      fields: [
        ...cfg.fields,
        {
          key: `field_${cfg.fields.length + 1}`,
          label: "",
          type: "text",
          required: false,
          options: [],
          defaultValue: "",
          description: "",
        },
      ],
    });
  }

  function removeField(idx: number) {
    updateConfig({ fields: cfg.fields.filter((_, i) => i !== idx) });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 输入来源表达式 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>输入来源</label>
        <input
          className={`${INPUT_CLS} font-mono`}
          value={cfg.source}
          placeholder="{{$input.text}} 或 {{$nodes.xxx.json.output}}"
          onChange={(e) => updateConfig({ source: e.target.value })}
        />
      </div>

      {/* 指令 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>提取指令（可选）</label>
        <textarea
          className={`${INPUT_CLS} min-h-[60px] resize-y`}
          value={cfg.instruction}
          placeholder="描述需要从文本中提取哪些参数…"
          onChange={(e) => updateConfig({ instruction: e.target.value })}
        />
      </div>

      {/* 供应商 / 模型 */}
      <ProviderModelPicker
        providerId={cfg.providerId}
        model={cfg.model}
        onProviderChange={(pid) => updateConfig({ providerId: pid })}
        onModelChange={(mid) => updateConfig({ model: mid })}
      />

      {/* 推理强度 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>推理强度</label>
        <select
          className={INPUT_CLS}
          value={cfg.reasoningEffort}
          onChange={(e) =>
            updateConfig({
              reasoningEffort: e.target.value as WorkflowParameterExtractorConfig["reasoningEffort"],
            })
          }
        >
          {REASONING_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* 字段列表 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className={SECTION_LABEL_CLS}>提取字段</span>
          <button
            type="button"
            onClick={addField}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent hover:bg-accent/10 transition"
          >
            <Icon.Plus size={13} sw={2} />
            添加
          </button>
        </div>
        {cfg.fields.map((f, idx) => (
          <div key={idx} className="rounded-xl border border-ds-border bg-ds-card/60 p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                className={`${INPUT_CLS} min-w-0 flex-1 font-mono`}
                value={f.key}
                placeholder="字段 key"
                onChange={(e) => updateField(idx, { key: e.target.value })}
              />
              <select
                className={`${INPUT_CLS} basis-[80px] shrink-0`}
                value={f.type}
                onChange={(e) => updateField(idx, { type: e.target.value as WorkflowInputFieldType })}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {FIELD_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => removeField(idx)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ds-faint hover:bg-red-500/10 hover:text-red-600 transition"
              >
                <Icon.X size={13} sw={2} />
              </button>
            </div>
            {/* label + required(执行器据此在 schema 中标注必填，见 ai.ts) */}
            <div className="flex items-center gap-2">
              <input
                className={`${INPUT_CLS} min-w-0 flex-1`}
                value={f.label}
                placeholder="显示标签"
                onChange={(e) => updateField(idx, { label: e.target.value })}
              />
              <label className="flex items-center gap-1 text-[12px] text-ds-muted whitespace-nowrap shrink-0">
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) => updateField(idx, { required: e.target.checked })}
                />
                必填
              </label>
            </div>
            {/* description 进入 schema prompt(见 ai.ts)；defaultValue 为 Kun 字段对齐 */}
            <input
              className={INPUT_CLS}
              value={f.defaultValue}
              placeholder="默认值（可选）"
              onChange={(e) => updateField(idx, { defaultValue: e.target.value })}
            />
            <input
              className={INPUT_CLS}
              value={f.description}
              placeholder="字段说明（可选，进入提取指令）"
              onChange={(e) => updateField(idx, { description: e.target.value })}
            />
            {f.type === "select" ? (
              <input
                className={INPUT_CLS}
                value={f.options.join(",")}
                placeholder="选项（逗号分隔，如 A,B,C）"
                onChange={(e) =>
                  updateField(idx, {
                    options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                  })
                }
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── question-classifier 表单 ─────────────────────────────────────────────────

function QuestionClassifierForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "question-classifier" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowQuestionClassifierConfig;

  function updateConfig(patch: Partial<WorkflowQuestionClassifierConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  function updateCategory(idx: number, patch: Partial<WorkflowClassifierCategory>) {
    const categories = cfg.categories.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    updateConfig({ categories });
  }

  function addCategory() {
    updateConfig({
      categories: [
        ...cfg.categories,
        { id: `cat_${cfg.categories.length + 1}`, label: "" },
      ],
    });
  }

  function removeCategory(idx: number) {
    updateConfig({ categories: cfg.categories.filter((_, i) => i !== idx) });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 输入来源 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>输入来源</label>
        <input
          className={`${INPUT_CLS} font-mono`}
          value={cfg.source}
          placeholder="{{$input.text}}"
          onChange={(e) => updateConfig({ source: e.target.value })}
        />
      </div>

      {/* 分类指令 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>分类指令（可选）</label>
        <textarea
          className={`${INPUT_CLS} min-h-[60px] resize-y`}
          value={cfg.instruction}
          placeholder="描述如何对输入进行分类…"
          onChange={(e) => updateConfig({ instruction: e.target.value })}
        />
      </div>

      {/* 供应商 / 模型 */}
      <ProviderModelPicker
        providerId={cfg.providerId}
        model={cfg.model}
        onProviderChange={(pid) => updateConfig({ providerId: pid })}
        onModelChange={(mid) => updateConfig({ model: mid })}
      />

      {/* 推理强度 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>推理强度</label>
        <select
          className={INPUT_CLS}
          value={cfg.reasoningEffort}
          onChange={(e) =>
            updateConfig({
              reasoningEffort: e.target.value as WorkflowQuestionClassifierConfig["reasoningEffort"],
            })
          }
        >
          {REASONING_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* 分类列表（最多 20 个）*/}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className={SECTION_LABEL_CLS}>分类（最多 20 个）</span>
          <button
            type="button"
            onClick={addCategory}
            disabled={cfg.categories.length >= 20}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent hover:bg-accent/10 transition disabled:opacity-40"
          >
            <Icon.Plus size={13} sw={2} />
            添加
          </button>
        </div>
        {cfg.categories.map((cat, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <input
              className={`${INPUT_CLS} basis-28 shrink-0 font-mono`}
              value={cat.id}
              placeholder="cat_id"
              onChange={(e) => updateCategory(idx, { id: e.target.value })}
            />
            <input
              className={`${INPUT_CLS} min-w-0 flex-1`}
              value={cat.label}
              placeholder="分类标签"
              onChange={(e) => updateCategory(idx, { label: e.target.value })}
            />
            {/* 至少保留 1 个分类，防删空导致运行无分支(对齐 Kun disabled<=1) */}
            <button
              type="button"
              onClick={() => removeCategory(idx)}
              disabled={cfg.categories.length <= 1}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ds-faint hover:bg-red-500/10 hover:text-red-600 transition disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ds-faint"
            >
              <Icon.X size={13} sw={2} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 主导出 ───────────────────────────────────────────────────────────────────

export function AiNodeForm({ node, onChange }: Props) {
  if (node.type === "ai-agent") {
    return (
      <AiAgentForm
        node={node as WorkflowNode & { type: "ai-agent" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "parameter-extractor") {
    return (
      <ParameterExtractorForm
        node={node as WorkflowNode & { type: "parameter-extractor" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "question-classifier") {
    return (
      <QuestionClassifierForm
        node={node as WorkflowNode & { type: "question-classifier" }}
        onChange={onChange}
      />
    );
  }
  return null;
}

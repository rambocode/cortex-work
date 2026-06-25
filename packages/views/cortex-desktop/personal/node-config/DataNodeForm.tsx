// DataNodeForm.tsx — 数据处理节点配置表单。
// 覆盖：set-fields / sort / limit / aggregate / template / json / output

import type { WorkflowNode } from "@cortex-work/core";
import type {
  WorkflowSetFieldsConfig,
  WorkflowSortConfig,
  WorkflowLimitConfig,
  WorkflowAggregateConfig,
  WorkflowTemplateConfig,
  WorkflowJsonConfig,
  WorkflowOutputConfig,
  WorkflowField,
  WorkflowSortOrder,
  WorkflowLimitFrom,
  WorkflowAggregateMode,
} from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { INPUT_CLS, FIELD_LABEL_CLS, SECTION_LABEL_CLS } from "./TriggerNodeForm";

// sort/limit/aggregate 均作用于「数组输入」，顶部统一提示用户上游需输出数组(对齐 Kun workflowArrayHint)
const ARRAY_HINT_CLS = "text-[11.5px] leading-relaxed text-ds-faint";

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  node: WorkflowNode & {
    type: "set-fields" | "sort" | "limit" | "aggregate" | "template" | "json" | "output";
  };
  onChange: (updated: WorkflowNode) => void;
};

// ── set-fields ────────────────────────────────────────────────────────────────

function SetFieldsForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "set-fields" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowSetFieldsConfig;

  function updateConfig(patch: Partial<WorkflowSetFieldsConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  function updateField(idx: number, patch: Partial<WorkflowField>) {
    const fields = cfg.fields.map((f, i) => (i === idx ? { ...f, ...patch } : f));
    updateConfig({ fields });
  }

  function addField() {
    updateConfig({ fields: [...cfg.fields, { key: "", value: "" }] });
  }

  function removeField(idx: number) {
    updateConfig({ fields: cfg.fields.filter((_, i) => i !== idx) });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 字段列表 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className={SECTION_LABEL_CLS}>字段赋值</span>
          <button
            type="button"
            onClick={addField}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent hover:bg-accent/10 transition"
          >
            <Icon.Plus size={13} sw={2} />
            添加字段
          </button>
        </div>
        {cfg.fields.length === 0 ? (
          <p className="py-2 text-center text-[12px] text-ds-faint">暂无字段</p>
        ) : (
          cfg.fields.map((f, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                className={`${INPUT_CLS} w-32 shrink-0 font-mono`}
                value={f.key}
                placeholder="字段名"
                onChange={(e) => updateField(idx, { key: e.target.value })}
              />
              <input
                className={`${INPUT_CLS} flex-1 font-mono`}
                value={f.value}
                placeholder="值或 {{表达式}}"
                onChange={(e) => updateField(idx, { value: e.target.value })}
              />
              <button
                type="button"
                onClick={() => removeField(idx)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ds-faint hover:bg-red-500/10 hover:text-red-600 transition"
              >
                <Icon.X size={13} sw={2} />
              </button>
            </div>
          ))
        )}
      </div>

      {/* keepIncoming */}
      <label className="flex items-center gap-2 text-[12px] text-ds-muted">
        <input
          type="checkbox"
          checked={cfg.keepIncoming}
          onChange={(e) => updateConfig({ keepIncoming: e.target.checked })}
        />
        保留传入字段（不替换，仅追加/覆盖）
      </label>

      {/* scope */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>写入作用域</label>
        <select
          className={INPUT_CLS}
          value={cfg.scope ?? "payload"}
          onChange={(e) =>
            updateConfig({ scope: e.target.value as WorkflowSetFieldsConfig["scope"] })
          }
        >
          <option value="payload">节点输出（payload）</option>
          <option value="run">运行级变量（$run.key）</option>
        </select>
      </div>
    </div>
  );
}

// ── sort ──────────────────────────────────────────────────────────────────────

function SortForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "sort" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowSortConfig;

  function updateConfig(patch: Partial<WorkflowSortConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className={ARRAY_HINT_CLS}>对上游输出的数组逐项排序；非数组输入将原样透传。</p>
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>排序字段</label>
        <input
          className={`${INPUT_CLS} font-mono`}
          value={cfg.field}
          placeholder="json.score 或 text"
          onChange={(e) => updateConfig({ field: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>排序方向</label>
        <select
          className={INPUT_CLS}
          value={cfg.order}
          onChange={(e) => updateConfig({ order: e.target.value as WorkflowSortOrder })}
        >
          <option value="asc">升序（asc）</option>
          <option value="desc">降序（desc）</option>
        </select>
      </div>
      <label className="flex items-center gap-2 text-[12px] text-ds-muted">
        <input
          type="checkbox"
          checked={cfg.numeric}
          onChange={(e) => updateConfig({ numeric: e.target.checked })}
        />
        按数值排序（否则字符串排序）
      </label>
    </div>
  );
}

// ── limit ─────────────────────────────────────────────────────────────────────

function LimitForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "limit" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowLimitConfig;

  function updateConfig(patch: Partial<WorkflowLimitConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className={ARRAY_HINT_CLS}>截取上游数组的前/后 N 条；非数组输入将原样透传。</p>
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>条数（1–100000）</label>
        <input
          type="number"
          className={INPUT_CLS}
          value={cfg.count}
          min={1}
          max={100000}
          // clamp 到 [1, 100000]，防止手输 0/负数/越界(对齐 Kun 的 Math.max/min 约束)
          onChange={(e) =>
            updateConfig({ count: Math.max(1, Math.min(100000, Number(e.target.value) || 1)) })
          }
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>截取方式</label>
        <select
          className={INPUT_CLS}
          value={cfg.from}
          onChange={(e) => updateConfig({ from: e.target.value as WorkflowLimitFrom })}
        >
          <option value="first">前 N 条</option>
          <option value="last">后 N 条</option>
        </select>
      </div>
    </div>
  );
}

// ── aggregate ─────────────────────────────────────────────────────────────────

function AggregateForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "aggregate" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowAggregateConfig;

  function updateConfig(patch: Partial<WorkflowAggregateConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  const isJoin = cfg.mode === "join";

  return (
    <div className="flex flex-col gap-3">
      <p className={ARRAY_HINT_CLS}>对上游输出的数组做聚合计算；非数组输入将原样透传。</p>
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>聚合模式</label>
        <select
          className={INPUT_CLS}
          value={cfg.mode}
          onChange={(e) => updateConfig({ mode: e.target.value as WorkflowAggregateMode })}
        >
          <option value="count">计数（count）</option>
          <option value="sum">求和（sum）</option>
          <option value="collect">收集为数组（collect）</option>
          <option value="join">拼接为字符串（join）</option>
        </select>
      </div>
      {/* count 模式不取字段(直接 items.length)，隐藏聚合字段避免无意义输入(对齐 Kun + data.ts 执行器) */}
      {cfg.mode !== "count" ? (
        <div className="flex flex-col gap-1">
          <label className={FIELD_LABEL_CLS}>聚合字段</label>
          <input
            className={`${INPUT_CLS} font-mono`}
            value={cfg.field}
            placeholder="json.value 或 text"
            onChange={(e) => updateConfig({ field: e.target.value })}
          />
        </div>
      ) : null}
      {isJoin ? (
        <div className="flex flex-col gap-1">
          <label className={FIELD_LABEL_CLS}>分隔符</label>
          <input
            className={`${INPUT_CLS} font-mono`}
            value={cfg.separator}
            placeholder=", "
            onChange={(e) => updateConfig({ separator: e.target.value })}
          />
        </div>
      ) : null}
    </div>
  );
}

// ── template ──────────────────────────────────────────────────────────────────

function TemplateForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "template" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowTemplateConfig;

  function updateConfig(patch: Partial<WorkflowTemplateConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 模板内容在前、输出模式在后，对齐 Kun 的字段顺序(主输入优先) */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>模板内容</label>
        <textarea
          className={`${INPUT_CLS} min-h-[120px] resize-y font-mono text-[12px]`}
          value={cfg.template}
          placeholder="Hello {{$input.name}}，今天是 {{$run.date}}。"
          onChange={(e) => updateConfig({ template: e.target.value })}
        />
        <p className="text-[11px] text-ds-faint">
          使用 {"{{变量}}"} 插值，支持 $input、$nodes、$env、$run、$loop。
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>输出模式</label>
        <select
          className={INPUT_CLS}
          value={cfg.outputMode}
          onChange={(e) =>
            updateConfig({ outputMode: e.target.value as WorkflowTemplateConfig["outputMode"] })
          }
        >
          <option value="text">文本</option>
          <option value="json">JSON</option>
        </select>
      </div>
    </div>
  );
}

// ── json ──────────────────────────────────────────────────────────────────────

function JsonForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "json" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowJsonConfig;

  function updateConfig(patch: Partial<WorkflowJsonConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>操作</label>
        <select
          className={INPUT_CLS}
          value={cfg.mode}
          onChange={(e) =>
            updateConfig({ mode: e.target.value as WorkflowJsonConfig["mode"] })
          }
        >
          <option value="parse">解析（JSON 字符串 → 对象）</option>
          <option value="stringify">序列化（对象 → JSON 字符串）</option>
        </select>
      </div>
      {/* strict 仅 parse 模式生效(stringify 忽略，见 data.ts)，故仅 parse 时渲染，对齐 Kun */}
      {cfg.mode === "parse" ? (
        <label className="flex items-center gap-2 text-[12px] text-ds-muted">
          <input
            type="checkbox"
            checked={cfg.strict}
            onChange={(e) => updateConfig({ strict: e.target.checked })}
          />
          严格模式（解析失败时中断）
        </label>
      ) : null}
    </div>
  );
}

// ── output ────────────────────────────────────────────────────────────────────

function OutputForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "output" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowOutputConfig;

  function updateConfig(patch: Partial<WorkflowOutputConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className={ARRAY_HINT_CLS}>终态输出节点：决定本次运行的规范输出（供调用方/日志读取）。</p>
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>输出模式</label>
        <select
          className={INPUT_CLS}
          value={cfg.mode}
          onChange={(e) =>
            updateConfig({ mode: e.target.value as WorkflowOutputConfig["mode"] })
          }
        >
          <option value="auto">自动（优先 json，否则 text）</option>
          <option value="text">文本模板</option>
          <option value="json">JSON 路径提取</option>
        </select>
      </div>
      {/* auto 模式直接透传 payload、不渲染模板(见 data.ts executeOutput)，故仅 text 模式显示，对齐 Kun */}
      {cfg.mode === "text" ? (
        <div className="flex flex-col gap-1">
          <label className={FIELD_LABEL_CLS}>文本模板</label>
          <textarea
            className={`${INPUT_CLS} min-h-[80px] resize-y font-mono text-[12px]`}
            value={cfg.textTemplate}
            placeholder="{{$input.text}}"
            onChange={(e) => updateConfig({ textTemplate: e.target.value })}
          />
        </div>
      ) : null}
      {cfg.mode === "json" ? (
        <div className="flex flex-col gap-1">
          <label className={FIELD_LABEL_CLS}>JSON 路径</label>
          <input
            className={`${INPUT_CLS} font-mono`}
            value={cfg.jsonPath}
            placeholder="json.result.value"
            onChange={(e) => updateConfig({ jsonPath: e.target.value })}
          />
        </div>
      ) : null}
    </div>
  );
}

// ── 主导出 ───────────────────────────────────────────────────────────────────

export function DataNodeForm({ node, onChange }: Props) {
  if (node.type === "set-fields") {
    return (
      <SetFieldsForm
        node={node as WorkflowNode & { type: "set-fields" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "sort") {
    return (
      <SortForm
        node={node as WorkflowNode & { type: "sort" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "limit") {
    return (
      <LimitForm
        node={node as WorkflowNode & { type: "limit" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "aggregate") {
    return (
      <AggregateForm
        node={node as WorkflowNode & { type: "aggregate" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "template") {
    return (
      <TemplateForm
        node={node as WorkflowNode & { type: "template" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "json") {
    return (
      <JsonForm
        node={node as WorkflowNode & { type: "json" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "output") {
    return (
      <OutputForm
        node={node as WorkflowNode & { type: "output" }}
        onChange={onChange}
      />
    );
  }
  return null;
}

// HttpNodeForm.tsx — http-request 节点配置表单。
// 覆盖：method / url / headers 列表 / body / timeoutMs / parseJson

import type { WorkflowNode } from "@cortex-work/core";
import type {
  WorkflowHttpRequestConfig,
  WorkflowHttpMethod,
  WorkflowHttpHeader,
} from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { INPUT_CLS, FIELD_LABEL_CLS, SECTION_LABEL_CLS } from "./TriggerNodeForm";

// ── 常量 ─────────────────────────────────────────────────────────────────────

const HTTP_METHODS: WorkflowHttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  node: WorkflowNode & { type: "http-request" };
  onChange: (updated: WorkflowNode) => void;
};

// ── HttpRequestForm ───────────────────────────────────────────────────────────

export function HttpNodeForm({ node, onChange }: Props) {
  const cfg = node.config as WorkflowHttpRequestConfig;

  function updateConfig(patch: Partial<WorkflowHttpRequestConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  function updateHeader(idx: number, patch: Partial<WorkflowHttpHeader>) {
    const headers = cfg.headers.map((h, i) => (i === idx ? { ...h, ...patch } : h));
    updateConfig({ headers });
  }

  function addHeader() {
    updateConfig({ headers: [...cfg.headers, { key: "", value: "" }] });
  }

  function removeHeader(idx: number) {
    updateConfig({ headers: cfg.headers.filter((_, i) => i !== idx) });
  }

  const hasBody = ["POST", "PUT", "PATCH"].includes(cfg.method);
  const timeoutSec = (cfg.timeoutMs / 1000).toFixed(0);

  return (
    <div className="flex flex-col gap-4">
      {/* 请求方法 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>方法</label>
        <select
          className={INPUT_CLS}
          value={cfg.method}
          onChange={(e) => updateConfig({ method: e.target.value as WorkflowHttpMethod })}
        >
          {HTTP_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {/* URL */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>URL</label>
        <input
          className={`${INPUT_CLS} font-mono`}
          value={cfg.url}
          placeholder="https://api.example.com/v1/..."
          onChange={(e) => updateConfig({ url: e.target.value })}
        />
      </div>

      {/* Headers */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className={SECTION_LABEL_CLS}>请求头</span>
          <button
            type="button"
            onClick={addHeader}
            disabled={cfg.headers.length >= 50}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent hover:bg-accent/10 transition disabled:opacity-40"
          >
            <Icon.Plus size={13} sw={2} />
            添加
          </button>
        </div>
        {cfg.headers.length === 0 ? (
          <p className="py-2 text-center text-[12px] text-ds-faint">暂无请求头</p>
        ) : (
          cfg.headers.map((h, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                className={`${INPUT_CLS} basis-36 shrink-0 font-mono`}
                value={h.key}
                placeholder="Header-Name"
                onChange={(e) => updateHeader(idx, { key: e.target.value })}
              />
              {/* min-w-0：input 默认 min-width:auto 不会收缩到内容宽度以下，
                  不加会导致整行超出面板宽度、值输入框被右侧裁掉 */}
              <input
                className={`${INPUT_CLS} min-w-0 flex-1 font-mono`}
                value={h.value}
                placeholder="值或 {{表达式}}"
                onChange={(e) => updateHeader(idx, { value: e.target.value })}
              />
              <button
                type="button"
                onClick={() => removeHeader(idx)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ds-faint hover:bg-red-500/10 hover:text-red-600 transition"
              >
                <Icon.X size={13} sw={2} />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Body（仅 POST/PUT/PATCH 显示）*/}
      {hasBody ? (
        <div className="flex flex-col gap-1">
          <label className={FIELD_LABEL_CLS}>请求体</label>
          <textarea
            className={`${INPUT_CLS} min-h-[100px] resize-y font-mono text-[12px]`}
            value={cfg.body}
            placeholder='{"key": "{{$input.value}}"}'
            onChange={(e) => updateConfig({ body: e.target.value })}
          />
        </div>
      ) : null}

      {/* 超时 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>超时（毫秒，1000–600000）</label>
        <input
          type="number"
          className={INPUT_CLS}
          value={cfg.timeoutMs}
          min={1000}
          max={600000}
          step={1000}
          onChange={(e) => updateConfig({ timeoutMs: Number(e.target.value) })}
        />
        <span className="text-[11px] text-ds-faint">{timeoutSec} 秒</span>
      </div>

      {/* parseJson */}
      <label className="flex items-center gap-2 text-[12px] text-ds-muted">
        <input
          type="checkbox"
          checked={cfg.parseJson}
          onChange={(e) => updateConfig({ parseJson: e.target.checked })}
        />
        自动解析响应为 JSON（成功时节点输出含 json 字段）
      </label>
    </div>
  );
}

// TriggerNodeForm.tsx — manual/schedule/webhook-trigger 节点配置表单。
// schedule 复用 ScheduleEditor；webhook 显示 path/method + 只读 URL/token 提示。
// onChange 回调将整个更新后的 WorkflowNode 传给容器（NodeConfigPanel）。

import type { WorkflowNode } from "@cortex-work/core";
import type {
  WorkflowManualTriggerConfig,
  WorkflowScheduleTriggerConfig,
  WorkflowWebhookTriggerConfig,
  WorkflowWebhookMethod,
  WorkflowInputField,
  WorkflowInputFieldType,
} from "@cortex-work/core";
import { ScheduleEditor } from "../ScheduleEditor";
import type { ScheduleSpec } from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";

// ── 共享输入样式（与 WorkflowEditorView EnvVarsModal 对齐）────────────────────
export const INPUT_CLS =
  "w-full rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[13px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/25";

export const SECTION_LABEL_CLS = "text-[11px] font-semibold uppercase tracking-wide text-ds-faint";
export const FIELD_LABEL_CLS = "text-[12px] font-medium text-ds-muted";

const WEBHOOK_METHODS: WorkflowWebhookMethod[] = ["ANY", "GET", "POST", "PUT", "PATCH", "DELETE"];

// ── 输入字段类型选项 ─────────────────────────────────────────────────────────
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

// ── Props ──────────────────────────────────────────────────────────────────

type Props = {
  node: WorkflowNode & { type: "manual-trigger" | "schedule-trigger" | "webhook-trigger" };
  onChange: (updated: WorkflowNode) => void;
  /** 工作流 id，用于生成 webhook URL 预览。 */
  workflowId?: string;
};

// ── manual-trigger ───────────────────────────────────────────────────────────

/** 本地 API 端口（webhook-server 默认监听端口；无设置 UI，恒为此值）。 */
const LOCAL_API_PORT = 18765;

function ManualTriggerForm({
  node,
  onChange,
  workflowId,
}: {
  node: WorkflowNode & { type: "manual-trigger" };
  onChange: (updated: WorkflowNode) => void;
  workflowId?: string;
}) {
  const cfg = node.config as WorkflowManualTriggerConfig;

  function updateConfig(patch: Partial<WorkflowManualTriggerConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  function updateField(idx: number, patch: Partial<WorkflowInputField>) {
    const fields = (cfg.inputSchema ?? []).map((f, i) =>
      i === idx ? { ...f, ...patch } : f,
    );
    updateConfig({ inputSchema: fields });
  }

  function addField() {
    const fields = cfg.inputSchema ?? [];
    updateConfig({
      inputSchema: [
        ...fields,
        {
          key: `field_${fields.length + 1}`,
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
    updateConfig({
      inputSchema: (cfg.inputSchema ?? []).filter((_, i) => i !== idx),
    });
  }

  const fields = cfg.inputSchema ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* 工作区根目录 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>工作区目录（可选）</label>
        <input
          className={INPUT_CLS}
          value={cfg.workspaceRoot ?? ""}
          placeholder="留空 = 继承全局设置"
          onChange={(e) => updateConfig({ workspaceRoot: e.target.value || undefined })}
        />
      </div>

      {/* 输入字段模式 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className={SECTION_LABEL_CLS}>启动输入字段</span>
          <button
            type="button"
            onClick={addField}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent hover:bg-accent/10 transition"
          >
            <Icon.Plus size={13} sw={2} />
            添加字段
          </button>
        </div>
        {fields.length === 0 ? (
          <p className="py-3 text-center text-[12px] text-ds-faint">
            暂无输入字段，运行时直接触发
          </p>
        ) : (
          fields.map((f, idx) => (
            <div
              key={idx}
              className="rounded-xl border border-ds-border bg-ds-card/60 p-3 flex flex-col gap-2"
            >
              <div className="flex items-center gap-2">
                <input
                  className={`${INPUT_CLS} min-w-0 flex-1 font-mono`}
                  value={f.key}
                  placeholder="字段 key"
                  onChange={(e) => updateField(idx, { key: e.target.value })}
                />
                <select
                  className={`${INPUT_CLS} basis-[90px] shrink-0`}
                  value={f.type}
                  onChange={(e) =>
                    updateField(idx, { type: e.target.value as WorkflowInputFieldType })
                  }
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
              {/* label + defaultValue 并排一行，对齐 Kun InputFieldsEditor */}
              <div className="flex items-center gap-2">
                <input
                  className={`${INPUT_CLS} min-w-0 flex-1`}
                  value={f.label}
                  placeholder="显示标签"
                  onChange={(e) => updateField(idx, { label: e.target.value })}
                />
                <input
                  className={`${INPUT_CLS} min-w-0 flex-1`}
                  value={f.defaultValue}
                  placeholder="默认值"
                  onChange={(e) => updateField(idx, { defaultValue: e.target.value })}
                />
              </div>
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
              {/* required 独占一行，对齐 Kun */}
              <label className="flex items-center gap-2 text-[12px] text-ds-muted">
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) => updateField(idx, { required: e.target.checked })}
                />
                必填
              </label>
            </div>
          ))
        )}
      </div>

      {/* 本地 API：用 curl 触发此工作流（对齐 Kun Local API）。
          token 取自节点 config.runToken（normalize 自动生成），端口为 webhook-server 默认。
          新建未保存的节点尚无 runToken，此时显示占位提示。 */}
      <div className="flex flex-col gap-1.5 border-t border-ds-border pt-3">
        <span className="text-[12px] font-medium text-ds-muted">本地 API 调用</span>
        {cfg.runToken && workflowId ? (
          <>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ds-main px-3 py-2 font-mono text-[11px] leading-5 text-ds-muted">
              {buildRunCurl(workflowId, cfg.runToken)}
            </pre>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard?.writeText(buildRunCurl(workflowId, cfg.runToken!))
              }
              className="self-start rounded-md border border-ds-border px-2 py-1 text-[11.5px] font-medium text-ds-ink transition hover:bg-ds-hover"
            >
              复制
            </button>
            <span className="text-[11px] leading-4 text-ds-faint">
              向本机 127.0.0.1:{LOCAL_API_PORT} 发送此请求即可触发运行（仅本机可访问）。
              需先在顶部开启「已启用」，本地 API server 才会监听。
            </span>
          </>
        ) : (
          <span className="text-[11px] leading-4 text-ds-faint">
            保存工作流后将生成调用令牌与示例命令。
          </span>
        )}
      </div>
    </div>
  );
}

/** 构造触发该工作流的 curl 命令（POST /workflow/run + Bearer runToken）。 */
function buildRunCurl(workflowId: string, runToken: string): string {
  // 单引号转义，防止含引号的值破坏 -d '...' 包裹。
  const payload = JSON.stringify({ workflow: workflowId, input: {} }).replace(/'/g, "'\\''");
  return [
    `curl -X POST http://127.0.0.1:${LOCAL_API_PORT}/workflow/run \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Authorization: Bearer ${runToken}" \\`,
    `  -d '${payload}'`,
  ].join("\n");
}

// ── schedule-trigger ─────────────────────────────────────────────────────────

function ScheduleTriggerForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "schedule-trigger" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowScheduleTriggerConfig;

  return (
    <div className="flex flex-col gap-4">
      {/* ScheduleEditor 复用 automation 的调度编辑器 */}
      <ScheduleEditor
        value={cfg.schedule}
        onChange={(spec: ScheduleSpec) =>
          onChange({ ...node, config: { ...cfg, schedule: spec } })
        }
      />
      {/* 工作区根目录 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>工作区目录（可选）</label>
        <input
          className={INPUT_CLS}
          value={cfg.workspaceRoot ?? ""}
          placeholder="留空 = 继承全局设置"
          onChange={(e) =>
            onChange({
              ...node,
              config: { ...cfg, workspaceRoot: e.target.value || undefined },
            })
          }
        />
      </div>
    </div>
  );
}

// ── webhook-trigger ──────────────────────────────────────────────────────────

function WebhookTriggerForm({
  node,
  onChange,
  workflowId,
}: {
  node: WorkflowNode & { type: "webhook-trigger" };
  onChange: (updated: WorkflowNode) => void;
  workflowId?: string;
}) {
  const cfg = node.config as WorkflowWebhookTriggerConfig;

  function updateConfig(patch: Partial<WorkflowWebhookTriggerConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  // Webhook 入口 URL 只做预览（实际地址由主进程 webhook-server 管理）。
  // 端口取默认 18765（见 main/workflow/index.ts startWebhookServer 默认值）；
  // 若用户在设置里改了 webhookPort，此预览不会跟随——视图层暂无 settings 通道，按默认展示。
  const base = `http://localhost:18765/webhook${cfg.path || "/webhook"}`;
  const previewUrl = workflowId ? `${base}?workflowId=${workflowId}` : base;

  return (
    <div className="flex flex-col gap-4">
      {/* 监听路径 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>监听路径</label>
        <input
          className={`${INPUT_CLS} font-mono`}
          value={cfg.path}
          placeholder="/webhook"
          onChange={(e) => updateConfig({ path: e.target.value })}
        />
      </div>
      {/* HTTP 方法 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>允许方法</label>
        <select
          className={INPUT_CLS}
          value={cfg.method}
          onChange={(e) => updateConfig({ method: e.target.value as WorkflowWebhookMethod })}
        >
          {WEBHOOK_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      {/* 只读 URL 预览 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>触发 URL（只读预览）</label>
        <div className="flex items-center gap-1">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-ds-border bg-ds-main px-2.5 py-1.5 text-[11.5px] font-mono text-ds-faint">
            {previewUrl}
          </code>
        </div>
        <p className="text-[11px] text-ds-faint">
          工作流 Webhook Server 启动后，向此地址发送请求以触发运行。
        </p>
      </div>
      {/* 工作区根目录 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>工作区目录（可选）</label>
        <input
          className={INPUT_CLS}
          value={cfg.workspaceRoot ?? ""}
          placeholder="留空 = 继承全局设置"
          onChange={(e) =>
            onChange({
              ...node,
              config: { ...cfg, workspaceRoot: e.target.value || undefined },
            })
          }
        />
      </div>
    </div>
  );
}

// ── 主导出 ───────────────────────────────────────────────────────────────────

export function TriggerNodeForm({ node, onChange, workflowId }: Props) {
  if (node.type === "manual-trigger") {
    return (
      <ManualTriggerForm
        node={node as WorkflowNode & { type: "manual-trigger" }}
        onChange={onChange}
        workflowId={workflowId}
      />
    );
  }
  if (node.type === "schedule-trigger") {
    return (
      <ScheduleTriggerForm
        node={node as WorkflowNode & { type: "schedule-trigger" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "webhook-trigger") {
    return (
      <WebhookTriggerForm
        node={node as WorkflowNode & { type: "webhook-trigger" }}
        onChange={onChange}
        workflowId={workflowId}
      />
    );
  }
  return null;
}

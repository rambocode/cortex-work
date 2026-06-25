// CodeNodeForm.tsx — 代码节点（code / custom）配置表单。
// code：language 选择 + 代码编辑区（textarea，不引 Monaco 避免 SSR 复杂度）。
// custom：moduleId 输入 + 动态 values 表单（key/value 对）。

import type { WorkflowNode } from "@cortex-work/core";
import type {
  WorkflowCodeConfig,
  WorkflowCustomConfig,
  WorkflowCodeLanguage,
} from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { INPUT_CLS, FIELD_LABEL_CLS, SECTION_LABEL_CLS } from "./TriggerNodeForm";

// ── 常量 ─────────────────────────────────────────────────────────────────────

const CODE_LANGUAGE_OPTIONS: Array<{ value: WorkflowCodeLanguage; label: string }> = [
  { value: "javascript", label: "JavaScript" },
  { value: "python", label: "Python" },
  { value: "bash", label: "Bash" },
];

// 代码占位示例（对照 Kun CODE_PLACEHOLDERS）
const CODE_PLACEHOLDERS: Record<WorkflowCodeLanguage, string> = {
  javascript: `// $input  — 上游节点 payload
// $env    — 工作流环境变量
// return  — 节点输出（对象或原始值）

const { text, json } = $input;
return { result: text?.toUpperCase() };`,
  python: `# $input  — 上游节点 payload（dict）
# $env    — 工作流环境变量（dict）
# return  — 节点输出

result = input.get("text", "").upper()
return {"result": result}`,
  bash: `# $INPUT_TEXT   — $input.text
# $INPUT_JSON   — $input.json（JSON 字符串）
# $ENV_*        — 工作流环境变量
# stdout 最后一行 JSON 为节点输出

echo '{"result": "ok"}'`,
};

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  node: WorkflowNode & { type: "code" | "custom" };
  onChange: (updated: WorkflowNode) => void;
};

// ── code 表单 ─────────────────────────────────────────────────────────────────

function CodeForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "code" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowCodeConfig;

  function updateConfig(patch: Partial<WorkflowCodeConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  // 切换语言时，如果代码是另一种语言的 placeholder，自动替换为新 placeholder
  function handleLanguageChange(lang: WorkflowCodeLanguage) {
    const oldPlaceholder = CODE_PLACEHOLDERS[cfg.language];
    const newCode =
      !cfg.code || cfg.code === oldPlaceholder
        ? CODE_PLACEHOLDERS[lang]
        : cfg.code;
    updateConfig({ language: lang, code: newCode });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 语言选择 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>语言</label>
        <select
          className={INPUT_CLS}
          value={cfg.language}
          onChange={(e) => handleLanguageChange(e.target.value as WorkflowCodeLanguage)}
        >
          {CODE_LANGUAGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* 代码编辑区 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>代码</label>
        <textarea
          className={`${INPUT_CLS} min-h-[200px] resize-y font-mono text-[12px] leading-relaxed`}
          value={cfg.code}
          placeholder={CODE_PLACEHOLDERS[cfg.language]}
          spellCheck={false}
          onChange={(e) => updateConfig({ code: e.target.value })}
        />
        <p className="text-[11px] text-ds-faint">
          代码在主进程沙盒中运行，可读取 $input / $env。
          {cfg.language === "javascript" ? " 使用 return 返回输出。" : ""}
        </p>
      </div>
    </div>
  );
}

// ── custom 表单 ───────────────────────────────────────────────────────────────

function CustomForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "custom" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowCustomConfig;

  function updateConfig(patch: Partial<WorkflowCustomConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  // values 以 key/value 对列表形式展示
  const valueEntries = Object.entries(cfg.values);

  function updateValueKey(oldKey: string, newKey: string) {
    const next = { ...cfg.values };
    const val = next[oldKey] ?? "";
    delete next[oldKey];
    next[newKey] = val;
    updateConfig({ values: next });
  }

  function updateValueVal(key: string, val: string) {
    updateConfig({ values: { ...cfg.values, [key]: val } });
  }

  function addValue() {
    const key = `param_${valueEntries.length + 1}`;
    updateConfig({ values: { ...cfg.values, [key]: "" } });
  }

  function removeValue(key: string) {
    const next = { ...cfg.values };
    delete next[key];
    updateConfig({ values: next });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Module ID */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>模块 ID</label>
        <input
          className={`${INPUT_CLS} font-mono`}
          value={cfg.moduleId}
          placeholder="my-custom-module"
          onChange={(e) => updateConfig({ moduleId: e.target.value })}
        />
        <p className="text-[11px] text-ds-faint">
          对应主进程注册的自定义节点模块（U15 模块管理落地后可选择）。
        </p>
      </div>

      {/* 动态参数 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className={SECTION_LABEL_CLS}>参数</span>
          <button
            type="button"
            onClick={addValue}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent hover:bg-accent/10 transition"
          >
            <Icon.Plus size={13} sw={2} />
            添加
          </button>
        </div>
        {valueEntries.length === 0 ? (
          <p className="py-2 text-center text-[12px] text-ds-faint">暂无参数</p>
        ) : (
          valueEntries.map(([key, val]) => (
            <div key={key} className="flex items-center gap-2">
              <input
                className={`${INPUT_CLS} w-32 shrink-0 font-mono`}
                value={key}
                placeholder="参数名"
                onChange={(e) => updateValueKey(key, e.target.value)}
              />
              <input
                className={`${INPUT_CLS} flex-1 font-mono`}
                value={val}
                placeholder="参数值或 {{表达式}}"
                onChange={(e) => updateValueVal(key, e.target.value)}
              />
              <button
                type="button"
                onClick={() => removeValue(key)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ds-faint hover:bg-red-500/10 hover:text-red-600 transition"
              >
                <Icon.X size={13} sw={2} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── 主导出 ───────────────────────────────────────────────────────────────────

export function CodeNodeForm({ node, onChange }: Props) {
  if (node.type === "code") {
    return (
      <CodeForm
        node={node as WorkflowNode & { type: "code" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "custom") {
    return (
      <CustomForm
        node={node as WorkflowNode & { type: "custom" }}
        onChange={onChange}
      />
    );
  }
  return null;
}

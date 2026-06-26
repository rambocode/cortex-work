// ModuleManager.tsx — 自定义模块（custom 节点底层脚本）管理弹窗（U15）。
// 最简方案：modules 存于工作流内嵌数组（workflow.modules），不跨工作流共享，
// 避免引入全局注册表 IPC、复杂状态管理。
//
// 架构说明：
//   - 每个工作流有可选 modules 数组（WorkflowCustomModule[]）。
//   - custom 节点的 config.moduleId 引用对应 module.id。
//   - 执行层（node-executors/modules.ts）在运行时从 workflow.modules 加载（U15 完善后）。
//   - 本组件负责 modules 的增删改 UI，改动经 onChange 回传父组件，随「保存」写入 IPC。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import type { WorkflowCustomModule, WorkflowModuleField } from "@cortex-work/core";

// ── 类型 ──────────────────────────────────────────────────────────────────────

type Props = {
  /** 当前工作流的模块列表。 */
  modules: WorkflowCustomModule[];
  /** 变更回调（替换整个列表）。 */
  onChange: (next: WorkflowCustomModule[]) => void;
  /** 关闭弹窗。 */
  onClose: () => void;
};

// ── 常量 ──────────────────────────────────────────────────────────────────────

const CODE_LANGUAGES = [
  { value: "javascript" as const, label: "JavaScript" },
  { value: "python" as const, label: "Python" },
  { value: "bash" as const, label: "Bash" },
];

const FIELD_TYPES: Array<WorkflowModuleField["type"]> = [
  "text",
  "textarea",
  "number",
  "boolean",
  "select",
];

const FIELD_TYPE_LABELS: Record<WorkflowModuleField["type"], string> = {
  text: "单行文本",
  textarea: "多行文本",
  number: "数值",
  boolean: "布尔",
  select: "下拉选择",
};

// ── 生成新 ID（纯客户端，主进程持久化时不重用此 id 分配）──────────────────────

let moduleSeq = 0;
function newModuleId(): string {
  moduleSeq++;
  return `mod-${Date.now().toString(36)}-${moduleSeq}`;
}

// ── 空模块模板 ────────────────────────────────────────────────────────────────

function makeEmptyModule(): WorkflowCustomModule {
  return {
    id: newModuleId(),
    name: "新模块",
    description: "",
    icon: "",
    language: "javascript",
    fields: [],
    code: "// 在此编写模块代码\n// 通过 $fields 访问字段值，通过 $input 访问输入数据\n// 返回值即为节点输出的 json payload\nreturn { result: 'hello' };\n",
  };
}

// ── ModuleFieldEditor ─────────────────────────────────────────────────────────

function ModuleFieldEditor({
  fields,
  onChange,
}: {
  fields: WorkflowModuleField[];
  onChange: (next: WorkflowModuleField[]) => void;
}) {
  const inputClass =
    "w-full rounded-md border border-ds-border bg-ds-main px-2 py-1 text-[12px] text-ds-ink outline-none focus:border-accent/40";

  const updateField = (index: number, patch: Partial<WorkflowModuleField>) =>
    onChange(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)));

  const addField = () =>
    onChange([
      ...fields,
      {
        key: `field_${fields.length + 1}`,
        label: `字段 ${fields.length + 1}`,
        type: "text",
        defaultValue: "",
        options: [],
        placeholder: "",
      },
    ]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ds-faint">
          输入字段
        </span>
        <button
          type="button"
          onClick={addField}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent transition hover:bg-accent/10"
        >
          <Icon.Plus size={11} sw={2} />
          添加字段
        </button>
      </div>

      {fields.length === 0 ? (
        <p className="py-2 text-center text-[11.5px] text-ds-faint">暂无字段</p>
      ) : (
        fields.map((field, index) => (
          <div
            key={index}
            className="flex flex-col gap-1.5 rounded-lg border border-ds-border bg-ds-main px-3 py-2"
          >
            <div className="flex items-center gap-2">
              {/* key */}
              <input
                className={`${inputClass} basis-28 shrink-0 font-mono`}
                value={field.key}
                placeholder="字段名"
                onChange={(e) => updateField(index, { key: e.target.value })}
                aria-label="字段名"
              />
              {/* label */}
              <input
                className={`${inputClass} flex-1`}
                value={field.label}
                placeholder="显示标签"
                onChange={(e) => updateField(index, { label: e.target.value })}
                aria-label="显示标签"
              />
              {/* 类型 */}
              <select
                className={`${inputClass} basis-24 shrink-0`}
                value={field.type}
                onChange={(e) => updateField(index, { type: e.target.value as WorkflowModuleField["type"] })}
                aria-label="字段类型"
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {FIELD_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              {/* 删除 */}
              <button
                type="button"
                onClick={() => onChange(fields.filter((_, i) => i !== index))}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-ds-faint transition hover:bg-red-500/10 hover:text-red-600"
                aria-label="删除字段"
              >
                <Icon.X size={12} sw={2} />
              </button>
            </div>

            <div className="flex gap-2">
              {/* 默认值 */}
              <input
                className={`${inputClass} flex-1`}
                value={field.defaultValue}
                placeholder="默认值"
                onChange={(e) => updateField(index, { defaultValue: e.target.value })}
                aria-label="默认值"
              />
              {/* placeholder */}
              <input
                className={`${inputClass} flex-1`}
                value={field.placeholder}
                placeholder="占位提示"
                onChange={(e) => updateField(index, { placeholder: e.target.value })}
                aria-label="占位提示"
              />
            </div>

            {/* select 类型时显示选项配置 */}
            {field.type === "select" ? (
              <div>
                <input
                  className={inputClass}
                  value={field.options.join(",")}
                  placeholder="选项（逗号分隔，如 A,B,C）"
                  onChange={(e) =>
                    updateField(index, {
                      options: e.target.value
                        .split(",")
                        .map((o) => o.trim())
                        .filter(Boolean),
                    })
                  }
                  aria-label="选项列表"
                />
              </div>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

// ── ModuleManager ─────────────────────────────────────────────────────────────

/**
 * 工作流自定义模块管理弹窗。
 *
 * 功能：
 *   - 左侧：模块列表（点击选中）
 *   - 右侧：选中模块的编辑器（名称/语言/字段/代码）
 *   - 新建 / 删除模块
 *   - 字段管理（类型/标签/默认值/占位符/select 选项）
 *
 * custom 节点执行时，引擎从 workflow.modules 按 moduleId 查找并运行。
 */
export function ModuleManager({ modules, onChange, onClose }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(
    modules.length > 0 ? (modules[0]?.id ?? null) : null,
  );

  const selected = modules.find((m) => m.id === selectedId) ?? null;

  const updateModule = (patch: Partial<WorkflowCustomModule>) => {
    if (!selectedId) return;
    onChange(modules.map((m) => (m.id === selectedId ? { ...m, ...patch } : m)));
  };

  const addModule = () => {
    const m = makeEmptyModule();
    onChange([...modules, m]);
    setSelectedId(m.id);
  };

  const deleteModule = (id: string) => {
    const next = modules.filter((m) => m.id !== id);
    onChange(next);
    if (selectedId === id) {
      setSelectedId(next.length > 0 ? (next[0]?.id ?? null) : null);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[13px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/25";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-[800px] overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 左侧：模块列表 ────────────────────────────────────────────────── */}
        <div className="flex w-[200px] shrink-0 flex-col border-r border-ds-border">
          <div className="flex items-center justify-between border-b border-ds-border px-3 py-2.5">
            <span className="text-[13px] font-semibold text-ds-ink">模块</span>
            <button
              type="button"
              onClick={addModule}
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
              aria-label="新建模块"
              title="新建模块"
            >
              <Icon.Plus size={14} sw={2} />
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1">
            {modules.length === 0 ? (
              <p className="py-8 text-center text-[11.5px] text-ds-faint">
                暂无模块
                <br />
                点击「+」新建
              </p>
            ) : (
              modules.map((m) => (
                <div
                  key={m.id}
                  className={`group flex cursor-pointer items-center gap-2 px-3 py-2 text-[12.5px] transition ${
                    selectedId === m.id
                      ? "bg-accent/10 text-accent"
                      : "text-ds-ink hover:bg-ds-hover"
                  }`}
                  onClick={() => setSelectedId(m.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && setSelectedId(m.id)}
                >
                  <Icon.Code size={13} className="shrink-0 opacity-60" />
                  <span className="min-w-0 flex-1 truncate">{m.name || "未命名"}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteModule(m.id);
                    }}
                    className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-ds-faint transition hover:text-red-500 group-hover:inline-flex"
                    aria-label="删除模块"
                  >
                    <Icon.X size={11} sw={2} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── 右侧：模块编辑器 ────────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 标题栏 */}
          <div className="flex items-center justify-between border-b border-ds-border px-5 py-3">
            <span className="text-[14px] font-semibold text-ds-ink">
              {selected ? "编辑模块" : "自定义模块"}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
              aria-label="关闭"
            >
              <Icon.X size={16} sw={1.8} />
            </button>
          </div>

          {selected ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto gap-4 px-5 py-4">
              {/* 基本信息 */}
              <div className="flex gap-3">
                <div className="flex flex-1 flex-col gap-1">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-ds-faint">
                    模块名称
                  </label>
                  <input
                    className={inputClass}
                    value={selected.name}
                    placeholder="模块名称"
                    onChange={(e) => updateModule({ name: e.target.value })}
                  />
                </div>
                <div className="flex w-36 flex-col gap-1">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-ds-faint">
                    语言
                  </label>
                  <select
                    className={inputClass}
                    value={selected.language}
                    onChange={(e) =>
                      updateModule({ language: e.target.value as WorkflowCustomModule["language"] })
                    }
                  >
                    {CODE_LANGUAGES.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 描述 */}
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-ds-faint">
                  描述（可选）
                </label>
                <textarea
                  className={`${inputClass} min-h-[48px] resize-none`}
                  value={selected.description}
                  placeholder="模块功能说明（在 custom 节点配置面板中显示）"
                  onChange={(e) => updateModule({ description: e.target.value })}
                  rows={2}
                />
              </div>

              {/* 字段管理 */}
              <ModuleFieldEditor
                fields={selected.fields}
                onChange={(fields) => updateModule({ fields })}
              />

              {/* 代码编辑区 */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-ds-faint">
                    代码
                  </label>
                  <span className="text-[10.5px] text-ds-faint">
                    {selected.language === "javascript"
                      ? "可用：$fields, $input, $env（return 返回 payload）"
                      : selected.language === "python"
                        ? "可用：fields, input_data, env（赋值 result 返回）"
                        : "可用：env 变量已注入（stdout 为输出）"}
                  </span>
                </div>
                {/* 注意：生产中应换为代码编辑器（Monaco/CodeMirror），
                    此处用 textarea 保持最小依赖原则（对齐 U11 code 节点 textarea 方案）。 */}
                <textarea
                  className="min-h-[200px] w-full resize-none rounded-lg border border-ds-border bg-ds-main p-3 font-mono text-[12px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/25"
                  value={selected.code}
                  onChange={(e) => updateModule({ code: e.target.value })}
                  spellCheck={false}
                  placeholder={
                    selected.language === "javascript"
                      ? "// 在此编写代码\nreturn { result: 'hello' };"
                      : selected.language === "python"
                        ? "# 在此编写代码\nresult = {'result': 'hello'}"
                        : "#!/bin/bash\necho 'hello'"
                  }
                />
              </div>
            </div>
          ) : (
            // 未选中时的空态
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ds-faint">
              <Icon.Code size={28} />
              <p className="text-[13px]">
                {modules.length === 0 ? "点击「+」新建第一个模块" : "从左侧选择一个模块进行编辑"}
              </p>
            </div>
          )}

          {/* 底部操作栏 */}
          <footer className="flex items-center justify-end border-t border-ds-border px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-4 text-[13px] font-medium text-white transition hover:opacity-90"
            >
              完成
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

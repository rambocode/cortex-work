// EnvVarEditor.tsx — 工作流环境变量编辑弹窗（独立可复用组件）。
// 在节点中使用 {{$env.key}} 引用；secret 类型值掩码显示，编辑时清空让用户重填。
// 被 WorkflowEditorView 顶部「环境变量」按钮调用。
//
// 注意：WorkflowEditorView 内已有内联版 EnvVarsModal，本文件为独立可复用版，
// 可供未来其它视图（如 workflow 详情页）复用。两者行为保持一致。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import type { WorkflowEnvVar } from "@cortex-work/core";

// ── 类型 ──────────────────────────────────────────────────────────────────────

type Props = {
  /** 当前环境变量列表。 */
  env: WorkflowEnvVar[];
  /** 变更回调（替换整个列表）。 */
  onChange: (next: WorkflowEnvVar[]) => void;
  /** 关闭弹窗。 */
  onClose: () => void;
};

// ── 常量 ──────────────────────────────────────────────────────────────────────

const ENV_VAR_TYPES: Array<NonNullable<WorkflowEnvVar["type"]>> = [
  "string",
  "number",
  "boolean",
  "secret",
];

const ENV_TYPE_LABELS: Record<string, string> = {
  string: "文本",
  number: "数值",
  boolean: "布尔",
  secret: "密钥",
};

// ── EnvVarEditor ──────────────────────────────────────────────────────────────

/**
 * 环境变量编辑弹窗。
 *
 * secret 值特殊处理：
 *   - 显示时用 type="password" 掩码（••••）
 *   - 编辑时不主动清空（用户输入新值覆盖，或直接保留原值）
 *   - DSL 导出时由 exportWorkflowDsl 将 secret value 置空（U15 dsl.ts）
 *
 * 安全注意：secret 值明文存于 workflows.json（本机信任模型，与其它配置一致）；
 *   不引入 keychain 以保持最小改动原则。跨机迁移时 DSL 导出已脱敏。
 */
export function EnvVarEditor({ env, onChange, onClose }: Props) {
  // 追踪哪些 secret 条目正在显示明文（toggle）
  const [visibleSecrets, setVisibleSecrets] = useState<Set<number>>(new Set());

  const inputClass =
    "w-full rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[13px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/25";

  const update = (index: number, patch: Partial<WorkflowEnvVar>) =>
    onChange(env.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));

  const toggleSecretVisible = (index: number) => {
    setVisibleSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const addVar = () =>
    onChange([...env, { key: `KEY_${env.length + 1}`, value: "", type: "string" }]);

  const removeVar = (index: number) => onChange(env.filter((_, i) => i !== index));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[580px] flex-col overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <header className="flex items-center justify-between border-b border-ds-border px-5 py-3.5">
          <div className="flex flex-col">
            <span className="text-[14px] font-semibold text-ds-ink">环境变量</span>
            <span className="text-[11.5px] text-ds-faint">
              在节点中使用 {"{{$env.key}}"} 引用；密钥类型导出时自动脱敏
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
            aria-label="关闭"
          >
            <Icon.X size={16} sw={1.8} />
          </button>
        </header>

        {/* 变量列表 */}
        <div className="flex flex-col gap-2 overflow-y-auto px-5 py-4">
          {env.length === 0 ? (
            <p className="py-6 text-center text-[12.5px] text-ds-faint">
              暂无环境变量，点击下方「添加变量」开始
            </p>
          ) : (
            env.map((item, index) => {
              const isSecret = item.type === "secret";
              const showPlainText = visibleSecrets.has(index);
              return (
                <div key={index} className="flex items-center gap-2">
                  {/* 变量名 */}
                  <input
                    className={`${inputClass} basis-36 shrink-0 font-mono`}
                    value={item.key}
                    placeholder="变量名"
                    onChange={(e) => update(index, { key: e.target.value })}
                    aria-label="变量名"
                  />

                  {/* 类型选择 */}
                  <select
                    className={`${inputClass} basis-20 shrink-0`}
                    value={item.type ?? "string"}
                    onChange={(e) => {
                      const newType = e.target.value as WorkflowEnvVar["type"];
                      // 从 secret 切换到其它类型时清空值（避免明文意外暴露）
                      update(index, {
                        type: newType,
                        ...(isSecret && newType !== "secret" ? { value: "" } : {}),
                      });
                    }}
                    aria-label="变量类型"
                  >
                    {ENV_VAR_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {ENV_TYPE_LABELS[t] ?? t}
                      </option>
                    ))}
                  </select>

                  {/* 值输入（secret 类型带显示/隐藏 toggle）*/}
                  <div className="relative flex min-w-0 flex-1 items-center">
                    <input
                      className={`${inputClass} pr-8`}
                      type={isSecret && !showPlainText ? "password" : "text"}
                      value={item.value}
                      placeholder={isSecret ? "••••（留空则保留原值）" : "值"}
                      onChange={(e) => update(index, { value: e.target.value })}
                      aria-label="变量值"
                    />
                    {/* secret 类型：显示/隐藏切换按钮 */}
                    {isSecret ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() => toggleSecretVisible(index)}
                        className="absolute right-1.5 inline-flex h-6 w-6 items-center justify-center rounded text-ds-faint transition hover:text-ds-ink"
                        aria-label={showPlainText ? "隐藏密钥值" : "显示密钥值"}
                        title={showPlainText ? "隐藏密钥值" : "显示密钥值"}
                      >
                        {showPlainText ? (
                          <Icon.Eye size={13} sw={1.8} />
                        ) : (
                          <Icon.EyeOff size={13} sw={1.8} />
                        )}
                      </button>
                    ) : null}
                  </div>

                  {/* 删除按钮 */}
                  <button
                    type="button"
                    onClick={() => removeVar(index)}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ds-faint transition hover:bg-red-500/10 hover:text-red-600"
                    aria-label="删除变量"
                  >
                    <Icon.X size={14} sw={2} />
                  </button>
                </div>
              );
            })
          )}

          {/* 添加变量按钮 */}
          <button
            type="button"
            onClick={addVar}
            className="mt-1 inline-flex items-center gap-1.5 self-start rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-accent transition hover:bg-accent/10"
          >
            <Icon.Plus size={14} sw={2} />
            添加变量
          </button>
        </div>

        {/* 底部确认栏 */}
        <footer className="flex items-center justify-between border-t border-ds-border px-5 py-3">
          <span className="text-[11.5px] text-ds-faint">
            {env.length > 0 ? `已配置 ${env.length} 个变量` : ""}
          </span>
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
  );
}

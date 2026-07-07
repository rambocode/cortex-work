// 写作「快捷指令」编辑器(设置节内,对齐 Kun selectionAssist.quickActions 的编辑交互):
//   - 内置指令:可覆盖 label/prompt(留空用内置默认)、可禁用(不可删)、mode 只读(固定);
//   - 自定义指令:label/prompt/mode 可编;可删;≤12 条,达上限禁用「添加」。
// 整表写入 spaces store 的 setQuickActions(内部归一化);渲染的 placeholder 用内置默认文案。
import { usePersonalStore } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import {
  WRITING_QUICK_ACTION_MAX_CUSTOM,
  builtinQuickActionText,
  countCustomQuickActions,
  defaultWritingQuickActions,
  isBuiltinQuickAction,
  newCustomQuickActionId,
  type WritingQuickAction,
  type WritingQuickActionMode,
} from "@cortex-work/core/writing/quick-actions";
import { Icon } from "@cortex-work/ui/icons";

import { SettingCard } from "./settingsControls";

export function WritingQuickActionsEditor() {
  const { t } = useTranslation("settings");
  const actions = useWritingSpacesStore((s) => s.quickActions);
  const setQuickActions = useWritingSpacesStore((s) => s.setQuickActions);
  // 读一下 personalStore 保证组件挂载在 CoreProvider 下(与其它设置节一致的调用面)。
  usePersonalStore((s) => s.hydrated);

  const atCap = countCustomQuickActions(actions) >= WRITING_QUICK_ACTION_MAX_CUSTOM;

  const update = (id: string, patch: Partial<WritingQuickAction>): void =>
    setQuickActions(actions.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const remove = (id: string): void => setQuickActions(actions.filter((a) => a.id !== id));
  const addCustom = (): void => {
    if (atCap) return;
    setQuickActions([
      ...actions,
      { id: newCustomQuickActionId(), label: "", prompt: "", mode: "chat", enabled: true },
    ]);
  };
  const reset = (): void => setQuickActions(defaultWritingQuickActions());

  return (
    <SettingCard title={t("writing.quickActionsCard")}>
      <div className="pw-srow-desc">{t("writing.quickActionsDesc")}</div>

      <div className="pw-wqa-list">
        {actions.map((a) => {
          const builtin = isBuiltinQuickAction(a.id);
          const def = builtin ? builtinQuickActionText(a.id) : null;
          const modeText =
            a.mode === "edit" ? t("writing.quickActionsModeEdit") : t("writing.quickActionsModeChat");
          return (
            <div
              key={a.id}
              className="pw-wqa-row"
              data-off={builtin && !a.enabled ? "1" : undefined}
            >
              <div className="pw-wqa-head">
                <input
                  className="pw-set-input pw-wqa-label"
                  value={a.label}
                  placeholder={def?.label ?? t("writing.quickActionsLabelPlaceholder")}
                  spellCheck={false}
                  onChange={(e) => update(a.id, { label: e.target.value })}
                />
                {builtin ? (
                  <>
                    <span className="pw-wqa-tag">{modeText}</span>
                    <span className="pw-wqa-tag is-builtin">{t("writing.quickActionsBuiltin")}</span>
                    {/* 内置可禁用不可删:开关切 enabled */}
                    <button
                      type="button"
                      className="twk-toggle"
                      role="switch"
                      data-on={a.enabled ? "1" : "0"}
                      aria-checked={a.enabled}
                      aria-label={def?.label ?? a.id}
                      onClick={() => update(a.id, { enabled: !a.enabled })}
                    >
                      <i />
                    </button>
                  </>
                ) : (
                  <>
                    <select
                      className="pw-set-input pw-wqa-mode"
                      aria-label={t("writing.quickActionsModeLabel")}
                      value={a.mode}
                      onChange={(e) =>
                        update(a.id, { mode: e.target.value as WritingQuickActionMode })
                      }
                    >
                      <option value="chat">{t("writing.quickActionsModeChat")}</option>
                      <option value="edit">{t("writing.quickActionsModeEdit")}</option>
                    </select>
                    <button
                      type="button"
                      className="pw-icon-btn"
                      title={t("writing.quickActionsDelete")}
                      aria-label={t("writing.quickActionsDelete")}
                      onClick={() => remove(a.id)}
                    >
                      <Icon.Trash size={14} />
                    </button>
                  </>
                )}
              </div>
              <textarea
                className="pw-set-input pw-wqa-prompt"
                rows={2}
                value={a.prompt}
                placeholder={def?.prompt ?? t("writing.quickActionsPromptPlaceholder")}
                spellCheck={false}
                onChange={(e) => update(a.id, { prompt: e.target.value })}
              />
            </div>
          );
        })}
      </div>

      <div className="pw-wqa-foot">
        <button type="button" className="pw-ftb-btn" disabled={atCap} onClick={addCustom}>
          <Icon.Plus size={13} />
          {t("writing.quickActionsAdd")}
        </button>
        <button type="button" className="pw-ftb-btn" onClick={reset}>
          {t("writing.quickActionsReset")}
        </button>
        {atCap ? <span className="pw-srow-desc">{t("writing.quickActionsCap")}</span> : null}
      </div>
    </SettingCard>
  );
}

// Kun chat/FloatingComposer(2596 行)的最小替身：只保留「输入 + 发送 / 停止」核心闭环，
// 让设计工作台的对话回路先能用。模型选择/附件/上下文 chip 等富功能按计划(批5+)
// 逐步换成 cortex 的 ComposerShell 正式接线,本组件届时整体退役。
// Props 用「显式核心字段 + 开放索引」:Kun 调用点传的 30+ 个 props 不必逐一声明。
import { useTranslation } from "react-i18next";
import type { DesignComposerContext } from "@cortex-work/core/design/design-composer-context";

export type { DesignComposerContext };

type FloatingComposerProps = {
  input: string;
  setInput: (value: string) => void;
  busy?: boolean;
  onSend?: () => void;
  onInterrupt?: () => void;
} & Record<string, unknown>;

export function FloatingComposer(props: FloatingComposerProps) {
  const { t } = useTranslation("design");
  const { input, setInput, busy, onSend, onInterrupt } = props;
  const canSend = !busy && input.trim().length > 0;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-black/10 bg-white/70 p-2 dark:border-white/10 dark:bg-black/20">
      <textarea
        className="min-h-[72px] w-full resize-none bg-transparent px-1 py-0.5 text-sm outline-hidden"
        value={input}
        placeholder={t("composerPlaceholder", { defaultValue: "描述你的设计需求…" })}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          // Enter 发送、Shift+Enter 换行（与个人工作区 composer 习惯一致）。
          if (e.key === "Enter" && !e.shiftKey && canSend) {
            e.preventDefault();
            onSend?.();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        {busy ? (
          <button
            type="button"
            className="rounded-md border border-black/10 px-3 py-1 text-xs dark:border-white/15"
            onClick={() => onInterrupt?.()}
          >
            {t("composerStop", { defaultValue: "停止" })}
          </button>
        ) : (
          <button
            type="button"
            className="rounded-md bg-black px-3 py-1 text-xs text-white disabled:opacity-40 dark:bg-white dark:text-black"
            disabled={!canSend}
            onClick={() => onSend?.()}
          >
            {t("composerSend", { defaultValue: "发送" })}
          </button>
        )}
      </div>
    </div>
  );
}

// 紧凑版连接测试控件：供应商平铺页的行/卡片内复用（API Key 行、云平台行、订阅卡、自定义行）。
//
// 红线不变（继承自旧 ProviderDetailPanel 的 ConnectionTest）：**调用前必须过一道费用确认**——
// 测试是一次真实的模型请求，确认前一次调用都不能发出去。确认框以小型浮层挂在按钮下方，
// 以便嵌进单行布局而不撑破行高。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { useDesktopBridge } from "@cortex-work/core";
import type { ProviderConnectionTestResult } from "@cortex-work/core/desktop/provider-catalog";

type TestState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "running" }
  | { kind: "done"; result: ProviderConnectionTestResult };

export function ProviderTestControl({
  providerId,
  /** 用于测试与费用提示的模型（通常取该 Provider 的第一个模型）。 */
  modelId,
}: {
  providerId: string;
  modelId: string;
}) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const [state, setState] = useState<TestState>({ kind: "idle" });

  const runTest = async () => {
    setState({ kind: "running" });
    const res =
      (await bridge?.providerConnectionTest?.(providerId, modelId || undefined)) ??
      ({ ok: false, error: "unsupported" } satisfies ProviderConnectionTestResult);
    setState({ kind: "done", result: res });
  };

  return (
    <span className="pw-pip-test">
      {state.kind === "done" ? (
        <span className={`pw-pip-test-result ${state.result.ok ? "is-ok" : "is-error"}`}>
          {state.result.ok
            ? t("providers.connectionTestOk", {
                model: state.result.modelId ?? modelId,
                latency: state.result.latencyMs ?? 0,
              })
            : t("providers.connectionTestFailed", { error: state.result.error ?? "" })}
        </span>
      ) : null}
      <button
        type="button"
        className="pw-pip-testbtn"
        disabled={!bridge?.providerConnectionTest || state.kind === "running"}
        onClick={() => setState(state.kind === "confirming" ? { kind: "idle" } : { kind: "confirming" })}
      >
        <Icon.Lightning size={11} />
        {state.kind === "running" ? t("providers.connectionTesting") : t("providers.inline.test")}
      </button>
      {state.kind === "confirming" ? (
        <span className="pw-pip-test-pop pw-prov-alert is-warn" role="alertdialog" aria-label={t("providers.connectionTestCostTitle")}>
          <strong>{t("providers.connectionTestCostTitle")}</strong>
          <span>{t("providers.connectionTestCostBody", { model: modelId })}</span>
          <span className="pw-mode-block-actions">
            <button type="button" className="pw-mode-block-btn primary" autoFocus onClick={() => void runTest()}>
              {t("providers.connectionTestConfirm")}
            </button>
            <button type="button" className="pw-mode-block-btn" onClick={() => setState({ kind: "idle" })}>
              {t("providers.connectionTestCancel")}
            </button>
          </span>
        </span>
      ) : null}
    </span>
  );
}

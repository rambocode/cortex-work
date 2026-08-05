// 紧凑版连接测试控件：供应商平铺页的行/卡片内复用（API Key 行、云平台行、订阅卡、网关行）。
//
// 红线不变（继承自旧 ProviderDetailPanel 的 ConnectionTest）：**调用前必须过一道费用确认**——
// 测试是一次真实的模型请求，确认前一次调用都不能发出去。
//
// 本文件只管「按钮 + 状态机 + traceId」，面板长什么样在 ProviderTestPanel。
// 行内刻意只留一个**短** chip（正常 / 失败 + 耗时）：完整结果与过程都在面板里，
// 行内长文案曾被 max-width 截成「连接正常 · deepseek-v4-flash · 2…」，等于没显示。

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { useDesktopBridge } from "@cortex-work/core";
import type {
  ProviderConnectionTestResult,
  ProviderConnectionTestStep,
} from "@cortex-work/core/desktop/provider-catalog";
import { ProviderTestPanel, type ProviderTestParams } from "./ProviderTestPanel";

type TestState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "running" }
  | { kind: "done"; result: ProviderConnectionTestResult };

/** 每次测试的独立 id：主进程原样回带，多行同时测试时各面板只认自己的事件。 */
let traceSeq = 0;

export function ProviderTestControl({
  providerId,
  /** 用于测试与费用提示的模型（通常取该 Provider 的第一个模型）。 */
  modelId,
  /** 面板参数区要展示的上下文（端点 / 凭据来源等）。缺省时面板只是少显示几行，不报错。 */
  context,
}: {
  providerId: string;
  modelId: string;
  context?: Omit<ProviderTestParams, "providerId" | "modelId">;
}) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const [state, setState] = useState<TestState>({ kind: "idle" });
  const [steps, setSteps] = useState<ProviderConnectionTestStep[]>([]);
  const anchorRef = useRef<HTMLSpanElement>(null);
  // 当前这次测试的 traceId。放 ref 而不是 state：事件回调要读它的最新值，
  // 而事件订阅只在挂载时建一次，闭包捕获 state 会永远读到旧值。
  const traceRef = useRef<string>("");

  // 订阅主进程的实时步骤流。按 traceId 过滤是**本组件的责任**（通道是全局广播）：
  // 不过滤的话，A 行的步骤会画进 B 行的面板。
  useEffect(() => {
    if (!bridge?.onProviderConnectionTestEvent) return;
    return bridge.onProviderConnectionTestEvent((event) => {
      if (!traceRef.current || event.traceId !== traceRef.current) return;
      setSteps((prev) => {
        // 同一步的 running → ok/error 是**更新同一行**而不是追加两行。
        const at = prev.findIndex((s) => s.id === event.step.id);
        if (at === -1) return [...prev, event.step];
        const next = [...prev];
        next[at] = event.step;
        return next;
      });
    });
  }, [bridge]);

  const runTest = async () => {
    const traceId = `test-${++traceSeq}`;
    traceRef.current = traceId;
    setSteps([]);
    setState({ kind: "running" });
    const res =
      (await bridge?.providerConnectionTest?.(providerId, modelId || undefined, traceId)) ??
      ({ ok: false, error: "unsupported" } satisfies ProviderConnectionTestResult);
    // 返回值里的 steps 是兜底：订阅晚了或事件丢了也能拿到完整轨迹（见主进程 handler 注释）。
    if (res.steps?.length) setSteps(res.steps);
    setState({ kind: "done", result: res });
  };

  // 稳定引用：面板拿它挂 ESC / 点外部监听，每次渲染换新函数会导致监听反复重建。
  const close = useCallback(() => {
    traceRef.current = "";
    setState({ kind: "idle" });
  }, []);

  return (
    <span className="pw-pip-test" ref={anchorRef}>
      {state.kind === "done" ? (
        <span className={`pw-pip-test-result ${state.result.ok ? "is-ok" : "is-error"}`}>
          {state.result.ok
            ? t("providers.connectionTestChipOk", { latency: state.result.latencyMs ?? 0 })
            : t("providers.connectionTestChipFailed")}
        </span>
      ) : null}
      <button
        type="button"
        className="pw-pip-testbtn"
        disabled={!bridge?.providerConnectionTest || state.kind === "running"}
        aria-expanded={state.kind !== "idle"}
        onClick={() => (state.kind === "idle" ? setState({ kind: "confirming" }) : close())}
      >
        <Icon.Lightning size={11} />
        {state.kind === "running" ? t("providers.connectionTesting") : t("providers.inline.test")}
      </button>
      {state.kind !== "idle" ? (
        <ProviderTestPanel
          anchorRef={anchorRef}
          params={{ ...context, providerId, modelId }}
          phase={state.kind}
          steps={steps}
          result={state.kind === "done" ? state.result : undefined}
          onConfirm={() => void runTest()}
          onCancel={close}
          onRetry={() => void runTest()}
          onClose={close}
        />
      ) : null}
    </span>
  );
}

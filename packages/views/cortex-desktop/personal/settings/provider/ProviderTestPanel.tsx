// 连接测试面板：确认费用 → 实时过程 → 结果诊断，全在同一个锚定浮层里完成。
//
// 为什么 portal 到 body：面板的旧形态是行内 `position: absolute` 浮层，被设置弹窗的
// `.pw-dlg-body`（overflow-y: auto）整块裁掉，且 280px 宽度从窄按钮向左溢出到卡片外。
// 换成 portal + fixed（见 useAnchoredLayer）后既不被祖先裁剪，又能跟着按钮滚动。
//
// 为什么把「过程」摊开给用户看：连接测试此前是黑盒——失败只回一句 error，用户看不出请求
// 到底发去了哪个端点、用的哪份凭据、卡在哪一步。首测还要懒加载 pi-ai 的纯 ESM 运行时
//（可能好几秒），期间界面只有「测试中…」，像死了一样。步骤流由主进程实时推来（见
// pi-runtime.probe 的五步埋点），这里只负责渲染。
//
// 脱敏红线：面板与「复制诊断信息」都**只展示凭据来源标签**（系统密钥库 / 环境变量名 / OAuth），
// 明文 Key 既不过桥也不进这里——步骤 detail 由主进程侧 safeErrorMessage 兜底。

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import type {
  ProviderConnectionTestResult,
  ProviderConnectionTestStep,
} from "@cortex-work/core/desktop/provider-catalog";
import { useAnchoredLayer } from "../../shared/useAnchoredLayer";

/** 测试将要使用的参数。全部由行组件从已有的 catalog / auth 状态算出，无需额外查询。 */
export interface ProviderTestParams {
  providerId: string;
  providerName?: string;
  modelId: string;
  /** Catalog 里的官方端点。 */
  baseUrl?: string;
  /** provider-prefs.json 里的覆盖；有值时它才是真实生效的端点。 */
  baseUrlOverride?: string;
  /** 凭据来源标签（如 "DEEPSEEK_API_KEY" / "系统密钥库" / "OAuth"）。 */
  authSource?: string;
  authType?: string;
}

/** 步骤在面板里的固定展示顺序；主进程未推到的步骤不占位（避免一排灰条误导「还有很多没跑」）。 */
const STEP_ORDER = ["runtime", "resolve", "auth", "request", "response"];

export function ProviderTestPanel({
  anchorRef,
  params,
  phase,
  steps,
  result,
  onConfirm,
  onCancel,
  onRetry,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  params: ProviderTestParams;
  phase: "confirming" | "running" | "done";
  steps: ProviderConnectionTestStep[];
  result?: ProviderConnectionTestResult;
  onConfirm: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const place = useAnchoredLayer(true, anchorRef);
  const [copied, setCopied] = useState(false);

  // ESC / 点外部关闭（对齐同页 ModelsPopover 的浮层习惯）。关闭只是收起面板，
  // 已发出的测试请求不受影响——它在主进程里跑完，重开面板能从返回值里拿回完整轨迹。
  // 判定必须同时排除锚点：点「测试」按钮本身走它自己的 toggle，否则会「关一次又开一次」。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (place.ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose, place.ref]);

  const endpoint = params.baseUrlOverride || params.baseUrl || "";
  const endpointKind = params.baseUrlOverride
    ? t("providers.connectionTestEndpointOverride")
    : t("providers.connectionTestEndpointOfficial");
  const credential =
    [params.authType, params.authSource].filter(Boolean).join(" · ") || t("providers.connectionTestCredentialNone");

  // 按固定顺序排；主进程一步一步推来时列表只增不跳，用户视线不会被重排打断。
  const ordered = useMemo(() => {
    const rank = (s: ProviderConnectionTestStep) => {
      const i = STEP_ORDER.indexOf(s.id);
      return i === -1 ? STEP_ORDER.length : i;
    };
    return [...steps].sort((a, b) => rank(a) - rank(b));
  }, [steps]);

  const copyDiagnostics = () => {
    void navigator.clipboard
      ?.writeText(buildDiagnostics({ params, endpoint, endpointKind, credential, steps: ordered, result }))
      .then(() => setCopied(true))
      .catch(() => {});
  };

  return createPortal(
    <div
      ref={place.ref}
      style={place.style}
      className={`pw-pip-testpanel${place.flipUp ? " is-up" : ""}`}
      role="dialog"
      aria-label={t("providers.connectionTest")}
    >
      <div className="pw-pip-testpanel-h">
        <Icon.Lightning size={12} />
        <span className="pw-pip-testpanel-t">
          {params.providerName ? `${t("providers.connectionTest")} · ${params.providerName}` : t("providers.connectionTest")}
        </span>
        <button type="button" className="pw-pip-iconbtn" aria-label={t("providers.connectionTestClose")} onClick={onClose}>
          <Icon.X size={12} />
        </button>
      </div>

      {/* 参数区常驻：确认前是「将要用什么」，跑完是「刚才用了什么」——排查时两者同样重要。 */}
      <dl className="pw-pip-testparams">
        <ParamRow label={t("providers.connectionTestParamModel")} value={params.modelId || "—"} mono />
        <ParamRow label={t("providers.connectionTestParamEndpoint")} value={endpoint || "—"} hint={endpointKind} mono />
        <ParamRow label={t("providers.connectionTestParamCredential")} value={credential} />
        <ParamRow label={t("providers.connectionTestParamLimit")} value={t("providers.connectionTestLimitValue")} />
      </dl>

      {phase === "confirming" ? (
        <>
          <div className="pw-prov-alert is-warn pw-pip-testwarn">
            <strong>{t("providers.connectionTestCostTitle")}</strong>
            <span>{t("providers.connectionTestCostBody", { model: params.modelId })}</span>
          </div>
          <div className="pw-mode-block-actions">
            <button type="button" className="pw-mode-block-btn primary" autoFocus onClick={onConfirm}>
              {t("providers.connectionTestConfirm")}
            </button>
            <button type="button" className="pw-mode-block-btn" onClick={onCancel}>
              {t("providers.connectionTestCancel")}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="pw-pip-testpanel-sub">{t("providers.connectionTestStepsTitle")}</div>
          <ol className="pw-pip-teststeps">
            {ordered.map((step) => (
              <li key={step.id} className={`pw-pip-teststep is-${step.state}`}>
                <span className="pw-pip-teststep-icon">
                  {step.state === "ok" ? <Icon.Check size={11} /> : null}
                  {step.state === "error" ? <Icon.X size={11} /> : null}
                  {step.state === "running" ? <span className="pw-pip-teststep-spin" /> : null}
                </span>
                <span className="pw-pip-teststep-body">
                  <span className="pw-pip-teststep-name">
                    {t(`providers.connectionTestStep.${step.id}`, { defaultValue: step.id })}
                    {typeof step.ms === "number" ? <em>{formatMs(step.ms)}</em> : null}
                  </span>
                  {step.detail ? <span className="pw-pip-teststep-detail">{step.detail}</span> : null}
                </span>
              </li>
            ))}
            {ordered.length === 0 ? (
              <li className="pw-pip-teststep is-running">
                <span className="pw-pip-teststep-icon">
                  <span className="pw-pip-teststep-spin" />
                </span>
                <span className="pw-pip-teststep-body">
                  <span className="pw-pip-teststep-name">{t("providers.connectionTesting")}</span>
                </span>
              </li>
            ) : null}
          </ol>

          {phase === "done" && result ? (
            <div className={`pw-pip-testverdict ${result.ok ? "is-ok" : "is-error"}`} role="status">
              {result.ok
                ? t("providers.connectionTestOk", { model: result.modelId ?? params.modelId, latency: result.latencyMs ?? 0 })
                : t("providers.connectionTestFailed", { error: result.error ?? "" })}
            </div>
          ) : null}

          {phase === "done" ? (
            <div className="pw-mode-block-actions">
              <button type="button" className="pw-mode-block-btn" onClick={onRetry}>
                {t("providers.connectionTestRetry")}
              </button>
              <button type="button" className="pw-mode-block-btn" onClick={copyDiagnostics}>
                {copied ? t("providers.connectionTestCopied") : t("providers.connectionTestCopy")}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>,
    document.body,
  );
}

/** 参数区的一行：左标签右值，值过长时截断并挂 title（端点常常很长）。 */
function ParamRow({ label, value, hint, mono }: { label: string; value: string; hint?: string; mono?: boolean }) {
  return (
    <div className="pw-pip-testparam">
      <dt>{label}</dt>
      <dd className={mono ? "pw-pip-mono" : undefined} title={value}>
        {value}
        {hint ? <span className="pw-pip-testparam-hint">{hint}</span> : null}
      </dd>
    </div>
  );
}

/** 毫秒的紧凑写法：1s 以内保留 ms，超过转成一位小数的秒。 */
function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 「复制诊断信息」的纯文本。刻意做成可直接贴进 issue 的形态：参数在前、步骤在后、结论收尾。
 * 只序列化面板上已有的内容——不额外去取任何东西，杜绝把明文凭据带进剪贴板。
 */
function buildDiagnostics({
  params,
  endpoint,
  endpointKind,
  credential,
  steps,
  result,
}: {
  params: ProviderTestParams;
  endpoint: string;
  endpointKind: string;
  credential: string;
  steps: ProviderConnectionTestStep[];
  result?: ProviderConnectionTestResult;
}): string {
  const lines = [
    `# 连接测试 · ${params.providerName ?? params.providerId}`,
    `provider: ${params.providerId}`,
    `model:    ${params.modelId || "(默认首个模型)"}`,
    `endpoint: ${endpoint || "(未知)"} (${endpointKind})`,
    `auth:     ${credential}`,
    "",
    "## 过程",
    ...steps.map((s) => {
      const mark = s.state === "ok" ? "✓" : s.state === "error" ? "✗" : "…";
      const ms = typeof s.ms === "number" ? ` ${formatMs(s.ms)}` : "";
      return `${mark} ${s.id}${ms}${s.detail ? ` — ${s.detail}` : ""}`;
    }),
  ];
  if (result) {
    lines.push("", "## 结论", result.ok ? `成功 · ${result.latencyMs ?? 0}ms` : `失败 · ${result.error ?? ""}`);
  }
  return lines.join("\n");
}

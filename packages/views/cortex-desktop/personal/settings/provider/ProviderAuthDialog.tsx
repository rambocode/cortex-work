// Provider 登录的**通用**交互对话框（计划 §4.2）。
//
// 为什么是一个对话框吃下所有 Provider：pi 的 `AuthInteraction` 已经把登录流程抽象成
// prompt(text/secret/select/manual_code) + notify(info/warn/error/progress) 两个原语，
// 每个 Provider 的差异只体现在「问什么」，不体现在「怎么问」。为单个 Provider 写专属页面
// 意味着每接一个新 Provider 就要改一次 UI，而 Provider 目录是随 pi 版本增长的。
//
// 覆盖的形态：
//   select      → 登录方式选择（浏览器 / 设备码 / …）
//   authUrl     → 打开浏览器（附带在对话框里，用户随时可重开）
//   deviceCode  → 设备码，可一键复制
//   manual_code → 粘贴浏览器回调里的授权码
//   text/secret → 任意文本 / 密钥输入（secret 走 password 输入框）
//   notify      → 进度与提示（含 0–1 进度条）
//   取消 / 重试 / 完成 / 失败
//
// 无障碍：对话框打开即把焦点交给当前输入控件，Enter 提交、Esc 取消，全程可纯键盘完成。

import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { useDesktopBridge } from "@cortex-work/core";
import type { AuthNotice, AuthPrompt, ProviderAuthEvent } from "@cortex-work/core/desktop/provider-catalog";
import { useProviderAuthActions } from "./useProviderData";

type Phase = "running" | "done" | "error";

export function ProviderAuthDialog({
  providerId,
  providerName,
  onClose,
}: {
  providerId: string;
  providerName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const { invalidate } = useProviderAuthActions();
  const [prompt, setPrompt] = useState<AuthPrompt | undefined>();
  const [notice, setNotice] = useState<AuthNotice | undefined>();
  const [phase, setPhase] = useState<Phase>("running");
  const [error, setError] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const supported = !!bridge?.providerAuthLogin && !!bridge?.onProviderAuthEvent;

  // 订阅必须**先于** login 建立：主进程可能在 login 的 Promise resolve 之前就推第一条 prompt，
  // 晚订阅会丢掉它，用户看到一个永远停在「等待中」的空对话框。
  useEffect(() => {
    if (!supported) return;
    const off = bridge!.onProviderAuthEvent!((ev: ProviderAuthEvent) => {
      if (ev.providerId !== providerId) return; // 并发登录别的 Provider 时不串台
      if (ev.type === "prompt") {
        setPrompt(ev.prompt);
        setInput("");
      } else if (ev.type === "notify") {
        setNotice(ev.notice);
      } else if (ev.type === "done") {
        setPrompt(undefined);
        setPhase("done");
        invalidate();
      } else {
        setPrompt(undefined);
        setPhase("error");
        setError(ev.message);
      }
    });
    void bridge!.providerAuthLogin!(providerId).then((r) => {
      // login 自身的失败（如该 Provider 无 OAuth 钩子）也要落到 error 态，
      // 否则事件流不来、对话框就一直空转。
      if (!r?.ok) {
        setPhase("error");
        setError(r?.error ?? "login failed");
      }
    });
    return off;
    // providerId 变化即重开一轮登录；其余依赖故意省略以免重复触发登录。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, supported]);

  // 每来一个新 prompt 就把焦点交给对应控件（键盘用户不必 Tab 找输入框）。
  useEffect(() => {
    if (prompt) inputRef.current?.focus();
  }, [prompt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      void cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const cancel = async () => {
    await bridge?.providerAuthCancel?.(providerId);
    onClose();
  };

  const respond = async (value: string) => {
    if (!prompt) return;
    const p = prompt;
    setPrompt(undefined); // 立即收起，避免重复提交同一个 requestId
    const r = await bridge?.providerAuthRespond?.(p.requestId, value);
    if (r && !r.ok) {
      setPhase("error");
      setError(r.error);
    }
  };

  const retry = () => {
    setPhase("running");
    setError(undefined);
    setNotice(undefined);
    void bridge?.providerAuthLogin?.(providerId).then((r) => {
      if (!r?.ok) {
        setPhase("error");
        setError(r?.error ?? "login failed");
      }
    });
  };

  return (
    <div className="pw-prov-modal-mask" onClick={() => void cancel()}>
      <div
        className="pw-prov-modal is-auth"
        role="dialog"
        aria-modal="true"
        aria-label={t("providers.auth.title", { provider: providerName })}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pw-prov-modal-head">
          <span className="pw-prov-modal-title">{t("providers.auth.title", { provider: providerName })}</span>
          <button className="pw-prov-modal-close" aria-label={t("providers.auth.close")} onClick={() => void cancel()}>
            <Icon.X size={15} />
          </button>
        </div>
        <div className="pw-prov-modal-body pw-auth-body">
          {!supported ? <div className="pw-prov-alert is-error">{t("providers.auth.unavailable")}</div> : null}

          {notice ? (
            <div className={`pw-prov-alert ${notice.level === "error" ? "is-error" : notice.level === "warn" ? "is-warn" : ""}`}>
              {notice.message}
              {typeof notice.progress === "number" ? (
                <progress className="pw-auth-progress" value={notice.progress} max={1} />
              ) : null}
            </div>
          ) : null}

          {/* 授权地址与设备码在整轮登录中持续可见：用户误关浏览器标签后不用重来一遍。 */}
          {prompt?.authUrl ? (
            <div className="pw-auth-block">
              <div className="pw-set-hint">{t("providers.auth.authUrlHint")}</div>
              <a className="pw-mode-block-btn primary" href={prompt.authUrl} target="_blank" rel="noreferrer">
                <Icon.Globe size={13} /> {t("providers.auth.openBrowser")}
              </a>
            </div>
          ) : null}

          {prompt?.deviceCode ? (
            <div className="pw-auth-block">
              <div className="pw-set-hint">{t("providers.auth.deviceCodeHint")}</div>
              <div className="pw-auth-device">
                <code>{prompt.deviceCode}</code>
                <button
                  type="button"
                  className="pw-mode-block-btn"
                  onClick={() => {
                    void navigator.clipboard?.writeText(prompt.deviceCode!);
                    setCopied(true);
                  }}
                >
                  <Icon.Copy size={12} /> {copied ? t("providers.auth.copied") : t("providers.auth.copy")}
                </button>
              </div>
            </div>
          ) : null}

          {prompt?.kind === "select" ? (
            <div className="pw-auth-block" role="group" aria-label={prompt.label}>
              <div className="pw-set-lbl">{prompt.label}</div>
              {(prompt.options ?? []).map((o, i) => (
                <button
                  key={o.value}
                  type="button"
                  className="pw-mode-block-btn"
                  autoFocus={i === 0}
                  onClick={() => void respond(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ) : null}

          {prompt && prompt.kind !== "select" ? (
            <form
              className="pw-auth-block"
              onSubmit={(e) => {
                e.preventDefault();
                void respond(input);
              }}
            >
              <label className="pw-set-field">
                <span className="pw-set-lbl">{prompt.label}</span>
                <input
                  ref={inputRef}
                  className="pw-set-input"
                  // secret 走 password：OAuth 过程中的一次性密钥同样不该出现在肩窥范围里。
                  type={prompt.kind === "secret" ? "password" : "text"}
                  value={input}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setInput(e.target.value)}
                />
              </label>
              {prompt.kind === "manual_code" ? (
                <div className="pw-set-hint">{t("providers.auth.manualCodeHint")}</div>
              ) : null}
              <button type="submit" className="pw-mode-block-btn primary">
                {t("providers.auth.submit")}
              </button>
            </form>
          ) : null}

          {phase === "running" && !prompt ? <div className="pw-set-hint">{t("providers.auth.waiting")}</div> : null}
          {phase === "done" ? <div className="pw-prov-alert is-ok">{t("providers.auth.done")}</div> : null}
          {phase === "error" ? (
            <div className="pw-prov-alert is-error">{t("providers.auth.failed", { error: error ?? "" })}</div>
          ) : null}

          <div className="pw-mode-block-actions">
            {phase === "error" ? (
              <button type="button" className="pw-mode-block-btn primary" onClick={retry}>
                {t("providers.auth.retry")}
              </button>
            ) : null}
            {phase === "done" ? (
              <button type="button" className="pw-mode-block-btn primary" onClick={onClose}>
                {t("providers.auth.close")}
              </button>
            ) : (
              <button type="button" className="pw-mode-block-btn" onClick={() => void cancel()}>
                {t("providers.auth.cancel")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

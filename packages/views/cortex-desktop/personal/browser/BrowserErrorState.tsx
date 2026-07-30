// 内嵌浏览器「无法访问此站点」整页错误态(计划 U2,对齐参考图 Image #1)。
// 纯展示组件:接收 host / errorCode / errorDescription,按 describeBrowserError(core 纯函数)
// 映射出原因与排查建议的 i18n key 再渲染。
//   - webview 失败:errorCode 为 Chromium net error code(负数),展示原因+建议+错误码。
//   - iframe 回退失败:同源策略拿不到 errorCode(传 null),降级为「被站点拒绝嵌入」通用文案,
//     隐藏错误码行(计划 KTD3)。

import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { describeBrowserError } from "@cortex-work/core/personal/browserErrorInfo";

export function BrowserErrorState({
  host,
  errorCode,
  errorDescription,
  onReload,
  onOpenExternal,
}: {
  host: string;
  errorCode: number | null;
  errorDescription: string | null;
  onReload: () => void;
  onOpenExternal: () => void;
}) {
  const { t } = useTranslation("browser");

  // iframe(errorCode 为 null):无错误码,统一走「被拒绝嵌入」降级文案。
  const info =
    errorCode == null
      ? { reasonKey: "error.reason.blocked", hintKeys: ["error.hint.embedBlocked"] }
      : describeBrowserError(errorCode, host);

  return (
    <div className="pw-browser-error-full" role="alert">
      <Icon.Globe size={44} />
      <div className="pw-browser-error-title">{t("error.title")}</div>
      <div className="pw-browser-error-reason">{t(info.reasonKey, { host })}</div>
      <ul className="pw-browser-error-hints">
        {info.hintKeys.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
      {errorDescription ? (
        <div className="pw-browser-error-code">
          {t("error.code")}: {errorDescription}
        </div>
      ) : null}
      <div className="pw-browser-error-actions">
        <button type="button" className="pw-browser-error-btn is-primary" onClick={onReload}>
          {t("error.reload")}
        </button>
        <button type="button" className="pw-browser-error-btn" onClick={onOpenExternal}>
          {t("error.openExternal")}
        </button>
      </div>
    </div>
  );
}

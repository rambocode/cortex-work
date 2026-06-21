// 标注模式下的宿主批量发送条(计划 U5)。高亮框/编号徽标/评论输入框都在页面内由
// annotation preload 绘制(随元素原生滚动,见 KTD5 的页面内方案);宿主只保留这条「发送」控制条
// (固定在 stage 底部,不锚定任何元素,故无坐标同步)。发送到 Chat/终端每次可选(用户确认)。

import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";

export function BrowserAnnotator({
  count,
  onSendChat,
  onSendTerminal,
}: {
  count: number;
  onSendChat: () => void;
  onSendTerminal: () => void;
}) {
  const { t } = useTranslation("browser");
  const disabled = count === 0;
  return (
    <div className="pw-browser-annot-bar" role="toolbar" aria-label={t("nav.annotate")}>
      <span className="pw-browser-annot-count">{t("annotate.barLabel", { count })}</span>
      <div className="pw-browser-annot-actions">
        <button
          type="button"
          className="pw-browser-annot-send"
          disabled={disabled}
          onClick={onSendChat}
        >
          <Icon.Send size={13} />
          {t("annotate.sendToChat")}
        </button>
        <button
          type="button"
          className="pw-browser-annot-send"
          disabled={disabled}
          onClick={onSendTerminal}
        >
          <Icon.Terminal size={13} />
          {t("annotate.sendToTerminal")}
        </button>
      </div>
    </div>
  );
}

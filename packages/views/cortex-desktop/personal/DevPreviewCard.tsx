// 「打开预览」卡片:agent 输出里探测到本地 dev 预览 URL 时,在消息流与输入框之间展示,
// 点击在右栏内嵌浏览器打开(见计划 U5)。auto_open(仅环回)由 PersonalChatArea 直接处理,
// 此卡片是用户主动入口,展示全部探测到的本地/私网 URL(card 模式)。

import { Icon } from "@cortex-work/ui/icons";
import { formatDevPreviewUrlLabel } from "@cortex-work/core/personal/devPreviewDetection";

export function DevPreviewCard({
  urls,
  onOpen,
}: {
  urls: string[];
  onOpen: (url: string) => void;
}) {
  if (urls.length === 0) return null;
  return (
    <div className="pw-devpreview-card">
      <Icon.Globe size={14} />
      <span className="pw-devpreview-label">检测到本地预览</span>
      <div className="pw-devpreview-urls">
        {urls.map((url) => (
          <button
            key={url}
            type="button"
            className="pw-devpreview-chip"
            title={`在浏览器打开 ${url}`}
            onClick={() => onOpen(url)}
          >
            {formatDevPreviewUrlLabel(url)}
          </button>
        ))}
      </div>
    </div>
  );
}

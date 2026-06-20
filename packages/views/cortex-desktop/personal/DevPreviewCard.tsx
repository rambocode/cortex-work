// 「打开预览」卡片:agent 输出里探测到本地 dev 预览 URL 或本地 HTML 文件时,在消息流与输入框
// 之间展示,点击在右栏内嵌浏览器打开(见计划 U5 + 本地 HTML 预览扩展)。auto_open(仅环回)由
// PersonalChatArea 直接处理,此卡片是用户主动入口。
//   - urls:本地/私网 dev URL(http://localhost...),点击直接加载。
//   - htmlPaths:agent 产出的本地 .html 文件路径,点击经主进程授权为 file:// 再加载。

import { Icon } from "@cortex-work/ui/icons";
import {
  formatDevPreviewUrlLabel,
  formatLocalHtmlLabel,
} from "@cortex-work/core/personal/devPreviewDetection";

export function DevPreviewCard({
  urls,
  htmlPaths = [],
  onOpen,
  onOpenPath,
}: {
  urls: string[];
  htmlPaths?: string[];
  onOpen: (url: string) => void;
  onOpenPath?: (path: string) => void;
}) {
  if (urls.length === 0 && htmlPaths.length === 0) return null;
  return (
    <div className="pw-devpreview-card">
      <Icon.Globe size={14} />
      <span className="pw-devpreview-label">
        {urls.length > 0 ? "检测到本地预览" : "检测到本地网页"}
      </span>
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
        {htmlPaths.map((path) => (
          <button
            key={path}
            type="button"
            className="pw-devpreview-chip"
            title={`在浏览器预览 ${path}`}
            onClick={() => onOpenPath?.(path)}
          >
            {formatLocalHtmlLabel(path)}
          </button>
        ))}
      </div>
    </div>
  );
}

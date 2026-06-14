// 个人区聊天专用的 react-markdown 自定义 components:把 Agent 回复里「项目内文件路径」的
// inline code 与相对链接渲染为可点击元素,点击经 onOpenFile 接到右栏文件预览。
// - 仅个人区(传入 onOpenFile + projectPath)启用;团队侧不传 → 不使用本工厂,零回归。
// - inline 判定:无 language-* className 的 code(块级 fenced 带语言或含换行,isLikelyFilePath 天然拒绝)。
// - 外链行为复用 MarkdownView.MdLink 思路:http(s) → bridge.openExternal;相对文件路径 → onOpenFile。

import type { ReactNode } from "react";
import type { Components } from "react-markdown";
import { isLikelyFilePath, resolveProjectFileRef } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";

// 递归取 react 子节点的纯文本（inline code 子节点通常是字符串,偶尔是数组）。
function textOf(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

export interface ChatMarkdownOptions {
  onOpenFile: (ref: string) => void;
  projectPath: string;
  bridge: DesktopBridge | null;
}

export function chatMarkdownComponents({ onOpenFile, projectPath, bridge }: ChatMarkdownOptions): Components {
  // 渲染期静态判定:像文件路径 且 解析后落在项目根内（white-list 代理,见 KTD2）。
  const isProjectFile = (ref: string) => isLikelyFilePath(ref) && resolveProjectFileRef(projectPath, ref).within;

  return {
    code({ node: _node, className, children, ...rest }) {
      const text = textOf(children);
      const isBlock = /language-/.test(className ?? "");
      if (!isBlock && isProjectFile(text)) {
        const open = () => onOpenFile(text);
        return (
          <code
            {...rest}
            className={className ? `${className} file-link` : "file-link"}
            role="button"
            tabIndex={0}
            title={text}
            onClick={open}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
              }
            }}
          >
            {children}
          </code>
        );
      }
      return (
        <code {...rest} className={className}>
          {children}
        </code>
      );
    },
    a({ node: _node, href, children, ...rest }) {
      const external = /^https?:\/\//i.test(href ?? "");
      return (
        <a
          {...rest}
          href={href}
          rel="noreferrer"
          title={external ? href : rest.title}
          onClick={(e) => {
            // Electron 里 a 默认导航会替换整个窗口,一律 preventDefault 后自行分流。
            e.preventDefault();
            if (external && href) {
              if (bridge?.openExternal) void bridge.openExternal(href).catch(() => {});
              else window.open(href, "_blank", "noreferrer");
              return;
            }
            if (href && isProjectFile(href)) onOpenFile(href);
            // 其余(锚点/项目外/非路径)阻止导航,不做处理。
          }}
        >
          {children}
        </a>
      );
    },
  };
}

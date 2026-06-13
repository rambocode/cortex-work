// 共享 Markdown 渲染:tasks 详情（TodosView）与文件窗口 .md 预览（FilesView）共用,
// 保证两处渲染方式完全一致（react-markdown + remark-gfm + 自定义 callout / 链接 / 代码块）。
// 外层容器仍由调用方套 .pw-todo-md（排版样式挂在该 class 上）。

import { isValidElement, type ComponentProps, type ReactElement } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useDesktopBridge } from "@cortex-work/core";
import { remarkCallouts } from "./markdownCallouts";

// 预览里的链接:点击改走系统浏览器（Electron 里 a 默认导航会替换整个窗口）。
// 仅放行 http(s);旧壳没有 openExternal 时退回 window.open。
function MdLink({ href, children, ...rest }: ComponentProps<"a">) {
  const bridge = useDesktopBridge();
  const external = /^https?:\/\//i.test(href ?? "");
  return (
    <a
      {...rest}
      href={href}
      rel="noreferrer"
      title={external ? href : rest.title}
      onClick={(e) => {
        e.preventDefault();
        if (!external || !href) return;
        if (bridge?.openExternal) void bridge.openExternal(href).catch(() => {});
        else window.open(href, "_blank", "noreferrer");
      }}
    >
      {children}
    </a>
  );
}

// 代码块:从 <code className="language-x"> 提取语言,角标显示在卡片右上角。
function MdPre({ children, ...rest }: ComponentProps<"pre">) {
  const code = isValidElement(children) ? (children as ReactElement<{ className?: string }>) : null;
  const lang = /language-([\w+-]+)/.exec(code?.props.className ?? "")?.[1];
  return (
    <pre {...rest} data-lang={lang}>
      {children}
    </pre>
  );
}

const MD_COMPONENTS = { a: MdLink, pre: MdPre };
const MD_PLUGINS = [remarkGfm, remarkCallouts];

export function MarkdownView({ content }: { content: string }) {
  return (
    <Markdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
      {content}
    </Markdown>
  );
}

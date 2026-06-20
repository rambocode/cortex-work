// 个人区聊天专用的 react-markdown 自定义 components:把 Agent 回复里「项目内文件路径」的
// inline code 与相对链接渲染为可点击元素,点击经 onOpenFile 接到右栏文件预览。
// - 仅个人区(传入 onOpenFile + projectPath)启用;团队侧不传 → 不使用本工厂,零回归。
// - inline 判定:无 language-* className 的 code(块级 fenced 带语言或含换行,isLikelyFilePath 天然拒绝)。
// - 外链行为复用 MarkdownView.MdLink 思路:http(s) → bridge.openExternal;相对文件路径 → onOpenFile。
// - 失效标注:渲染期经 bridge.resolveProjectFile 在项目内定位 ref(支持只给文件名、真实文件在子目录),
//   定位不到(真已删除)→ 删除线灰显且不可点击;定位得到则可点击。探测无能力/出错时乐观放行。

import { useEffect, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import {
  isLikelyFilePath,
  resolveProjectFileRef,
  useCortexUIStore,
  usePersonalStore,
} from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { findLocalHtmlPathsInText } from "@cortex-work/core/personal/devPreviewDetection";
import { Icon } from "@cortex-work/ui/icons";

// 递归取 react 子节点的纯文本。inline code 子节点通常是字符串/数组;但 fenced 代码块的
// <pre> 子节点是一个 <code> React 元素,需递归进其 props.children 才能拿到文本(否则 pre
// 渲染里 findLocalHtmlPathsInText 会拿到空串、匹配不到路径)。
function textOf(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (children && typeof children === "object" && "props" in children) {
    return textOf((children as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

// 渲染期在项目内定位文件。"checking" 期间乐观当作可点击,仅确认定位不到才标 missing,
// 避免存在的文件出现「先划线再恢复」的闪烁。无探测能力 / 探测出错 → 一律乐观放行。
type ResolveState = "checking" | "ok" | "missing";
function useResolvedFile(bridge: DesktopBridge | null, projectPath: string, ref: string): ResolveState {
  const [state, setState] = useState<ResolveState>("checking");
  useEffect(() => {
    const probe = bridge?.resolveProjectFile;
    if (!probe) {
      setState("ok");
      return;
    }
    let alive = true;
    setState("checking");
    probe(projectPath, ref).then(
      (abs) => alive && setState(abs ? "ok" : "missing"),
      () => alive && setState("ok"), // 探测失败不误判删除
    );
    return () => {
      alive = false;
    };
  }, [bridge, projectPath, ref]);
  return state;
}

interface FileRefProps {
  ref_: string; // 原始 ref(传给 onOpenFile,与既有契约一致)
  projectPath: string;
  bridge: DesktopBridge | null;
  onOpenFile: (ref: string) => void;
  children: ReactNode;
}

// inline code 形态的文件链接。
function FileCode({
  ref_,
  projectPath,
  bridge,
  onOpenFile,
  className,
  children,
  ...rest
}: FileRefProps & { className?: string } & Record<string, unknown>) {
  const missing = useResolvedFile(bridge, projectPath, ref_) === "missing";
  const open = () => onOpenFile(ref_);
  const cls = [className, "file-link", missing ? "file-link-missing" : ""].filter(Boolean).join(" ");
  return (
    <code
      {...rest}
      className={cls}
      role="button"
      tabIndex={missing ? -1 : 0}
      aria-disabled={missing || undefined}
      title={missing ? `文件不存在或已删除：${ref_}` : ref_}
      onClick={missing ? undefined : open}
      onKeyDown={
        missing
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
              }
            }
      }
    >
      {children}
    </code>
  );
}

// markdown 相对链接形态的文件链接。
function FileAnchor({
  ref_,
  projectPath,
  bridge,
  onOpenFile,
  href,
  children,
  ...rest
}: FileRefProps & { href?: string } & Record<string, unknown>) {
  const missing = useResolvedFile(bridge, projectPath, ref_) === "missing";
  return (
    <a
      {...rest}
      href={href}
      rel="noreferrer"
      className={["file-link", missing ? "file-link-missing" : ""].filter(Boolean).join(" ")}
      aria-disabled={missing || undefined}
      title={missing ? `文件不存在或已删除：${ref_}` : ref_}
      onClick={(e) => {
        e.preventDefault(); // Electron 里 a 默认导航会替换整个窗口
        if (!missing) onOpenFile(ref_);
      }}
    >
      {children}
    </a>
  );
}

// 本地 HTML 预览按钮:渲染在含 .html 路径的 fenced 代码块正下方(用户要求:预览入口紧跟路径)。
// 点击经主进程把路径授权为 file:// 再在右栏内嵌浏览器打开;无桥则退化系统打开。
function HtmlPreviewButton({ path, bridge }: { path: string; bridge: DesktopBridge | null }) {
  const open = () => {
    const resolve = bridge?.browserResolveLocalHtml;
    if (!resolve) {
      void bridge?.openExternal?.(path).catch(() => {});
      return;
    }
    void resolve(path).then((fileUrl) => {
      if (!fileUrl) return;
      usePersonalStore.getState().requestBrowserUrl(fileUrl);
      useCortexUIStore.getState().setRightOpen(true);
    });
  };
  return (
    <button type="button" className="pw-html-preview-btn" onClick={open} title={`在内嵌浏览器预览 ${path}`}>
      <Icon.Globe size={13} />
      <span>预览网页</span>
    </button>
  );
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
    // fenced 代码块:若块内含绝对 .html 路径(如 `open /Users/.../foo.html`),在代码块正下方
    // 紧跟一个「预览网页」按钮(用户要求:预览入口直接放路径后面,而非消息底部卡片)。
    pre({ node: _node, children, ...rest }) {
      const htmlPath = findLocalHtmlPathsInText(textOf(children))[0];
      return (
        <>
          <pre {...rest}>{children}</pre>
          {htmlPath ? <HtmlPreviewButton path={htmlPath} bridge={bridge} /> : null}
        </>
      );
    },
    code({ node: _node, className, children, ...rest }) {
      const text = textOf(children);
      const isBlock = /language-/.test(className ?? "");
      if (!isBlock && isProjectFile(text)) {
        return (
          <FileCode
            {...rest}
            ref_={text}
            projectPath={projectPath}
            bridge={bridge}
            onOpenFile={onOpenFile}
            className={className}
          >
            {children}
          </FileCode>
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
      if (!external && href && isProjectFile(href)) {
        return (
          <FileAnchor
            {...rest}
            ref_={href}
            href={href}
            projectPath={projectPath}
            bridge={bridge}
            onOpenFile={onOpenFile}
          >
            {children}
          </FileAnchor>
        );
      }
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
            // 其余(锚点/项目外/非路径)阻止导航,不做处理。
          }}
        >
          {children}
        </a>
      );
    },
  };
}

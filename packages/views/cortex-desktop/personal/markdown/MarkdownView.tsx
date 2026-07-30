// 共享 Markdown 渲染:tasks 详情（TodosView）与文件窗口 .md 预览（FilesView）共用,
// 保证两处渲染方式完全一致（react-markdown + remark-gfm + 自定义 callout / 链接 / 代码块）。
// 外层容器仍由调用方套 .pw-todo-md（排版样式挂在该 class 上）。

import { isValidElement, useEffect, useId, useState, type ComponentProps, type ReactElement } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import mermaid from "mermaid";
import { useDesktopBridge } from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { remarkCallouts } from "./markdownCallouts";
import { splitFrontmatter, type FrontmatterEntry } from "./markdownFrontmatter";
// 代码块外壳零件与会话流(chatMarkdown / ChatArea)共用,见 markdownCodeShared.tsx。
import { CopyButton, nodeText } from "./markdownCodeShared";

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

// mermaid 渲染:仅客户端(useEffect 内)调用,模块级单例 initialize 只跑一次,
// 静态 import 不在 import 期触碰 document;渲染失败时降级为显示原始源码。
let mermaidReady = false;
function ensureMermaidInit() {
  if (mermaidReady) return;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
  mermaidReady = true;
}

function MermaidBlock({ src }: { src: string }) {
  // useId 含冒号,作为 mermaid/DOM id 不合法,清洗为安全字符。
  const renderId = `mmd-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let mounted = true;
    setSvg(null);
    setError(false);
    try {
      ensureMermaidInit();
    } catch {
      if (mounted) setError(true);
      return;
    }
    mermaid
      .render(renderId, src)
      .then(({ svg }) => {
        if (mounted) setSvg(svg);
      })
      .catch(() => {
        if (mounted) setError(true);
      });
    return () => {
      mounted = false;
    };
  }, [src, renderId]);

  if (error) {
    return (
      <pre className="pw-md-mermaid-error" data-lang="mermaid">
        {src}
      </pre>
    );
  }
  if (svg) {
    // svg 已由 mermaid 在 securityLevel:'strict' 下经内置 DOMPurify 消毒,可安全注入。
    return <div className="pw-md-mermaid" role="img" dangerouslySetInnerHTML={{ __html: svg }} />;
  }
  return <div className="pw-md-mermaid" data-loading="" aria-busy="true" />;
}

// 代码块:从 <code className="language-x"> 提取语言。mermaid 块改走 MermaidBlock(不套高亮/复制壳),
// 其余块套带复制按钮的外壳,高亮 span 由 rehype-highlight 注入。
function MdPre({ children, node, ...rest }: ComponentProps<"pre"> & { node?: unknown }) {
  const code = isValidElement(children) ? (children as ReactElement<{ className?: string }>) : null;
  const lang = /language-([\w+-]+)/.exec(code?.props.className ?? "")?.[1];
  if (lang === "mermaid") {
    return <MermaidBlock src={nodeText(node).replace(/\n$/, "")} />;
  }
  return (
    <div className="pw-md-codeblock">
      <CopyButton text={nodeText(node).replace(/\n$/, "")} />
      <pre {...rest} data-lang={lang}>
        {children}
      </pre>
    </div>
  );
}

const MD_COMPONENTS = { a: MdLink, pre: MdPre };
const MD_PLUGINS = [remarkGfm, remarkCallouts];
// ignoreMissing:未注册语言(含 mermaid)原样保留,不报错、不吞内容。
const MD_REHYPE_PLUGINS: import("react-markdown").Options["rehypePlugins"] = [
  [rehypeHighlight, { ignoreMissing: true }],
];

// 文档头部的 YAML 元数据:默认折叠,只露一个入口,点击展开 key-value 列表。
function Frontmatter({ meta }: { meta: FrontmatterEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pw-md-fm" {...(open ? { "data-open": "" } : {})}>
      <button
        type="button"
        className="pw-md-fm-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon.ChevronRight className="pw-md-fm-caret" size={12} />
        元数据
        <span className="pw-md-fm-count">{meta.length}</span>
      </button>
      {open ? (
        <dl className="pw-md-fm-body">
          {meta.map((m, i) => (
            <div className="pw-md-fm-row" key={`${m.key}-${i}`}>
              <dt>{m.key}</dt>
              <dd>{m.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

export function MarkdownView({ content }: { content: string }) {
  const { meta, body } = splitFrontmatter(content);
  return (
    <>
      {meta ? <Frontmatter meta={meta} /> : null}
      <Markdown
        remarkPlugins={MD_PLUGINS}
        rehypePlugins={MD_REHYPE_PLUGINS}
        components={MD_COMPONENTS}
      >
        {body}
      </Markdown>
    </>
  );
}

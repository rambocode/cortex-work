// 个人区聊天专用的 react-markdown 自定义 components:把 Agent 回复里「项目内文件路径」的
// inline code 与相对链接渲染为可点击元素,点击经 onOpenFile 接到右栏文件预览。
// - 仅个人区(传入 onOpenFile + projectPath)启用;团队侧不传 → 不使用本工厂,零回归。
// - inline 判定:无 language-* className 的 code(块级 fenced 带语言或含换行,isLikelyFilePath 天然拒绝)。
// - 外链行为:http(s) 点击 → 在右栏内置浏览器打开(requestBrowserUrl + setRightOpen),
//   不再默认丢给系统浏览器;系统浏览器作为下方「网页预览」卡片「打开方式」的备选项。
// - 网页预览卡片:每条外链所在段落正下方紧跟一张静态卡片(地球图标 + 「网页预览」+ 域名),
//   点击主体进内置浏览器,「打开方式」下拉可选内置 / 系统浏览器。
// - 文件链接:渲染期经 bridge.resolveProjectFile 在项目内定位 ref(支持只给文件名、真实文件在子目录),
//   定位到 → 高亮可点(进右栏预览);探测中 / 定位不到(目录、分支名、其它分支才有的文件)→ 退化普通
//   inline code(不高亮、不可点、无删除线)。点不到的安全网由 PersonalChatArea.handleOpenFile 的 toast
//   兜底。探测无能力(Web / 无 bridge)或出错时乐观放行为可点。

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Components } from "react-markdown";
import {
  isLikelyFilePath,
  isLocalImagePath,
  resolveProjectFileRef,
  useCortexUIStore,
  usePersonalStore,
} from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { canProbeFile, resolveExistingFile } from "./resolveFileRef";
import { ChatInlineImage } from "./ChatInlineImage";
import { findLocalHtmlPathsInText } from "@cortex-work/core/personal/devPreviewDetection";
import { isLoopbackOnly } from "@cortex-work/core/personal/devPreviewUrl";
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

// 渲染期按「文件真实存在」点亮链接(口径见 resolveExistingFile:绝对路径走 fileExists、相对走
// resolveProjectFile→拼 abs+fileExists,覆盖项目外与 `../outputs` 爬出)。只有解析到真实路径
// ("ok")才高亮可点;探测中("checking")/ 解析不到("missing")退化普通 code(不高亮)。
// 初始 state 按探测能力决定:无探测能力(Web / 无 bridge)直接 "ok"(同步可点、零闪烁,保住无 probe
// 的同步断言);有探测能力则 "checking",待结果落定再点亮。探测出错 → 乐观放行为 "ok"。
type ResolveState = "checking" | "ok" | "missing";
function useResolvedFile(bridge: DesktopBridge | null, projectPath: string, ref: string): ResolveState {
  const [state, setState] = useState<ResolveState>(() => (canProbeFile(bridge) ? "checking" : "ok"));
  useEffect(() => {
    if (!canProbeFile(bridge)) {
      setState("ok");
      return;
    }
    let alive = true;
    setState("checking");
    resolveExistingFile(bridge, projectPath, ref).then(
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
  // 仅「项目内确实定位到的文件」渲染成高亮可点链接;探测中 / 定位不到(目录、分支名、其它分支文件)
  // → 退化普通 inline code(不高亮、不可点、无删除线)。点不到的安全网由 handleOpenFile 的 toast 兜底。
  const resolved = useResolvedFile(bridge, projectPath, ref_) === "ok";
  if (!resolved) {
    return (
      <code {...rest} className={className}>
        {children}
      </code>
    );
  }
  const open = () => onOpenFile(ref_);
  return (
    <code
      {...rest}
      className={[className, "file-link"].filter(Boolean).join(" ")}
      role="button"
      tabIndex={0}
      title={ref_}
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
  // 同 FileCode:仅定位到的文件才高亮可点;探测中 / 定位不到 → 退化普通链接(阻止 Electron 默认整窗
  // 导航,但不当项目文件、无 file-link 高亮)。
  const resolved = useResolvedFile(bridge, projectPath, ref_) === "ok";
  return (
    <a
      {...rest}
      href={href}
      rel="noreferrer"
      className={resolved ? "file-link" : undefined}
      title={resolved ? ref_ : undefined}
      onClick={(e) => {
        e.preventDefault(); // Electron 里 a 默认导航会替换整个窗口
        if (resolved) onOpenFile(ref_);
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

// 在右栏内置浏览器打开 URL:bump nonce 触发 BrowserView 加载,并确保右栏展开。
// 与 HtmlPreviewButton / dev 预览 auto_open 走同一通路,行为统一。
function openInInternalBrowser(url: string): void {
  usePersonalStore.getState().requestBrowserUrl(url);
  useCortexUIStore.getState().setRightOpen(true);
}

// 本地/loopback URL 判定——仅这类受「本地 URL 打开目标」偏好控制(外链恒进内置,保留既有决策)。
function isLocalUrl(url: string): boolean {
  try {
    return isLoopbackOnly(new URL(url).hostname);
  } catch {
    return false;
  }
}

// 按 browserControl.localUrlOpenTarget 分流:偏好=system 且为本地 URL 且 bridge 可用 → 系统浏览器;
// 其余(含全部外链)→ 内置面板。设置页「本地 URL 打开目标」下拉经此生效(plan U3 / R7)。
function openUrlByPreference(url: string, bridge: DesktopBridge | null): void {
  const target = usePersonalStore.getState().generalSettings.browserControl?.localUrlOpenTarget ?? "internal";
  if (target === "system" && isLocalUrl(url) && bridge?.openExternal) {
    void bridge.openExternal(url).catch(() => {});
    return;
  }
  openInInternalBrowser(url);
}

// 取 URL 的 host 作为卡片副标题;非法 URL(理论上 a 组件已用 https? 正则过滤)兜底空串。
function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// 文本里的裸 URL 匹配:排除空白、尖括号、圆括号与中英文标点(避免吞掉句末「。」「,」等)。
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>()，。；、）】]+/gi;

// 递归遍历段落的 hast 节点,收集其中的 http/https URL,按出现顺序去重。
// 三条来源都覆盖,因为 agent 习惯不一:
//  - <a> 的 href(markdown 链接 [text](url));
//  - GFM autolink 的裸 URL(也是 <a>);
//  - 文本 / 内联 code 里的裸 URL —— agent 常把地址包在反引号里(`http://...`),
//    而 GFM autolink 不会进 code span,故必须扫描 text 节点的 value。
function collectParagraphUrls(node: unknown): string[] {
  const out: string[] = [];
  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    const el = n as { tagName?: string; properties?: { href?: unknown }; value?: unknown; children?: unknown };
    const href = el.properties?.href;
    if (el.tagName === "a" && typeof href === "string" && /^https?:\/\//i.test(href)) {
      out.push(href);
    }
    if (typeof el.value === "string") {
      const m = el.value.match(URL_IN_TEXT_RE);
      if (m) out.push(...m);
    }
    if (Array.isArray(el.children)) el.children.forEach(visit);
  };
  visit(node);
  // 去重:剥行尾残留标点后,用「再去尾斜杠 + 小写」作归一键判重(显示/点击仍用原始串)。
  // 关键:同一外链常以「裸 URL 文本 + markdown 链接 href」两种形态同段出现,而 agent/LLM 习惯把
  // 链接 href 归一成带尾斜杠(http://h:3000/),文本写不带斜杠(http://h:3000)——不归一会判成两条、
  // 渲染出两张重复「网页预览」卡片(用户反馈)。归一键合并这种「仅尾斜杠/大小写之差」的同链。
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of out) {
    const cleaned = raw.replace(/[.,;:]+$/, "");
    const key = cleaned.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

// 「网页预览」静态卡片:不抓取网页元数据(零网络/零隐私),仅展示地球图标 + 标题 + 域名。
// 点击主体 → 内置浏览器;「打开方式」下拉可改用系统浏览器(经 bridge.openExternal)。
function LinkPreviewCard({ url, bridge }: { url: string; bridge: DesktopBridge | null }) {
  const [menuOpen, setMenuOpen] = useState(false);
  // 菜单经 portal 渲染到 body 并 fixed 定位,彻底脱离消息流的 stacking context / overflow,
  // 否则下拉会被 DOM 顺序靠后的后续消息(各自独立层叠环境)遮挡 —— 仅靠 z-index 无法解决。
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const openBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const host = hostLabel(url);
  // 主体点击按偏好分流(本地 URL 可走系统);菜单两项为显式覆盖(始终内置 / 始终系统)。
  const openMain = () => openUrlByPreference(url, bridge);
  const openInternal = () => openInInternalBrowser(url);
  const openSystem = () => {
    void bridge?.openExternal?.(url).catch(() => {});
  };
  // 依据「打开方式」按钮的视口坐标计算 fixed 菜单位置(下方、右对齐按钮右边)。
  const placeMenu = () => {
    const r = openBtnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };
  const toggleMenu = () => {
    setMenuOpen((v) => {
      const next = !v;
      if (next) placeMenu();
      return next;
    });
  };
  // 菜单打开期间:点击外部关闭;滚动 / 改窗 → 直接关闭(fixed 菜单不跟随滚动,重定位不如关闭省事)。
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || openBtnRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onDismiss = () => setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
    };
  }, [menuOpen]);
  return (
    <div className="pw-link-preview-card">
      <button type="button" className="pw-link-preview-main" onClick={openMain} title={url}>
        <span className="pw-link-preview-icon">
          <Icon.Globe size={18} />
        </span>
        <span className="pw-link-preview-text">
          <span className="pw-link-preview-title">网页预览</span>
          <span className="pw-link-preview-host">{host || "网站"}</span>
        </span>
      </button>
      <div className="pw-link-preview-actions">
        <button
          ref={openBtnRef}
          type="button"
          className="pw-link-preview-open"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={toggleMenu}
        >
          <span>打开方式</span>
          <Icon.Chevron size={12} />
        </button>
        {menuOpen && menuPos
          ? createPortal(
              <div
                ref={menuRef}
                className="pw-link-preview-menu pw-link-preview-menu--portal"
                role="menu"
                style={{ top: menuPos.top, right: menuPos.right }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    openInternal();
                  }}
                >
                  内置浏览器
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    openSystem();
                  }}
                >
                  系统浏览器
                </button>
              </div>,
              document.body,
            )
          : null}
      </div>
    </div>
  );
}

export interface ChatMarkdownOptions {
  onOpenFile: (ref: string) => void;
  projectPath: string;
  bridge: DesktopBridge | null;
}

export function chatMarkdownComponents({ onOpenFile, projectPath, bridge }: ChatMarkdownOptions): Components {
  // 渲染期静态判定:是否当作可点击文件链接渲染(再经 useResolvedFile 按存在性点亮)。
  // 判定按「能否打开」而非「是否项目内」:
  //  - 绝对路径(agent 产物常落项目外,如 ~/.codex/generated_images):有探测能力即进入存在性判定;
  //  - 项目内相对路径:走 within(无探测能力时也乐观可点,保住 web 同步断言);
  //  - 项目外相对爬出(`../outputs/x.docx`,within=false):有探测能力即进入存在性判定。
  // 无探测能力(web/旧壳)时不放行项目外路径(无从验证、也打不开),退化普通 code/链接。
  // pre 的本地 HTML 预览不依赖此判定,仍对无项目会话生效。
  const canProbe = canProbeFile(bridge);
  const isOpenableFile = (ref: string) => {
    if (!isLikelyFilePath(ref)) return false;
    if (ref.startsWith("/")) return canProbe; // 绝对路径:存在性由 useResolvedFile/handleOpenFile 兜底
    if (!projectPath) return false; // 相对路径需项目根(空根会把任意相对路径误判 within)
    if (resolveProjectFileRef(projectPath, ref).within) return true; // 项目内
    return canProbe; // 项目外相对爬出
  };

  return {
    // 图片:agent 用 `![](path)` 给本地图片时,内联渲染为图片(经 imageReadAny 回读 dataURL)。
    // 远程图床 / data: URI / svg 不命中 isLocalImagePath → 走 react-markdown 默认 <img>。
    img({ node: _node, src, alt, ...rest }) {
      if (typeof src === "string" && isLocalImagePath(src)) {
        return (
          <ChatInlineImage src={src} alt={typeof alt === "string" ? alt : ""} projectPath={projectPath} bridge={bridge} onOpenFile={onOpenFile} />
        );
      }
      return <img {...rest} src={src} alt={typeof alt === "string" ? alt : ""} />;
    },
    // 段落:若段内含外链(http/https),在段落正下方为每条外链(去重)紧跟一张「网页预览」卡片。
    // 卡片是 <p> 的兄弟节点(经 Fragment),不嵌进 <p> 内,避免 div-in-p 的非法 DOM。
    p({ node, children, ...rest }) {
      const urls = collectParagraphUrls(node);
      return (
        <>
          <p {...rest}>{children}</p>
          {urls.map((u) => (
            <LinkPreviewCard key={u} url={u} bridge={bridge} />
          ))}
        </>
      );
    },
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
      // 内联 code 恰为一条 http(s) URL → 渲染成可点击外链(进内置浏览器)。
      // agent 常把地址包在反引号里(`http://localhost:3000`),GFM autolink 不进 code span,
      // 不在此特判就会渲染成不可点的灰底 code(本次反馈的核心问题)。卡片由 p 收集器统一补。
      const urlText = text.trim();
      if (!isBlock && /^https?:\/\/\S+$/i.test(urlText)) {
        const open = () => openInInternalBrowser(urlText);
        return (
          <code
            {...rest}
            className={[className, "url-link"].filter(Boolean).join(" ")}
            role="button"
            tabIndex={0}
            title={urlText}
            onClick={open}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
              }
            }}
          >
            <Icon.Globe size={12} />
            {children}
          </code>
        );
      }
      if (!isBlock && isOpenableFile(text)) {
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
      // agent 常用链接语法 `[name](path)` 给图片(而非 `![]()`)→ 命中本地图片路径则内联渲染图片。
      if (!external && href && isLocalImagePath(href)) {
        return (
          <ChatInlineImage src={href} alt={textOf(children)} projectPath={projectPath} bridge={bridge} onOpenFile={onOpenFile} />
        );
      }
      if (!external && href && isOpenableFile(href)) {
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
          // 外链统一蓝色 + 前置地球图标,与内联 URL code 视觉一致。
          className={external ? [rest.className, "url-link"].filter(Boolean).join(" ") : rest.className}
          title={external ? href : rest.title}
          onClick={(e) => {
            // Electron 里 a 默认导航会替换整个窗口,一律 preventDefault 后自行分流。
            e.preventDefault();
            if (external && href) {
              // 外链/本地链接点击:按「本地 URL 打开目标」偏好分流(外链恒内置,本地可走系统)。
              openUrlByPreference(href, bridge);
              return;
            }
            // 其余(锚点/项目外/非路径)阻止导航,不做处理。
          }}
        >
          {external ? <Icon.Globe size={12} /> : null}
          {children}
        </a>
      );
    },
  };
}

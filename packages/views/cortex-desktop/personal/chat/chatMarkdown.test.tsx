import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DesktopBridge } from "@cortex-work/core";
import { DEFAULT_BROWSER_CONTROL, useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { chatMarkdownComponents, chatMarkdownUrlTransform, fileIconFor } from "./chatMarkdown";
import { normalizeKnowledgeLinks } from "../knowledge/KnowledgeDocRef";

function setLocalUrlTarget(target: "internal" | "system") {
  usePersonalStore.setState((s) => ({
    generalSettings: { ...s.generalSettings, browserControl: { ...DEFAULT_BROWSER_CONTROL, localUrlOpenTarget: target } },
  }));
}

function renderMd(
  text: string,
  opts: {
    projectPath?: string;
    resolveProjectFile?: (root: string, ref: string) => Promise<string | null>;
    fileExists?: (path: string) => Promise<boolean>;
    imageReadAny?: (path: string) => Promise<{ dataUrl: string }>;
    knowledge?: boolean;
  } = {},
) {
  const { projectPath = "/proj", resolveProjectFile, fileExists, imageReadAny, knowledge } = opts;
  const onOpenFile = vi.fn<(ref: string) => void>();
  const openExternal = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
  const bridge = {
    openExternal,
    ...(resolveProjectFile ? { resolveProjectFile } : {}),
    ...(fileExists ? { fileExists } : {}),
    ...(imageReadAny ? { imageReadAny } : {}),
    // 知识库引用 chip 只在壳具备 readDoc 能力时才可点（Web 端 bridge 为 null）。
    ...(knowledge ? { knowledge: { readDoc: vi.fn() } } : {}),
  } as unknown as DesktopBridge;
  const { container } = render(
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={chatMarkdownComponents({ onOpenFile, projectPath, bridge })}
      urlTransform={chatMarkdownUrlTransform}
    >
      {text}
    </Markdown>,
  );
  return { container, onOpenFile, openExternal };
}

describe("chatMarkdownComponents", () => {
  beforeEach(() => {
    // 外链点击/卡片改写全局 store(browserUrlRequest / rightOpen),逐用例复位避免串场。
    usePersonalStore.setState((s) => ({
      browserUrlRequest: undefined,
      // 复位浏览器控制偏好,避免「本地 URL 打开目标」用例间串场。
      generalSettings: { ...s.generalSettings, browserControl: undefined },
    }));
    useCortexUIStore.setState({ rightOpen: false });
  });
  afterEach(() => cleanup());

  it("inline code 为项目内路径 → .file-link,点击触发 onOpenFile", () => {
    const { container, onOpenFile } = renderMd("see `packages/core/x.ts` now");
    const el = container.querySelector("code.file-link");
    expect(el).not.toBeNull();
    fireEvent.click(el!);
    expect(onOpenFile).toHaveBeenCalledWith("packages/core/x.ts");
  });

  it("inline code 非路径 → 普通 code,不可点", () => {
    const { container, onOpenFile } = renderMd("call `const x` here");
    expect(container.querySelector("code.file-link")).toBeNull();
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    fireEvent.click(code!);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("inline code 为项目外绝对路径 → 不可点", () => {
    const { container, onOpenFile } = renderMd("read `/etc/passwd` file");
    expect(container.querySelector("code.file-link")).toBeNull();
    fireEvent.click(container.querySelector("code")!);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("markdown 相对链接 → 点击触发 onOpenFile,不触发 openExternal", () => {
    const { container, onOpenFile, openExternal } = renderMd("[doc](docs/a.md)");
    fireEvent.click(container.querySelector("a")!);
    expect(onOpenFile).toHaveBeenCalledWith("docs/a.md");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("历史 file:/// 链接 → 转为本机绝对路径后探测并点击", async () => {
    const abs = "/Users/mike/Documents/cortex/2026-07-23/outputs/report.html";
    const fileExists = vi.fn<(path: string) => Promise<boolean>>().mockResolvedValue(true);
    const { container, onOpenFile } = renderMd(`[outputs/report.html](file://${abs})`, { fileExists });
    await waitFor(() => expect(container.querySelector("a.file-link")).not.toBeNull());
    expect(fileExists).toHaveBeenCalledWith(abs);
    fireEvent.click(container.querySelector("a.file-link")!);
    expect(onOpenFile).toHaveBeenCalledWith(abs);
  });

  it("非本机 file host 仍被拒绝", () => {
    expect(chatMarkdownUrlTransform("file://remote-host/share/report.html")).toBe("");
  });

  // react-markdown 的安全协议白名单只含 http(s)/mailto/irc/xmpp，kb: 不特判就会被清成空 href，
  // 引用退化成不可点的普通链接——这是「链接点不开」的第二个根因。
  it("kb:// 引用不被 urlTransform 清空", () => {
    expect(chatMarkdownUrlTransform("kb://src-1/dir/a.md")).toBe("kb://src-1/dir/a.md");
  });

  it("kb:// 引用 → 可点 chip,点击写入 knowledgeDocRequest", () => {
    const { container } = renderMd("参考[制度.md](kb://src-1/制度/差旅报销.md)", { knowledge: true });
    const el = container.querySelector("a.file-link");
    expect(el).not.toBeNull();
    fireEvent.click(el!);
    const req = usePersonalStore.getState().knowledgeDocRequest;
    expect(req?.sourceId).toBe("src-1");
    expect(req?.relPath).toBe("制度/差旅报销.md");
    expect(usePersonalStore.getState().rightView).toBe("knowledge");
    // 右栏收起时只切 rightView 等于「点了没反应」——面板显示与否由 rightOpen 决定。
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });

  // 中键点击在 Electron 里走新窗口通路，绕过 onClick 的 preventDefault，
  // 系统会拿 kb: 去找处理程序然后失败。必须同样拦下并走右栏预览。
  it("中键点击 kb:// 引用不外泄给系统,同样进右栏预览", () => {
    const { container } = renderMd("参考[制度.md](kb://src-1/制度/差旅报销.md)", { knowledge: true });
    const el = container.querySelector("a.file-link")!;
    const ev = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(usePersonalStore.getState().knowledgeDocRequest?.relPath).toBe("制度/差旅报销.md");
  });

  // 文件名带空格是知识库文档的常态，链接经 normalizeKnowledgeLinks 归一后必须仍能解析出原始路径。
  it("含空格的 kb:// 引用经归一后可点,relPath 还原为带空格的原路径", () => {
    const raw = "[采集链路.md](kb://src-1/开发/DX0B511 采集与上报链路.md)";
    const { container } = renderMd(normalizeKnowledgeLinks(raw), { knowledge: true });
    const el = container.querySelector("a.file-link");
    expect(el).not.toBeNull();
    fireEvent.click(el!);
    expect(usePersonalStore.getState().knowledgeDocRequest?.relPath).toBe("开发/DX0B511 采集与上报链路.md");
  });

  it("markdown 外链 → 点击进内置浏览器(requestBrowserUrl + 展开右栏),不触发 openExternal / onOpenFile", () => {
    const { container, onOpenFile, openExternal } = renderMd("[site](https://x.com)");
    fireEvent.click(container.querySelector("a")!);
    expect(usePersonalStore.getState().browserUrlRequest?.url).toBe("https://x.com");
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("localUrlOpenTarget=system:本地链接点击走系统浏览器(openExternal),不进内置(U3)", () => {
    setLocalUrlTarget("system");
    const { container, openExternal } = renderMd("[local](http://localhost:3000)");
    fireEvent.click(container.querySelector("a")!);
    expect(openExternal).toHaveBeenCalledWith("http://localhost:3000");
    expect(usePersonalStore.getState().browserUrlRequest?.url).toBeUndefined();
  });

  it("localUrlOpenTarget=system:外链仍进内置(外链不受偏好影响)(U3)", () => {
    setLocalUrlTarget("system");
    const { container, openExternal } = renderMd("[site](https://x.com)");
    fireEvent.click(container.querySelector("a")!);
    expect(usePersonalStore.getState().browserUrlRequest?.url).toBe("https://x.com");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("外链段落下方渲染「网页预览」卡片,显示域名;点击主体进内置浏览器", () => {
    const { container } = renderMd("看看 [site](https://example.com/path)");
    const card = container.querySelector(".pw-link-preview-card");
    expect(card).not.toBeNull();
    expect(container.querySelector(".pw-link-preview-title")?.textContent).toBe("网页预览");
    expect(container.querySelector(".pw-link-preview-host")?.textContent).toBe("example.com");
    fireEvent.click(container.querySelector(".pw-link-preview-main")!);
    expect(usePersonalStore.getState().browserUrlRequest?.url).toBe("https://example.com/path");
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });

  it("GFM 裸 URL(autolink)也渲染卡片", () => {
    const { container } = renderMd("访问 https://foo.bar 即可");
    expect(container.querySelector(".pw-link-preview-card")).not.toBeNull();
    expect(container.querySelector(".pw-link-preview-host")?.textContent).toBe("foo.bar");
  });

  it("内联 code 形态的 URL(反引号包裹)→ 可点击进内置浏览器 + 段落下方卡片", () => {
    // 复现用户反馈:agent 输出 `http://localhost:3000`(反引号),GFM autolink 不进 code span。
    const { container } = renderMd("默认访问地址是: `http://localhost:3000`");
    const codeLink = container.querySelector("code.url-link");
    expect(codeLink).not.toBeNull();
    fireEvent.click(codeLink!);
    expect(usePersonalStore.getState().browserUrlRequest?.url).toBe("http://localhost:3000");
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
    // 段落下方仍渲染预览卡片,域名取 host(含端口)。
    expect(container.querySelector(".pw-link-preview-host")?.textContent).toBe("localhost:3000");
  });

  it("内联 code URL 键盘可达:Enter 进内置浏览器", () => {
    const { container } = renderMd("地址 `https://k.io/p`");
    const codeLink = container.querySelector("code.url-link")!;
    fireEvent.keyDown(codeLink, { key: "Enter" });
    expect(usePersonalStore.getState().browserUrlRequest?.url).toBe("https://k.io/p");
  });

  it("内联 code 非 URL(如 dev:web)仍是普通 code,不渲染卡片", () => {
    const { container } = renderMd("脚本 `dev:web` 启动");
    expect(container.querySelector("code.url-link")).toBeNull();
    expect(container.querySelector(".pw-link-preview-card")).toBeNull();
  });

  it("卡片「打开方式」下拉选系统浏览器 → 触发 openExternal", () => {
    const { container, openExternal } = renderMd("[site](https://x.com)");
    fireEvent.click(container.querySelector(".pw-link-preview-open")!);
    // 菜单经 createPortal 渲染到 document.body(脱离消息流避免遮挡),故从 document 查询而非 container。
    const items = document.querySelectorAll(".pw-link-preview-menu [role=menuitem]");
    expect(items.length).toBe(2);
    // 第二项为「系统浏览器」。
    fireEvent.click(items[1]!);
    expect(openExternal).toHaveBeenCalledWith("https://x.com");
  });

  it("同段落多外链各一张卡片,重复 URL 去重", () => {
    const { container } = renderMd("[a](https://a.com) 和 [b](https://b.com) 还有 [a2](https://a.com)");
    const cards = container.querySelectorAll(".pw-link-preview-card");
    expect(cards.length).toBe(2);
  });

  it("仅尾斜杠之差的同链只出一张卡片(回归:browser_navigate 后两张重复网页预览)", () => {
    // agent 把链接 href 归一成带尾斜杠,文本写不带斜杠 → 旧逻辑判成两条、渲染两张重复卡片。
    const { container } = renderMd("已成功导航到 [http://localhost:3000](http://localhost:3000/)");
    const cards = container.querySelectorAll(".pw-link-preview-card");
    expect(cards.length).toBe(1);
    expect(container.querySelector(".pw-link-preview-host")?.textContent).toBe("localhost:3000");
  });

  it("相对/项目文件链接不渲染卡片", () => {
    const { container } = renderMd("[doc](docs/a.md)");
    expect(container.querySelector(".pw-link-preview-card")).toBeNull();
  });

  it("键盘可达:.file-link 上 Enter / Space 触发 onOpenFile", () => {
    const { container, onOpenFile } = renderMd("`src/a.ts`");
    const el = container.querySelector("code.file-link")!;
    fireEvent.keyDown(el, { key: "Enter" });
    fireEvent.keyDown(el, { key: " " });
    expect(onOpenFile).toHaveBeenCalledTimes(2);
  });

  // 文件链接只显示文件名,完整路径进 title(悬停可见)——长绝对路径在气泡里换行刷屏的反馈。
  it("inline code 文件链接:只显示文件名,title 为完整路径,点击仍传原始 ref", () => {
    const { container, onOpenFile } = renderMd("see `packages/core/x.ts` now");
    const el = container.querySelector("code.file-link")!;
    expect(el.textContent).toBe("x.ts");
    expect(el.getAttribute("title")).toBe("packages/core/x.ts");
    fireEvent.click(el);
    expect(onOpenFile).toHaveBeenCalledWith("packages/core/x.ts");
  });

  it("退化普通 code(不可点)仍显示完整原文,不缩短", () => {
    const { container } = renderMd("read `/etc/passwd` file");
    expect(container.querySelector("code")!.textContent).toBe("/etc/passwd");
  });

  it("markdown 链接 label 即路径本身 → 显示文件名,title 为完整路径,点击仍传原始 ref", () => {
    const { container, onOpenFile } = renderMd("[docs/a.md](docs/a.md)");
    const a = container.querySelector("a.file-link")!;
    expect(a.textContent).toBe("a.md");
    expect(a.getAttribute("title")).toBe("docs/a.md");
    // 缩短形态挂 is-compact:CSS 用 inline-flex 把图标和文件名锁在同一行(Icon 自带 display:block)。
    expect(a.classList.contains("is-compact")).toBe(true);
    fireEvent.click(a);
    expect(onOpenFile).toHaveBeenCalledWith("docs/a.md");
  });

  it("markdown 链接自定义 label → 保留 label,不缩短,也不加 is-compact", () => {
    const { container } = renderMd("[审查报告](docs/a.md)");
    const a = container.querySelector("a.file-link")!;
    expect(a.textContent).toBe("审查报告");
    expect(a.classList.contains("is-compact")).toBe(false);
  });

  it("fileIconFor 按扩展名挑文件图标(行号后缀先剥掉)", () => {
    expect(fileIconFor("out/截图.png")).toBe(Icon.Image);
    expect(fileIconFor("report.html")).toBe(Icon.Globe);
    expect(fileIconFor("/data/月报.xlsx")).toBe(Icon.FileSheet);
    expect(fileIconFor("src/operate.c:158")).toBe(Icon.Code);
    // 办公文档按扩展名字形区分:Word→W、表格→X、演示→P、PDF→PDF;纯文本(md/txt)用横线文档。
    expect(fileIconFor("故障说明及致歉报告.docx")).toBe(Icon.FileWord);
    expect(fileIconFor("方案.ppt")).toBe(Icon.FileSlides);
    expect(fileIconFor("手册.pdf")).toBe(Icon.FilePdf);
    expect(fileIconFor("README.md")).toBe(Icon.FileText);
    expect(fileIconFor("noext")).toBe(Icon.File);
  });

  it("定位不到(目录/分支名/其它分支文件)→ 退化普通 code,不高亮不可点", async () => {
    const resolveProjectFile = vi.fn<(r: string, ref: string) => Promise<string | null>>().mockResolvedValue(null);
    const { container, onOpenFile } = renderMd("see `packages/core/gone.ts` now", { resolveProjectFile });
    await waitFor(() => expect(resolveProjectFile).toHaveBeenCalledWith("/proj", "packages/core/gone.ts"));
    // 不再有删除线(file-link-missing 已移除),也不再是可点的 file-link → 退化普通 inline code。
    expect(container.querySelector("code.file-link-missing")).toBeNull();
    expect(container.querySelector("code.file-link")).toBeNull();
    const el = container.querySelector("code")!;
    fireEvent.click(el);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("裸文件名能在项目内定位 → 高亮可点,点击仍传原始 ref", async () => {
    // 真实文件在子目录,resolveProjectFile 命中 → 命中后点亮为可点 file-link(回归本次反馈的核心 bug)。
    const resolveProjectFile = vi
      .fn<(r: string, ref: string) => Promise<string | null>>()
      .mockResolvedValue("/proj/outputs/docs/002.md");
    const { container, onOpenFile } = renderMd("见 `002.md` 文件", { resolveProjectFile });
    await waitFor(() => expect(container.querySelector("code.file-link")).not.toBeNull());
    expect(resolveProjectFile).toHaveBeenCalledWith("/proj", "002.md");
    fireEvent.click(container.querySelector("code.file-link")!);
    expect(onOpenFile).toHaveBeenCalledWith("002.md");
  });

  it("失效的 markdown 链接 → 退化普通链接,无高亮且点击不打开", async () => {
    const resolveProjectFile = vi.fn<(r: string, ref: string) => Promise<string | null>>().mockResolvedValue(null);
    const { container, onOpenFile } = renderMd("[doc](docs/gone.md)", { resolveProjectFile });
    await waitFor(() => expect(resolveProjectFile).toHaveBeenCalledWith("/proj", "docs/gone.md"));
    expect(container.querySelector("a.file-link-missing")).toBeNull();
    expect(container.querySelector("a.file-link")).toBeNull();
    fireEvent.click(container.querySelector("a")!);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("项目外绝对路径 docx 链接:fileExists 命中 → 可点 file-link,点击传原始 ref", async () => {
    const abs = "/Users/mike/outputs/report.docx";
    const fileExists = vi.fn<(p: string) => Promise<boolean>>().mockResolvedValue(true);
    const { container, onOpenFile } = renderMd(`见 [报告](${abs})`, { fileExists });
    await waitFor(() => expect(container.querySelector("a.file-link")).not.toBeNull());
    expect(fileExists).toHaveBeenCalledWith(abs);
    fireEvent.click(container.querySelector("a.file-link")!);
    expect(onOpenFile).toHaveBeenCalledWith(abs);
  });

  it("【死链修复】中文绝对路径链接被 remark percent-encode → 解码后再探测/点击,均用真实路径", async () => {
    const abs = "/Users/jingjing/work/team/周报/2026/【技术部周报】20260713.xlsx";
    const fileExists = vi.fn<(p: string) => Promise<boolean>>().mockResolvedValue(true);
    const { container, onOpenFile } = renderMd(`见 [周报](${abs})`, { fileExists });
    await waitFor(() => expect(container.querySelector("a.file-link")).not.toBeNull());
    // 关键断言:探测用的是解码后的真实路径,而非 %E5%91%A8… 编码串(编码串 stat 必失败 → 死链)。
    expect(fileExists).toHaveBeenCalledWith(abs);
    fireEvent.click(container.querySelector("a.file-link")!);
    expect(onOpenFile).toHaveBeenCalledWith(abs);
  });

  it("../outputs 相对爬出 docx(within=false):resolveProjectFile 落空 + fileExists 命中 → 可点", async () => {
    const resolveProjectFile = vi.fn<(r: string, ref: string) => Promise<string | null>>().mockResolvedValue(null);
    const fileExists = vi.fn<(p: string) => Promise<boolean>>().mockResolvedValue(true);
    const { container, onOpenFile } = renderMd("见 [报告](../outputs/report.docx)", { resolveProjectFile, fileExists });
    await waitFor(() => expect(container.querySelector("a.file-link")).not.toBeNull());
    // 爬出项目后拼出的绝对路径(/proj 的上级 outputs)。
    expect(fileExists).toHaveBeenCalledWith("/outputs/report.docx");
    fireEvent.click(container.querySelector("a.file-link")!);
    expect(onOpenFile).toHaveBeenCalledWith("../outputs/report.docx");
  });

  it("项目外绝对路径图片链接 → 内联渲染 <img>(经 imageReadAny 回读)", async () => {
    const abs = "/Users/mike/.codex/generated_images/x/ig_a.png";
    const imageReadAny = vi
      .fn<(p: string) => Promise<{ dataUrl: string }>>()
      .mockResolvedValue({ dataUrl: "data:image/png;base64,AAA" });
    const { container } = renderMd(`图片已生成: [ig_a.png](${abs})`, { imageReadAny });
    await waitFor(() => expect(container.querySelector("img.chat-inline-img")).not.toBeNull());
    expect(imageReadAny).toHaveBeenCalledWith(abs);
    expect(container.querySelector("img.chat-inline-img")!.getAttribute("src")).toBe("data:image/png;base64,AAA");
  });

  it("img 语法 `![]()` 的本地图片 → 同样内联渲染", async () => {
    const imageReadAny = vi
      .fn<(p: string) => Promise<{ dataUrl: string }>>()
      .mockResolvedValue({ dataUrl: "data:image/png;base64,BBB" });
    const { container } = renderMd("![封面](/abs/cover.png)", { imageReadAny });
    await waitFor(() => expect(container.querySelector("img.chat-inline-img")).not.toBeNull());
    expect(imageReadAny).toHaveBeenCalledWith("/abs/cover.png");
  });

  it("imageReadAny 失败 → 降级为可点击文件链接", async () => {
    const imageReadAny = vi.fn<(p: string) => Promise<{ dataUrl: string }>>().mockRejectedValue(new Error("denied"));
    const { container, onOpenFile } = renderMd("[ig.png](/abs/ig.png)", { imageReadAny });
    await waitFor(() => expect(container.querySelector("a.file-link")).not.toBeNull());
    expect(container.querySelector("img.chat-inline-img")).toBeNull();
    fireEvent.click(container.querySelector("a.file-link")!);
    expect(onOpenFile).toHaveBeenCalledWith("/abs/ig.png");
  });

  it("点击内联图片 → 弹出灯箱(portal 到 body),Esc 关闭", async () => {
    const imageReadAny = vi
      .fn<(p: string) => Promise<{ dataUrl: string }>>()
      .mockResolvedValue({ dataUrl: "data:image/png;base64,CCC" });
    const { container } = renderMd("[ig.png](/abs/ig.png)", { imageReadAny });
    await waitFor(() => expect(container.querySelector("img.chat-inline-img")).not.toBeNull());
    fireEvent.click(container.querySelector("img.chat-inline-img")!);
    expect(document.querySelector(".img-lightbox")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".img-lightbox")).toBeNull());
  });

  it("远程图床图片(http)→ 不经 imageReadAny,走默认 img / 链接", async () => {
    const imageReadAny = vi.fn<(p: string) => Promise<{ dataUrl: string }>>();
    const { container } = renderMd("![远程](https://cdn.x.com/a.png)", { imageReadAny });
    expect(container.querySelector("img.chat-inline-img")).toBeNull();
    expect(imageReadAny).not.toHaveBeenCalled();
  });

  it("fenced 代码块含本地 .html 路径 → 代码块下方渲染「预览网页」按钮,点击授权", async () => {
    const browserResolveLocalHtml = vi
      .fn<(p: string) => Promise<string | null>>()
      .mockResolvedValue("file:///Users/mike/Documents/cortex/2026-06-20/hangzhou-weather-today.html");
    const onOpenFile = vi.fn<(ref: string) => void>();
    const bridge = { browserResolveLocalHtml } as unknown as DesktopBridge;
    // 两行 open 命令的 fenced 代码块(复现用户场景)。
    const md = [
      "```",
      "open /Users/mike/Documents/cortex/2026-06-20/hangzhou-weather-today.html",
      "open /Users/mike/Documents/cortex/2026-06-20/shanghai-weather-today.html",
      "```",
    ].join("\n");
    const { container } = render(
      <Markdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents({ onOpenFile, projectPath: "/proj", bridge })}>
        {md}
      </Markdown>,
    );
    const btn = container.querySelector("button.pw-html-preview-btn");
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(browserResolveLocalHtml).toHaveBeenCalledWith(
      "/Users/mike/Documents/cortex/2026-06-20/hangzhou-weather-today.html",
    );
  });

  it("fenced 代码块无本地 .html 路径 → 不渲染预览按钮", () => {
    const md = ["```bash", "npm run build", "```"].join("\n");
    const { container } = renderMd(md);
    expect(container.querySelector("button.pw-html-preview-btn")).toBeNull();
  });

  it("无项目会话(projectPath 空):预览按钮仍渲染,但内联裸路径不当项目文件链接", () => {
    const browserResolveLocalHtml = vi
      .fn<(p: string) => Promise<string | null>>()
      .mockResolvedValue("file:///Users/mike/Documents/cortex/2026-06-20/shanghai-weather-night.html");
    const onOpenFile = vi.fn<(ref: string) => void>();
    const bridge = { browserResolveLocalHtml } as unknown as DesktopBridge;
    const md = [
      "见 `shanghai-weather-night.html`",
      "```",
      "open /Users/mike/Documents/cortex/2026-06-20/shanghai-weather-night.html",
      "```",
    ].join("\n");
    const { container } = render(
      <Markdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents({ onOpenFile, projectPath: "", bridge })}>
        {md}
      </Markdown>,
    );
    // 预览按钮渲染(不依赖 projectPath)。
    expect(container.querySelector("button.pw-html-preview-btn")).not.toBeNull();
    // 空 projectPath 下内联裸文件名不被当作可点项目文件链接(防空根误判 within)。
    expect(container.querySelector("code.file-link")).toBeNull();
  });
});

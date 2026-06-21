import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DesktopBridge } from "@cortex-work/core";
import { useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import { chatMarkdownComponents } from "./chatMarkdown";

function renderMd(
  text: string,
  opts: { projectPath?: string; resolveProjectFile?: (root: string, ref: string) => Promise<string | null> } = {},
) {
  const { projectPath = "/proj", resolveProjectFile } = opts;
  const onOpenFile = vi.fn<(ref: string) => void>();
  const openExternal = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
  const bridge = {
    openExternal,
    ...(resolveProjectFile ? { resolveProjectFile } : {}),
  } as unknown as DesktopBridge;
  const { container } = render(
    <Markdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents({ onOpenFile, projectPath, bridge })}>
      {text}
    </Markdown>,
  );
  return { container, onOpenFile, openExternal };
}

describe("chatMarkdownComponents", () => {
  beforeEach(() => {
    // 外链点击/卡片改写全局 store(browserUrlRequest / rightOpen),逐用例复位避免串场。
    usePersonalStore.setState({ browserUrlRequest: undefined });
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

  it("markdown 外链 → 点击进内置浏览器(requestBrowserUrl + 展开右栏),不触发 openExternal / onOpenFile", () => {
    const { container, onOpenFile, openExternal } = renderMd("[site](https://x.com)");
    fireEvent.click(container.querySelector("a")!);
    expect(usePersonalStore.getState().browserUrlRequest?.url).toBe("https://x.com");
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
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

  it("卡片「打开方式」下拉选系统浏览器 → 触发 openExternal", () => {
    const { container, openExternal } = renderMd("[site](https://x.com)");
    fireEvent.click(container.querySelector(".pw-link-preview-open")!);
    const items = container.querySelectorAll(".pw-link-preview-menu [role=menuitem]");
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

  it("定位不到(真已删除)→ 标 .file-link-missing 且点击不打开", async () => {
    const resolveProjectFile = vi.fn<(r: string, ref: string) => Promise<string | null>>().mockResolvedValue(null);
    const { container, onOpenFile } = renderMd("see `packages/core/gone.ts` now", { resolveProjectFile });
    await waitFor(() => expect(container.querySelector("code.file-link-missing")).not.toBeNull());
    expect(resolveProjectFile).toHaveBeenCalledWith("/proj", "packages/core/gone.ts");
    const el = container.querySelector("code.file-link-missing")!;
    expect(el.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(el);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("裸文件名能在项目内定位 → 不标 missing,点击仍传原始 ref", async () => {
    // 真实文件在子目录,resolveProjectFile 命中 → 可点击(回归本次反馈的核心 bug)。
    const resolveProjectFile = vi
      .fn<(r: string, ref: string) => Promise<string | null>>()
      .mockResolvedValue("/proj/outputs/docs/002.md");
    const { container, onOpenFile } = renderMd("见 `002.md` 文件", { resolveProjectFile });
    await waitFor(() => expect(resolveProjectFile).toHaveBeenCalledWith("/proj", "002.md"));
    expect(container.querySelector("code.file-link-missing")).toBeNull();
    fireEvent.click(container.querySelector("code.file-link")!);
    expect(onOpenFile).toHaveBeenCalledWith("002.md");
  });

  it("失效的 markdown 链接 → 标 missing 且点击不打开", async () => {
    const resolveProjectFile = vi.fn<(r: string, ref: string) => Promise<string | null>>().mockResolvedValue(null);
    const { container, onOpenFile } = renderMd("[doc](docs/gone.md)", { resolveProjectFile });
    await waitFor(() => expect(container.querySelector("a.file-link-missing")).not.toBeNull());
    fireEvent.click(container.querySelector("a")!);
    expect(onOpenFile).not.toHaveBeenCalled();
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

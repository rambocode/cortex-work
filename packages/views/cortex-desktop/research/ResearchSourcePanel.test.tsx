// 引用详情面板的受控组件测试。
//
// 面板已改为纯展示：fetch、「按需加载」契约与缓存都上移到了 useResearchSessionDetail
// （那些守卫见 ResearchArtifactPanel.test.tsx 的引用联动一组）。
// 这里只守渲染分支：正常详情 / chunk 缺失降级 / loading / error+重试 / 关闭。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchSourcePanel, type ResearchSourcePanelProps } from "./ResearchSourcePanel";
import { makeChunk, makeDocument } from "./testFixtures";

afterEach(() => cleanup());

/// 聚焦的引用（编号 + chunkId + 标题/URL 兜底信息）。
const citation = {
  index: 1,
  chunkId: "ch1",
  title: "Tokio 教程",
  url: "https://tokio.rs/tokio/tutorial",
};

/// 与该引用配对的 evidence：d1 文档 + 带标题路径的 ch1 片段。
const evidence = {
  documents: [makeDocument()],
  chunks: [makeChunk({ headingPath: ["调度", "工作窃取"] })],
};

/// 以最小骨架渲染面板，只覆盖当前用例关心的 props。
function renderPanel(patch: Partial<ResearchSourcePanelProps> = {}) {
  const props: ResearchSourcePanelProps = {
    citation,
    evidence,
    loading: false,
    error: null,
    onRetry: () => {},
    onClose: () => {},
    ...patch,
  };
  return render(<ResearchSourcePanel {...props} />);
}

describe("ResearchSourcePanel 引用详情", () => {
  it("渲染聚焦引用的编号、来源信息（域名 / 抓取方式）与证据正文", () => {
    const { container } = renderPanel();
    expect(container.querySelector(".pw-res-sources-title")?.textContent).toBe("[1] Tokio 教程");
    expect(screen.getByText("tokio.rs")).toBeTruthy();
    expect(screen.getByText("直接抓取")).toBeTruthy();
    expect(screen.getByText("调度 › 工作窃取")).toBeTruthy();
    expect(screen.getByText("Tokio 使用工作窃取调度器。")).toBeTruthy();
  });

  /// 报告重生成后旧聚焦可能指向已被移除的证据：降级展示兜底信息，而不是空白或崩溃。
  it("evidence 里找不到对应 chunk 时降级为标题 / URL + 未找到提示", () => {
    renderPanel({ citation: { ...citation, chunkId: "ch-gone" } });
    expect(screen.getByText(/未找到对应证据片段/)).toBeTruthy();
    expect(screen.getByText("https://tokio.rs/tokio/tutorial")).toBeTruthy();
  });

  it("loading 时显示加载中，不渲染正文", () => {
    renderPanel({ evidence: null, loading: true });
    expect(screen.getByText("加载中…")).toBeTruthy();
    expect(screen.queryByText("Tokio 使用工作窃取调度器。")).toBeNull();
  });

  it("error 时显示错误文案，点击重试触发 onRetry", () => {
    let retries = 0;
    renderPanel({
      evidence: null,
      error: "加载来源失败：读取证据失败",
      onRetry: () => (retries += 1),
    });
    expect(screen.getByText("加载来源失败：读取证据失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retries).toBe(1);
  });

  it("点击关闭触发 onClose", () => {
    let closes = 0;
    renderPanel({ onClose: () => (closes += 1) });
    fireEvent.click(screen.getByRole("button", { name: "关闭引用详情" }));
    expect(closes).toBe(1);
  });
});

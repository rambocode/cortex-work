import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ResearchDetailLevel } from "@cortex-work/core/research/types";
import type { ResearchBridgeLike } from "./bridge-like";
import { ResearchSourcePanel } from "./ResearchSourcePanel";
import { makeChunk, makeDocument, makeSummary } from "./testFixtures";

afterEach(() => cleanup());

/// 手写 bridge 替身：记录 get 的 (sessionId, detail) 序列，这就是「按需加载」的契约断言点。
function makeBridge() {
  const getCalls: Array<[string, ResearchDetailLevel]> = [];
  const bridge: ResearchBridgeLike = {
    async create() {
      throw new Error("不应被调用");
    },
    async rerun(): Promise<never> {
      throw new Error("本用例不该重跑");
    },
    async run() {},
    async pause() {},
    async resume() {},
    async cancel() {},
    async get(sessionId, detail) {
      getCalls.push([sessionId, detail]);
      return {
        summary: makeSummary({ sessionId, documentCount: 2, chunkCount: 1 }),
        documents: [
          makeDocument(),
          makeDocument({
            documentId: "d2",
            title: "async-std 文档",
            fetchMethod: "browser",
            fetchedAt: "2026-07-25T02:40:00.000Z",
            source: {
              sourceType: "documentation",
              trustZone: "public_web",
              locator: "https://docs.rs/async-std",
              domain: "docs.rs",
            },
          }),
        ],
        chunks: [makeChunk()],
      };
    },
    async list() {
      return [];
    },
    async delete() {},
    onEvent() {
      return () => {};
    },
  };
  return { bridge, getCalls };
}

describe("ResearchSourcePanel 按需加载", () => {
  it("挂载时不调用 get(_, 'evidence')（spec §16：证据只在显式打开来源面板时才返回）", () => {
    const { bridge, getCalls } = makeBridge();
    render(
      <ResearchSourcePanel bridge={bridge} session={makeSummary({ documentCount: 2 })} />,
    );
    expect(getCalls).toEqual([]);
    expect(screen.getByText("证据正文按需加载，展开后才会读取抓取内容")).toBeTruthy();
  });

  it("点击「展开来源」后才拉 evidence，并渲染域名 / 标题 / 抓取方式 / 时间", async () => {
    const { bridge, getCalls } = makeBridge();
    render(
      <ResearchSourcePanel bridge={bridge} session={makeSummary({ sessionId: "s7", documentCount: 2 })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "展开来源（2）" }));
    await waitFor(() => expect(getCalls).toEqual([["s7", "evidence"]]));

    expect(await screen.findByText("Tokio 教程")).toBeTruthy();
    expect(screen.getByText("tokio.rs")).toBeTruthy();
    expect(screen.getByText("docs.rs")).toBeTruthy();
    expect(screen.getByText("直接抓取")).toBeTruthy();
    expect(screen.getByText("浏览器抓取")).toBeTruthy();
  });

  it("展开单条来源才显示其证据正文，且不再重复请求 evidence", async () => {
    const { bridge, getCalls } = makeBridge();
    render(<ResearchSourcePanel bridge={bridge} session={makeSummary({ documentCount: 2 })} />);
    fireEvent.click(screen.getByRole("button", { name: "展开来源（2）" }));
    await screen.findByText("Tokio 教程");

    expect(screen.queryByText("Tokio 使用工作窃取调度器。")).toBeNull();
    fireEvent.click(screen.getByText("Tokio 教程"));
    expect(await screen.findByText("Tokio 使用工作窃取调度器。")).toBeTruthy();
    expect(getCalls).toHaveLength(1);
  });

  it("切换会话会收起面板，新会话仍不预取", async () => {
    const { bridge, getCalls } = makeBridge();
    const { rerender } = render(
      <ResearchSourcePanel bridge={bridge} session={makeSummary({ sessionId: "s1", documentCount: 2 })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "展开来源（2）" }));
    await screen.findByText("Tokio 教程");

    rerender(
      <ResearchSourcePanel bridge={bridge} session={makeSummary({ sessionId: "s2", documentCount: 5 })} />,
    );
    expect(getCalls).toHaveLength(1);
    expect(screen.getByRole("button", { name: "展开来源（5）" })).toBeTruthy();
  });

  it("bridge 为 null 时展示降级提示且展开按钮禁用", () => {
    render(<ResearchSourcePanel bridge={null} session={makeSummary({ documentCount: 2 })} />);
    expect(screen.getByRole("button", { name: "展开来源（2）" })).toBeDisabled();
  });

  it("加载失败时展示错误，可重试", async () => {
    const { bridge } = makeBridge();
    let attempts = 0;
    const flaky: ResearchBridgeLike = {
      ...bridge,
      async get(sessionId, detail) {
        attempts += 1;
        if (attempts === 1) throw new Error("读取证据失败");
        return bridge.get(sessionId, detail);
      },
    };
    render(<ResearchSourcePanel bridge={flaky} session={makeSummary({ documentCount: 2 })} />);
    fireEvent.click(screen.getByRole("button", { name: "展开来源（2）" }));
    expect(await screen.findByText("加载来源失败：读取证据失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("Tokio 教程")).toBeTruthy();
  });
});

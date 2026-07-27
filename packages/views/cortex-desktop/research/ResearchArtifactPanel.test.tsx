import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResearchUiStore } from "@cortex-work/core/research/ui-store";
import type { ConversationResearchRef } from "@cortex-work/core";
import type {
  ResearchDetailLevel,
  ResearchEvent,
  ResearchSessionSummary,
} from "@cortex-work/core/research/types";
import type { ResearchBridgeLike } from "./bridge-like";
import { ResearchArtifactPanel } from "./ResearchArtifactPanel";
import { makeChunk, makeDocument, makeFullView, makeReport, makeSummary } from "./testFixtures";

beforeEach(() => useResearchUiStore.getState().reset());
afterEach(() => cleanup());

/// 手写 bridge 替身：记录 get 调用（sessionId + 级别）与订阅，暴露 emit 手动推事件。
/// full 返回带两条引用（ch1/ch2）的报告，evidence 返回配对的 documents + chunks。
function makeBridge() {
  const state = {
    getCalls: [] as Array<[string, ResearchDetailLevel]>,
    listeners: [] as Array<(e: ResearchEvent) => void>,
    unsubscribeCalls: 0,
  };
  const bridge: ResearchBridgeLike = {
    async create(request) {
      return makeSummary({ sessionId: "new-1", objective: request.objective });
    },
    async rerun(): Promise<never> {
      throw new Error("本用例不该重跑");
    },
    async regenerateReport(): Promise<never> {
      throw new Error("本用例不该重新生成报告");
    },
    async run() {},
    async pause() {},
    async resume() {},
    async cancel() {},
    async get(sessionId, detail) {
      state.getCalls.push([sessionId, detail]);
      if (detail === "evidence") {
        return {
          summary: makeSummary({ sessionId }),
          documents: [makeDocument()],
          chunks: [makeChunk()],
        };
      }
      return makeFullView({
        summary: makeSummary({ sessionId, status: "completed" }),
        report: makeReport({
          markdown: "Tokio 是当前最主流的选择[^ch1]（来源：Tokio 教程）。",
          citations: [
            {
              chunkId: "ch1",
              documentId: "d1",
              title: "Tokio 教程",
              url: "https://tokio.rs/tokio/tutorial",
              retrievedAt: "2026-07-25T02:30:00.000Z",
              textHash: "th1",
            },
          ],
        }),
      });
    },
    async list() {
      return [];
    },
    async delete() {},
    onEvent(listener) {
      state.listeners.push(listener);
      return () => {
        state.unsubscribeCalls += 1;
        const index = state.listeners.indexOf(listener);
        if (index >= 0) state.listeners.splice(index, 1);
      };
    },
  };
  const emit = (event: ResearchEvent) => state.listeners.slice().forEach((l) => l(event));
  return { bridge, state, emit };
}

function makeRef(sessionId: string, objective: string): ConversationResearchRef {
  return { sessionId, objective, createdAt: 1 };
}

/// 把会话灌进 ui-store（真实场景由常驻的 useResearchLiveSync 灌入）。
function seed(sessions: ResearchSessionSummary[]): void {
  useResearchUiStore.getState().setSessions(sessions);
}

describe("ResearchArtifactPanel 空态", () => {
  it("没有绑定研究时给引导文案，且不发任何请求", () => {
    const { bridge, state } = makeBridge();
    render(
      <ResearchArtifactPanel bridge={bridge} sessionId={null} refs={[]} onSelect={() => {}} />,
    );
    expect(screen.getByText(/还没有深度研究/)).toBeTruthy();
    expect(state.getCalls).toEqual([]);
  });

  it("bridge 为 null（Web 端）时降级展示，不崩", () => {
    render(
      <ResearchArtifactPanel bridge={null} sessionId={null} refs={[]} onSelect={() => {}} />,
    );
    expect(screen.getByText(/只在桌面端可用/)).toBeTruthy();
  });
});

describe("ResearchArtifactPanel 详情拉取", () => {
  it("挂载时只拉一次 full（证据正文只在用户点引用后才拉，spec §16）", async () => {
    const { bridge, state } = makeBridge();
    seed([makeSummary({ sessionId: "r1", objective: "调查 A" })]);
    render(
      <ResearchArtifactPanel
        bridge={bridge}
        sessionId="r1"
        refs={[makeRef("r1", "调查 A")]}
        onSelect={() => {}}
      />,
    );
    await waitFor(() => expect(state.getCalls).toEqual([["r1", "full"]]));
    expect(state.getCalls.some(([, detail]) => detail === "evidence")).toBe(false);
  });

  // 风险点 1：applyEvent 的 report_delta 是增量拼接、activity 是环形追加，都不幂等。
  // 常驻的 useResearchLiveSync 已经扇出过一次，面板再扇一次报告正文就会翻倍。
  it("绝不调用 ui-store.applyEvent（那是常驻 live-sync 的独占职责）", async () => {
    const applyEvent = vi.fn();
    const real = useResearchUiStore.getState().applyEvent;
    useResearchUiStore.setState({ applyEvent });
    try {
      const { bridge, state, emit } = makeBridge();
      seed([makeSummary({ sessionId: "r1", objective: "调查 A" })]);
      render(
        <ResearchArtifactPanel
          bridge={bridge}
          sessionId="r1"
          refs={[makeRef("r1", "调查 A")]}
          onSelect={() => {}}
        />,
      );
      await waitFor(() => expect(state.getCalls).toHaveLength(1));

      emit({ type: "report_delta", sessionId: "r1", delta: "半句" });
      emit({ type: "stage", sessionId: "r1", stage: "searching" });
      emit({ type: "round", sessionId: "r1", roundIndex: 0 });
      expect(applyEvent).not.toHaveBeenCalled();
    } finally {
      useResearchUiStore.setState({ applyEvent: real });
    }
  });

  it("同一批连续事件只触发一次重新拉取（防抖，别把 SQLite 打穿）", async () => {
    const { bridge, state, emit } = makeBridge();
    seed([makeSummary({ sessionId: "r1", objective: "调查 A" })]);
    render(
      <ResearchArtifactPanel
        bridge={bridge}
        sessionId="r1"
        refs={[makeRef("r1", "调查 A")]}
        onSelect={() => {}}
      />,
    );
    await waitFor(() => expect(state.getCalls).toHaveLength(1));

    for (let i = 0; i < 5; i += 1) emit({ type: "round", sessionId: "r1", roundIndex: i });
    await waitFor(() => expect(state.getCalls).toHaveLength(2), { timeout: 3000 });
    expect(state.getCalls).toHaveLength(2);
    expect(state.getCalls.every(([, detail]) => detail === "full")).toBe(true);
  });

  it("别的会话的事件不触发本会话重拉（后台还有别的研究在跑）", async () => {
    const { bridge, state, emit } = makeBridge();
    seed([makeSummary({ sessionId: "r1", objective: "调查 A" })]);
    render(
      <ResearchArtifactPanel
        bridge={bridge}
        sessionId="r1"
        refs={[makeRef("r1", "调查 A")]}
        onSelect={() => {}}
      />,
    );
    await waitFor(() => expect(state.getCalls).toHaveLength(1));

    emit({ type: "round", sessionId: "other", roundIndex: 0 });
    await new Promise((r) => setTimeout(r, 800));
    expect(state.getCalls).toHaveLength(1);
  });

  it("卸载时退订，避免反复开合右栏累积监听器", async () => {
    const { bridge, state } = makeBridge();
    seed([makeSummary({ sessionId: "r1", objective: "调查 A" })]);
    const { unmount } = render(
      <ResearchArtifactPanel
        bridge={bridge}
        sessionId="r1"
        refs={[makeRef("r1", "调查 A")]}
        onSelect={() => {}}
      />,
    );
    await waitFor(() => expect(state.getCalls).toHaveLength(1));
    unmount();
    expect(state.unsubscribeCalls).toBe(1);
  });
});

describe("ResearchArtifactPanel 引用详情", () => {
  /// 渲染面板并等报告里的引用 chip 出现。
  async function renderWithReport() {
    const made = makeBridge();
    seed([makeSummary({ sessionId: "r1", objective: "调查 A", status: "completed" })]);
    const view = render(
      <ResearchArtifactPanel
        bridge={made.bridge}
        sessionId="r1"
        refs={[makeRef("r1", "调查 A")]}
        onSelect={() => {}}
      />,
    );
    await screen.findAllByText("[1]");
    return { ...made, ...view };
  }

  it("点击引用 chip 展开面板内抽屉，evidence 恰拉一次；再点仍只有一次", async () => {
    const { state, container } = await renderWithReport();
    const chip = container.querySelector("a.pw-res-cite")!;
    fireEvent.click(chip);

    expect(await screen.findByText("Tokio 使用工作窃取调度器。")).toBeTruthy();
    // 抽屉在面板内绝对定位，不另开一栏（右栏本身就很窄）。
    expect(container.querySelector(".pw-research-panel-source")).not.toBeNull();
    expect(state.getCalls.filter(([, d]) => d === "evidence")).toEqual([["r1", "evidence"]]);

    fireEvent.click(screen.getByRole("button", { name: "关闭引用详情" }));
    fireEvent.click(container.querySelector("a.pw-res-cite")!);
    await screen.findByText("Tokio 使用工作窃取调度器。");
    expect(state.getCalls.filter(([, d]) => d === "evidence")).toHaveLength(1);
  });
});

describe("ResearchArtifactPanel 全部研究抽屉", () => {
  it("默认收起；展开后列出 ui-store 全量研究，且没有「新建研究」入口", async () => {
    const { bridge } = makeBridge();
    seed([
      makeSummary({ sessionId: "r1", objective: "调查 A" }),
      makeSummary({ sessionId: "r2", objective: "调查 B" }),
    ]);
    const { container } = render(
      <ResearchArtifactPanel
        bridge={bridge}
        sessionId="r1"
        refs={[makeRef("r1", "调查 A")]}
        onSelect={() => {}}
      />,
    );
    expect(container.querySelector(".pw-research-panel-drawer")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /全部研究/ }));
    expect(container.querySelector(".pw-research-panel-drawer")).not.toBeNull();
    expect(screen.getByText("调查 B")).toBeTruthy();
    // 面板里发起研究的入口是输入框的 /skill:research，不是这里再开一个表单。
    expect(screen.queryByRole("button", { name: "新建研究" })).toBeNull();
  });

  // D6：选中不属于本会话的研究只切展示，绝不写回会话的归属列表——
  // 那会把「看过」误记成「本会话发起过」，会话流里凭空多出一张卡片。
  it("在抽屉里选中另一条研究：只回调 onSelect，不改 refs", async () => {
    const { bridge } = makeBridge();
    seed([
      makeSummary({ sessionId: "r1", objective: "调查 A" }),
      makeSummary({ sessionId: "r2", objective: "调查 B" }),
    ]);
    const refs = [makeRef("r1", "调查 A")];
    const onSelect = vi.fn();
    render(
      <ResearchArtifactPanel
        bridge={bridge}
        sessionId="r1"
        refs={refs}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /全部研究/ }));
    fireEvent.click(screen.getByText("调查 B"));

    expect(onSelect).toHaveBeenCalledWith("r2");
    expect(refs).toEqual([makeRef("r1", "调查 A")]);
  });
});

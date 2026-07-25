import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ResearchSessionSummary } from "@cortex-work/core/research/types";
import { ResearchSessionList } from "./ResearchSessionList";
import { makeSummary } from "./testFixtures";

afterEach(() => cleanup());

function noop() {}

describe("ResearchSessionList", () => {
  it("渲染中文状态徽标与目标，选中项带 is-active", () => {
    render(
      <ResearchSessionList
        sessions={[
          makeSummary({ sessionId: "s1", status: "searching", objective: "调查 A" }),
          makeSummary({ sessionId: "s2", status: "completed", objective: "调查 B" }),
        ]}
        activeSessionId="s2"
        onSelect={noop}
        onCreate={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText("检索中")).toBeTruthy();
    expect(screen.getByText("已完成")).toBeTruthy();
    const active = screen.getByText("调查 B").closest(".pw-res-item");
    expect(active?.className).toContain("is-active");
  });

  it("点击行 → onSelect；点击新建 → onCreate；点击删除 → onDelete 且不冒泡到选中", () => {
    const selected: string[] = [];
    const deleted: string[] = [];
    let created = 0;
    render(
      <ResearchSessionList
        sessions={[makeSummary({ sessionId: "s1" })]}
        activeSessionId={null}
        onSelect={(id) => selected.push(id)}
        onCreate={() => (created += 1)}
        onDelete={(id) => deleted.push(id)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "新建研究" }));
    expect(created).toBe(1);

    fireEvent.click(screen.getByText("调查 Rust 异步运行时的现状"));
    expect(selected).toEqual(["s1"]);

    fireEvent.click(screen.getByRole("button", { name: "删除研究" }));
    expect(deleted).toEqual(["s1"]);
    // 删除按钮点击不得同时触发选中（stopPropagation）。
    expect(selected).toEqual(["s1"]);
  });

  it("空列表渲染空态提示", () => {
    render(
      <ResearchSessionList
        sessions={[]}
        activeSessionId={null}
        onSelect={noop}
        onCreate={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText("尚无研究记录，点上方「新建研究」开始")).toBeTruthy();
  });

  // 隐私红线（spec §19.3.2）：列表渲染路径绝不读正文字段。
  // 用会抛错的 getter 埋雷——一旦有人在列表里 render 了 chunk.text / document.contentRef，
  // 这个测试立刻炸，而不是等到线上把正文泄进日志。
  it("渲染路径不读取任何正文字段（text / contentRef 埋雷 getter 未被触发）", () => {
    const trapped = makeSummary({ sessionId: "s1", status: "fetching" }) as ResearchSessionSummary &
      Record<string, unknown>;
    let touched = false;
    Object.defineProperty(trapped, "text", {
      enumerable: true,
      get() {
        touched = true;
        throw new Error("列表不得读取正文 text");
      },
    });
    Object.defineProperty(trapped, "contentRef", {
      enumerable: true,
      get() {
        touched = true;
        throw new Error("列表不得读取 contentRef");
      },
    });

    expect(() =>
      render(
        <ResearchSessionList
          sessions={[trapped]}
          activeSessionId="s1"
          onSelect={noop}
          onCreate={noop}
          onDelete={noop}
        />,
      ),
    ).not.toThrow();
    expect(touched).toBe(false);
  });
});

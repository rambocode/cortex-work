// PiArtifactsPanel 组件测试(jsdom):pill 切换 / 激活缺省落最新 / markdown 与文本视图 / 空态。
// HTML 沙箱的脚本执行 jsdom 测不了,由端到端冒烟覆盖。

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePersonalStore } from "@cortex-work/core";
import { usePiArtifactsStore } from "@cortex-work/core/store/piArtifacts";

import { PiArtifactsPanel } from "./PiArtifactsPanel";

function seed(sessionId: string, files: Array<{ filename: string; content: string }>): void {
  const st = usePiArtifactsStore.getState();
  for (const f of files) {
    st.applyEvent(sessionId, { type: "artifact", action: "create", filename: f.filename, content: f.content });
  }
}

describe("PiArtifactsPanel", () => {
  beforeEach(() => {
    usePiArtifactsStore.setState({ sessions: {}, openReq: undefined });
    usePersonalStore.setState({ activeSessionId: "s1" });
  });

  it("无产物时渲染空态", () => {
    render(<PiArtifactsPanel />);
    expect(screen.getByText("本会话还没有产物")).toBeTruthy();
  });

  it("单产物不出 pill 栏;markdown 产物走 MarkdownView 渲染", () => {
    seed("s1", [{ filename: "notes.md", content: "# 标题甲" }]);
    render(<PiArtifactsPanel />);
    expect(screen.getByText("标题甲")).toBeTruthy();
    expect(document.querySelector(".pw-pa-pills")).toBeNull();
  });

  it("多产物出 pill 栏,激活项缺省落最新;点击 pill 切换", () => {
    seed("s1", [
      { filename: "a.txt", content: "甲内容" },
      { filename: "b.txt", content: "乙内容" },
    ]);
    render(<PiArtifactsPanel />);
    // 缺省显示最新创建的 b.txt。
    expect(screen.getByText("乙内容")).toBeTruthy();
    fireEvent.click(screen.getByText("a.txt"));
    expect(screen.getByText("甲内容")).toBeTruthy();
    expect(document.querySelector(".pw-pa-pill.is-active")?.textContent).toContain("a.txt");
  });

  it("update 后 pill 显示版本徽标;会话隔离(别的会话产物不串台)", () => {
    seed("s1", [
      { filename: "x.txt", content: "v1" },
      { filename: "y.txt", content: "另一个" },
    ]);
    usePiArtifactsStore
      .getState()
      .applyEvent("s1", { type: "artifact", action: "update", filename: "x.txt", content: "v2" });
    seed("s2", [{ filename: "other.txt", content: "不该出现" }]);
    render(<PiArtifactsPanel />);
    fireEvent.click(screen.getByText("x.txt"));
    expect(screen.getByText("v2", { selector: ".pw-pa-pre" })).toBeTruthy();
    expect(screen.getByText("v2", { selector: ".pw-pa-pill-ver" })).toBeTruthy();
    expect(screen.queryByText("other.txt")).toBeNull();
  });

  it("SVG 产物进无脚本沙箱 iframe(sandbox 属性为空)", () => {
    seed("s1", [{ filename: "chart.svg", content: "<svg><circle r='5'/></svg>" }]);
    render(<PiArtifactsPanel />);
    const iframe = screen.getByTitle("chart.svg");
    expect(iframe.getAttribute("sandbox")).toBe("");
    expect(iframe.getAttribute("srcdoc")).toContain("<circle");
  });
});

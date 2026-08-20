import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, SessionMeta } from "@cortex-work/core";

import { SessionList } from "./PersonalSidebar";
import { SESSION_DRAG_MIME } from "./conversation-drag";

function sess(p: Partial<SessionMeta> & { id: string }): SessionMeta {
  return { title: p.id, agent: "claude", createdAt: 0, updatedAt: 1000, ...p };
}

function renderUI(ui: ReactElement) {
  return render(
    <CoreProvider
      wsId="test-ws"
      identity={{ userId: "me", name: "我" }}
      desktopBridge={{ deleteChat: () => Promise.resolve() } as unknown as DesktopBridge}
    >
      {ui}
    </CoreProvider>,
  );
}

// 会话行标题即 title;造 n 条便于断言「显示了几条」。
function makeSessions(n: number): SessionMeta[] {
  return Array.from({ length: n }, (_, i) => sess({ id: `s${i}`, title: `会话${i}` }));
}

function StoredSessionList({ onSelect = () => {} }: { onSelect?: (id: string) => void }) {
  const sessions = usePersonalStore((state) => state.sessions);
  return (
    <SessionList sessions={sessions} activeSessionId={undefined} onSelect={onSelect} onToast={() => {}} />
  );
}

describe("SessionList 分组会话超 5 折叠", () => {
  const base = { activeSessionId: undefined, onSelect: () => {}, onToast: () => {} };

  it("不超过 5 条:全部显示,无展开按钮", () => {
    renderUI(<SessionList sessions={makeSessions(5)} {...base} />);
    expect(screen.getAllByText(/^会话\d$/)).toHaveLength(5);
    expect(screen.queryByText(/展开显示/)).not.toBeInTheDocument();
  });

  it("超过 5 条:默认只显示前 5 条 + 「展开显示 (剩余数)」按钮", () => {
    renderUI(<SessionList sessions={makeSessions(8)} {...base} />);
    expect(screen.getAllByText(/^会话\d$/)).toHaveLength(5);
    // 8 条里前 5 条显示,剩 3 条折叠
    expect(screen.getByText("展开显示 (3)")).toBeInTheDocument();
    expect(screen.queryByText("会话7")).not.toBeInTheDocument();
  });

  it("点击展开 → 全部显示 + 按钮变「折叠显示」;再点收回前 5", () => {
    renderUI(<SessionList sessions={makeSessions(8)} {...base} />);
    fireEvent.click(screen.getByText("展开显示 (3)"));
    expect(screen.getAllByText(/^会话\d$/)).toHaveLength(8);
    expect(screen.getByText("折叠显示")).toBeInTheDocument();
    expect(screen.getByText("会话7")).toBeInTheDocument();

    fireEvent.click(screen.getByText("折叠显示"));
    expect(screen.getAllByText(/^会话\d$/)).toHaveLength(5);
    expect(screen.getByText("展开显示 (3)")).toBeInTheDocument();
  });

  it("点会话行触发 onSelect(会话 id)", () => {
    const onSelect = vi.fn();
    renderUI(<SessionList sessions={makeSessions(3)} {...base} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("会话1"));
    expect(onSelect).toHaveBeenCalledWith("s1");
  });

  it("拖动会话行时只写入会话 id 的自定义 MIME payload", () => {
    const values = new Map<string, string>();
    const transfer = {
      effectAllowed: "uninitialized",
      setData: (type: string, value: string) => values.set(type, value),
    } as unknown as DataTransfer;
    renderUI(<SessionList sessions={makeSessions(2)} {...base} />);

    const row = screen.getByText("会话1").closest("button");
    expect(row).toHaveAttribute("draggable", "true");
    fireEvent.dragStart(row!, { dataTransfer: transfer });

    expect(transfer.effectAllowed).toBe("copy");
    expect(values.get(SESSION_DRAG_MIME)).toBe("s1");
    expect(values.size).toBe(1);
  });
});

describe("SessionList 会话重命名", () => {
  it("点击铅笔原地编辑且不切换会话,Enter 保存去除空格后的名称", () => {
    usePersonalStore.setState({ sessions: makeSessions(1) });
    const onSelect = vi.fn();
    renderUI(<StoredSessionList onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "重命名 会话0" }));

    const input = screen.getByRole("textbox", { name: "会话名称" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("会话0");
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "  新会话名称  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(usePersonalStore.getState().sessions[0]?.title).toBe("新会话名称");
    expect(screen.queryByRole("textbox", { name: "会话名称" })).not.toBeInTheDocument();
  });

  it("输入框失焦时保存名称", () => {
    usePersonalStore.setState({ sessions: makeSessions(1) });
    renderUI(<StoredSessionList />);
    fireEvent.click(screen.getByRole("button", { name: "重命名 会话0" }));
    const input = screen.getByRole("textbox", { name: "会话名称" });

    fireEvent.change(input, { target: { value: "失焦名称" } });
    fireEvent.blur(input);

    expect(usePersonalStore.getState().sessions[0]?.title).toBe("失焦名称");
  });

  it("Escape 或空名称取消修改", () => {
    usePersonalStore.setState({ sessions: makeSessions(1) });
    renderUI(<StoredSessionList />);
    fireEvent.click(screen.getByRole("button", { name: "重命名 会话0" }));
    let input = screen.getByRole("textbox", { name: "会话名称" });
    fireEvent.change(input, { target: { value: "不应保存" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(usePersonalStore.getState().sessions[0]?.title).toBe("会话0");

    fireEvent.click(screen.getByRole("button", { name: "重命名 会话0" }));
    input = screen.getByRole("textbox", { name: "会话名称" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(usePersonalStore.getState().sessions[0]?.title).toBe("会话0");
  });
});

describe("SessionRow 运行状态徽标（等待确认 > 正在运行 > 已结束）", () => {
  const base = { activeSessionId: undefined, onSelect: () => {}, onToast: () => {} };

  // 每例铺底徽标相关瞬态,防跨用例污染。
  function resetBadges() {
    usePersonalStore.setState({
      runningBySession: {},
      piUiPending: [],
      runOutcomeBySession: {},
      activeSessionId: undefined,
    });
  }

  function statusOf(title: string) {
    return screen.getByText(title).closest("button")!.querySelector(".pw-session-status");
  }

  it("运行中会话显示 running 状态点,其它会话无徽标", () => {
    resetBadges();
    usePersonalStore.setState({ runningBySession: { s0: "run-1" } });
    renderUI(<SessionList sessions={makeSessions(2)} {...base} />);
    expect(statusOf("会话0")).toHaveAttribute("data-status", "running");
    expect(statusOf("会话0")).toHaveAttribute("aria-label", "正在运行");
    expect(statusOf("会话1")).toBeNull();
  });

  it("等待确认（confirm/askquestion 在队）优先于运行中", () => {
    resetBadges();
    usePersonalStore.setState({
      runningBySession: { s0: "run-1" },
      piUiPending: [
        {
          uiSessionId: "s0",
          request: { type: "extension_ui_request", id: "r1", method: "confirm", title: "t", message: "m" },
        },
      ],
    });
    renderUI(<SessionList sessions={makeSessions(1)} {...base} />);
    expect(statusOf("会话0")).toHaveAttribute("data-status", "confirm");
  });

  it("非阻塞 method（notify）不触发等待确认徽标", () => {
    resetBadges();
    usePersonalStore.setState({
      piUiPending: [
        {
          uiSessionId: "s0",
          request: { type: "extension_ui_request", id: "r2", method: "notify", message: "m" },
        },
      ],
    });
    renderUI(<SessionList sessions={makeSessions(1)} {...base} />);
    expect(statusOf("会话0")).toBeNull();
  });

  it("已结束终局按成败显示 ok/fail,仅对非 active 行", () => {
    resetBadges();
    usePersonalStore.setState({
      runOutcomeBySession: { s0: { ok: true, endedAt: 1000 }, s1: { ok: false, endedAt: 1000 } },
    });
    renderUI(<SessionList sessions={makeSessions(2)} {...base} />);
    expect(statusOf("会话0")).toHaveAttribute("data-status", "ok");
    expect(statusOf("会话1")).toHaveAttribute("data-status", "fail");
  });

  it("active 行不显示已结束徽标（读侧兜底,即使终局残留）", () => {
    resetBadges();
    usePersonalStore.setState({ runOutcomeBySession: { s0: { ok: true, endedAt: 1000 } } });
    renderUI(<SessionList sessions={makeSessions(1)} {...base} activeSessionId="s0" />);
    expect(statusOf("会话0")).toBeNull();
  });
});

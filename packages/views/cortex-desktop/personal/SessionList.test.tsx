import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge, SessionMeta } from "@cortex-work/core";

import { SessionList } from "./PersonalSidebar";

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
});

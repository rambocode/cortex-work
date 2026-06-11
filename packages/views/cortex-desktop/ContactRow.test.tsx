import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ContactRow } from "./Sidebar";
import type { Contact } from "@cortex-work/core/types";

const base: Contact = {
  id: "wangyutong",
  name: "王雨桐",
  group: "team",
  role: "前端 · DX 平台",
  avatar: { initials: "WY", bg: "#c96442" },
  agentStatus: "review",
  statusText: "待审",
  last: { kind: "review", text: "ContactList 字段重构 · 待审核" },
  time: "09:18",
  unread: 2,
  mention: true,
};

describe("ContactRow", () => {
  it("renders a mention unread badge", () => {
    render(<ContactRow item={base} active={false} onClick={() => {}} mode="rich" />);
    expect(screen.getByText("王雨桐")).toBeInTheDocument();
    // mention badge renders "@2"
    expect(screen.getByText("@2")).toBeInTheDocument();
  });

  it("hides the time column in minimal mode", () => {
    const { container } = render(<ContactRow item={base} active={false} onClick={() => {}} mode="minimal" />);
    expect(container.querySelector(".time")).toBeNull();
  });

  it("calls onClick with the contact id", () => {
    const onClick = vi.fn();
    const { container } = render(<ContactRow item={base} active={false} onClick={onClick} mode="rich" />);
    (container.querySelector(".contact") as HTMLElement).click();
    expect(onClick).toHaveBeenCalledWith("wangyutong");
  });
});

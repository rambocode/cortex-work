import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { CoreProvider, useCortexUIStore, DEFAULT_TWEAKS } from "@cortex-work/core";
import { CortexDesktopView } from "./CortexDesktopView";

function renderApp() {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }}>
      <CortexDesktopView />
    </CoreProvider>,
  );
}

describe("CortexDesktopView (integration)", () => {
  beforeEach(() => {
    // Reset UI store between tests (module-level singleton).
    useCortexUIStore.setState({
      workspace: "team",
      currentOrgId: "dx",
      activeSection: "chat",
      activeContactId: "wangyutong",
      activeFile: "desktop/src/sidebar/ContactList.tsx",
      search: "",
      rightOpen: true,
      openTabs: ["desktop/src/sidebar/ContactList.tsx"],
      tweaks: { ...DEFAULT_TWEAKS },
      toasts: [],
    });
  });

  it("hydrates contacts, conversation and composer from the React Query mock layer", async () => {
    renderApp();

    // Contact list (server state) resolves into the sidebar. 张昊/李清 are
    // sidebar-only names (王雨桐 also appears as a message author, so it is
    // intentionally ambiguous and not used as the anchor here).
    expect(await screen.findByText("张昊")).toBeInTheDocument();
    expect(screen.getByText("李清")).toBeInTheDocument();

    // The active conversation renders its diff + approve cards.
    expect(await screen.findByText("ContactList 字段重构")).toBeInTheDocument();
    expect(screen.getByText("等待你的确认")).toBeInTheDocument();

    // Composer placeholder targets the active contact's Agent.
    expect(screen.getByPlaceholderText(/给 王雨桐 的 Agent 发消息/)).toBeInTheDocument();
  });

  it("filters the sidebar by search down to a single match", async () => {
    renderApp();
    await screen.findByText("张昊");

    fireEvent.change(screen.getByPlaceholderText("搜索联系人 / 对话"), { target: { value: "周墨" } });

    expect(screen.getByText("周墨")).toBeInTheDocument();
    expect(screen.queryByText("张昊")).toBeNull();
  });

  it("shows an empty state when nothing matches the search", async () => {
    renderApp();
    await screen.findByText("张昊");

    fireEvent.change(screen.getByPlaceholderText("搜索联系人 / 对话"), { target: { value: "zzz-no-match" } });

    expect(await screen.findByText(/未找到匹配/)).toBeInTheDocument();
  });

  it("shows the org switcher and switches organization from the dropdown", async () => {
    renderApp();

    // Current org pill (server state from the React Query mock).
    expect(await screen.findByText("dx")).toBeInTheDocument();

    // Open the dropdown and switch to another org.
    fireEvent.click(screen.getByText("dx"));
    fireEvent.click(await screen.findByText("Cortex"));

    // Pill reflects the new org; dropdown closed.
    await waitFor(() => expect(screen.getByText("Cortex")).toBeInTheDocument());
    expect(screen.getByText("已切换到 Cortex")).toBeInTheDocument();
  });

  it("navigates to the 智能体 / 用量 sections and back to chat via a contact", async () => {
    renderApp();
    await screen.findByText("张昊");

    // Open 智能体 — chat composer is replaced by the agents page.
    fireEvent.click(screen.getByText("智能体"));
    expect(await screen.findByText(/能领取 issue/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/发消息/)).toBeNull();

    // Open 用量.
    fireEvent.click(screen.getByText("用量"));
    expect(await screen.findByText("每日 Token")).toBeInTheDocument();

    // Selecting a sidebar contact returns to chat (张昊 is sidebar-unique here).
    fireEvent.click(screen.getByText("张昊"));
    expect(await screen.findByPlaceholderText(/给 张昊 的 Agent 发消息/)).toBeInTheDocument();
  });

  it("opens the settings menu and switches settings tabs", async () => {
    renderApp();
    await screen.findByText("张昊");

    fireEvent.click(screen.getByText("设置"));
    fireEvent.click(screen.getByRole("menuitem", { name: "设置" }));

    expect(await screen.findByText("返回应用")).toBeInTheDocument();
    expect(screen.getByText("Profile description")).toBeInTheDocument();

    fireEvent.click(screen.getByText("配置"));
    expect(screen.getByText("Auto-start on launch")).toBeInTheDocument();
    expect(screen.getByText("Diagnostics")).toBeInTheDocument();

    fireEvent.click(screen.getByText("运行时"));
    expect(screen.getByText("Connect Remote")).toBeInTheDocument();
    expect(screen.getByText("Runtimes on this machine")).toBeInTheDocument();

    fireEvent.click(screen.getByText("skill"));
    expect(screen.getByText("New Skill")).toBeInTheDocument();
    expect(screen.getByText("Used")).toBeInTheDocument();
  });

  it("approves a change: diff card flips to 已应用 and a toast appears", async () => {
    renderApp();
    await screen.findByText("ContactList 字段重构");

    fireEvent.click(screen.getByText("批准并运行"));

    await waitFor(() => expect(screen.getByText("已应用")).toBeInTheDocument());
    expect(screen.getByText("已批准变更 · Agent 开始执行")).toBeInTheDocument();
  });
});

// 团队侧零回归（U5·R12）：共享 MessageStream / ChatArea 渲染管线在「不传任何过程相关 flag」时
// 仍把 agentLog / reasoning 内联渲染（.agent-log / .reasoning-block），且 ChatArea.tsx 的导出面未变。
// 个人区把过程外移右侧浮层是经新建 ProcessStep + process key 实现,绝不触碰团队侧渲染件与导出面（KTD9）。

import { QueryClient } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { Contact, DesktopBridge, Message } from "@cortex-work/core";
import * as ChatAreaModule from "./ChatArea";
import { MessageStream } from "./ChatArea";

const bridge = { loadChat: async () => [], saveChat: async () => {} } as unknown as DesktopBridge;

const teamContact: Contact = {
  id: "pi",
  name: "Pi",
  group: "shared",
  avatar: { initials: "PI", bg: "#4338ca" },
  agentStatus: "online",
  statusText: "",
  last: "",
  time: "",
  unread: 0,
};

// 团队侧调用 MessageStream:**不传** collapsibleLogs/collapsibleReasoning/stickToBottomKey 等任何
// 过程/个人相关 flag（团队侧默认形态）。
function renderTeamStream(messages: Message[]) {
  const qc = new QueryClient();
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
      <MessageStream
        contact={teamContact}
        convo={{ headerStatus: { dot: "online", text: "" }, metaRow: [], messages }}
        onSelectFile={() => {}}
        activeFile=""
        onApprove={() => {}}
      />
    </CoreProvider>,
  );
}

describe("团队侧 MessageStream 零回归（R12）", () => {
  afterEach(() => cleanup());

  it("传含 agentLog 的 convo、不传过程 flag → 仍内联渲染 .agent-log 工具步骤", () => {
    const messages: Message[] = [
      { kind: "text", who: "me", time: "10:00", uid: "u1", text: "跑一下" },
      {
        kind: "agentLog",
        who: "claude",
        time: "10:01",
        uid: "g1",
        title: "执行任务",
        active: false,
        completed: true,
        items: [
          { ic: "check", text: "Read · a.ts" },
          { ic: "check", text: "Edit · b.ts" },
        ],
      },
      { kind: "text", who: "claude", time: "10:02", uid: "a1", text: "完成了" },
    ];
    const { container, getByText } = renderTeamStream(messages);
    // agentLog 仍内联渲染（团队侧不折叠 → 步骤直接可见）。
    expect(container.querySelector(".agent-log")).toBeInTheDocument();
    expect(getByText("执行任务")).toBeInTheDocument();
    expect(getByText("Read · a.ts")).toBeInTheDocument();
    expect(getByText("Edit · b.ts")).toBeInTheDocument();
    // 问答正文照常渲染。
    expect(getByText("完成了")).toBeInTheDocument();
  });

  it("传含 reasoning 的 convo、不传过程 flag → 仍内联渲染 .reasoning-block 思考流", () => {
    const messages: Message[] = [
      { kind: "reasoning", who: "pi", time: "10:00", uid: "r1", text: "先分析一下问题", active: true },
      { kind: "text", who: "pi", time: "10:01", uid: "a1", text: "答案在此" },
    ];
    const { container, getByText } = renderTeamStream(messages);
    // reasoning 仍内联渲染（团队侧默认展开:collapsible 未传 → open 恒为 true）。
    expect(container.querySelector(".reasoning-block")).toBeInTheDocument();
    expect(getByText("思考过程")).toBeInTheDocument();
    expect(getByText("先分析一下问题")).toBeInTheDocument();
    expect(getByText("答案在此")).toBeInTheDocument();
  });

  it("agentLog + reasoning 同时存在时团队侧两者都内联（个人区外移不影响共享件）", () => {
    const messages: Message[] = [
      { kind: "reasoning", who: "claude", time: "10:00", uid: "r1", text: "思考X", active: true },
      {
        kind: "agentLog",
        who: "claude",
        time: "10:01",
        uid: "g1",
        title: "执行",
        active: true,
        items: [{ ic: "running", text: "Bash · ls" }],
      },
    ];
    const { container } = renderTeamStream(messages);
    expect(container.querySelector(".reasoning-block")).toBeInTheDocument();
    expect(container.querySelector(".agent-log")).toBeInTheDocument();
  });
});

describe("ChatArea.tsx 导出面未变（R12 / KTD9）", () => {
  it("仅导出 MessageStream / ChatArea / ChatAreaProps（未把团队侧私有渲染件提为导出）", () => {
    // 运行时可见导出名（type/interface 编译后不在运行时,故只校验值导出 + 关键私有件未泄漏）。
    const exportedNames = Object.keys(ChatAreaModule).sort();
    expect(exportedNames).toEqual(["ChatArea", "MessageStream"]);
    // 团队侧私有渲染件绝不被导出（KTD9:个人区用新建 ProcessStep,不复用这两个私有 const）。
    expect((ChatAreaModule as Record<string, unknown>).AgentLogMessage).toBeUndefined();
    expect((ChatAreaModule as Record<string, unknown>).ReasoningMessage).toBeUndefined();
  });
});

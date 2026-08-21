// 团队侧零回归（U5·R12）：共享 MessageStream / ChatArea 渲染管线在「不传任何过程相关 flag」时
// 仍把 agentLog / reasoning 内联渲染（.agent-log / .reasoning-block），且 ChatArea.tsx 的导出面未变。
// 个人区把过程外移右侧浮层是经新建 ProcessStep + process key 实现,绝不触碰团队侧渲染件与导出面（KTD9）。

import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, personalChatKeys, personalRunEventsKeys, usePersonalStore } from "@cortex-work/core";
import type { Contact, DesktopBridge, Message } from "@cortex-work/core";
import * as ChatAreaModule from "./ChatArea";
import { MessageStream } from "./ChatArea";

const bridge = { loadChat: async () => [], saveChat: async () => {} } as unknown as DesktopBridge;
const desktopCss = readFileSync("cortex-desktop/cortex-desktop.css", "utf8");

const teamContact: Contact = {
  id: "pi",
  name: "Cortex",
  group: "shared",
  avatar: { initials: "C", bg: "#4338ca" },
  agentStatus: "online",
  statusText: "",
  last: "",
  time: "",
  unread: 0,
};

describe("个人会话头像样式", () => {
  it("个人会话不显示头像与消息头，头像列归零；团队会话仍按原有头像/分组语义排版", () => {
    // 会话里只有「我 + 当前 agent」，气泡左右对齐已经说清身份，头像是纯噪声（产品决策）。
    // 头像列宽度必须一并归零（gap + turn-usage 缩进），否则内容会挂着一段空缩进。
    expect(desktopCss).toMatch(/\.pw-personal-chat\s+\.msg\s+\.m-avatar\s*\{[^}]*display:\s*none/);
    expect(desktopCss).toMatch(/\.pw-personal-chat\s+\.msg\s*\{[^}]*gap:\s*0/);
    expect(desktopCss).toMatch(/\.pw-personal-chat\s+\.m-head\s*\{[^}]*display:\s*none/);
    expect(desktopCss).toMatch(/\.pw-personal-chat\s+\.m-turn-usage\s*\{[^}]*margin-left:\s*0/);
    // 团队会话不受影响：连续消息仍靠 visibility 占位保持头像列对齐。
    expect(desktopCss).toMatch(/\.msg\.is-grouped\s+\.m-avatar\s*\{[^}]*visibility:\s*hidden/);
  });
});

describe("用户消息气泡自动折叠", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("内容总高度超限时默认折叠正文和图片，并允许展开后再次收起", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("pw-user-message-content") ? 480 : 0;
    });
    const view = renderTeamStream([
      {
        kind: "text",
        who: "me",
        time: "10:00",
        uid: "u-long",
        text: "很长的用户输入",
        images: [{ path: "/tmp/brief.png", name: "brief.png", mimeType: "image/png" }],
      },
    ]);

    const shell = view.container.querySelector(".pw-user-message-shell")!;
    expect(shell).toHaveClass("is-collapsed");
    expect(shell.querySelector(".msg-img-row")).toBeInTheDocument();

    fireEvent.click(view.getByRole("button", { name: "展开" }));
    expect(shell).toHaveClass("is-expanded");
    expect(view.getByRole("button", { name: "收起" })).toBeInTheDocument();

    fireEvent.click(view.getByRole("button", { name: "收起" }));
    expect(shell).toHaveClass("is-collapsed");
  });

  it("短消息不显示折叠按钮，用户气泡使用固定白色背景", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(80);
    const view = renderTeamStream([
      { kind: "text", who: "me", time: "10:00", uid: "u-short", text: "短消息" },
    ]);

    expect(view.queryByRole("button", { name: "展开" })).not.toBeInTheDocument();
    expect(desktopCss).toMatch(/\.msg\.is-me\s+\.m-text\s*\{[^}]*background:\s*#fff/);
  });
});

// 团队侧调用 MessageStream:**不传** collapsibleLogs/collapsibleReasoning/stickToBottomKey 等任何
// 过程/个人相关 flag（团队侧默认形态）。
function renderTeamStream(messages: Message[], markdownBodies = false) {
  const qc = new QueryClient();
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
      <MessageStream
        contact={teamContact}
        convo={{ headerStatus: { dot: "online", text: "" }, metaRow: [], messages }}
        onSelectFile={() => {}}
        activeFile=""
        onApprove={() => {}}
        markdownBodies={markdownBodies}
      />
    </CoreProvider>,
  );
}

describe("团队侧 MessageStream 零回归（R12）", () => {
  afterEach(() => cleanup());

  it("旧会话中的纯空 Cortex text 不生成消息 DOM，正常正文仍保留", () => {
    const { container, getByText } = renderTeamStream(
      [
        { kind: "text", who: "pi", time: "10:00", uid: "answer", text: "最终报告" },
        { kind: "text", who: "pi", time: "10:01", uid: "empty-1", text: "\n\n" },
        { kind: "text", who: "pi", time: "10:02", uid: "empty-2", text: "\n\n\n" },
        { kind: "text", who: "pi", time: "10:03", uid: "empty-3", text: "\n\n" },
      ],
      true,
    );

    expect(getByText("最终报告")).toBeInTheDocument();
    expect(container.querySelectorAll(".msgs-inner > .msg")).toHaveLength(1);
    expect(container.querySelectorAll(".m-text.md-body")).toHaveLength(1);
  });

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

  it("todoList 未全完成 → 默认展开:标题+进度+三态图标,in_progress 项转圈(active)", () => {
    const messages: Message[] = [
      {
        kind: "todoList",
        who: "claude",
        time: "10:00",
        uid: "td1",
        runId: "run-1",
        active: true,
        todos: [
          { text: "分析代码", status: "completed" },
          { text: "重写组件", status: "in_progress" },
          { text: "跑测试", status: "pending" },
        ],
      },
    ];
    const { container, getByText } = renderTeamStream(messages);
    expect(getByText("任务清单")).toBeInTheDocument();
    expect(getByText(/1\/3/)).toBeInTheDocument();
    expect(getByText("分析代码")).toBeInTheDocument();
    expect(getByText("重写组件")).toBeInTheDocument();
    expect(getByText("跑测试")).toBeInTheDocument();
    // in_progress 项在 active run 中显示 spinner(列表内至少一个)。
    expect(container.querySelectorAll(".pw-tasklist-items .spinner").length).toBeGreaterThan(0);
  });

  it("todoList 全部完成 → 自动折成一行头部(计数 + 进度条),点击可展开回顾", () => {
    const messages: Message[] = [
      {
        kind: "todoList",
        who: "claude",
        time: "10:00",
        uid: "td2",
        runId: "run-1",
        active: false,
        todos: [
          { text: "分析代码", status: "completed" },
          { text: "跑测试", status: "completed" },
        ],
      },
    ];
    const { container, getByText, queryByText } = renderTeamStream(messages);
    // 折叠态:只留头部一行(标题 + 计数 + 进度条),列表不渲染(3a 规格 §6)。
    expect(getByText("任务清单")).toBeInTheDocument();
    expect(getByText("2/2")).toBeInTheDocument();
    expect(container.querySelector(".pw-tasklist-bar i")).toHaveStyle({ width: "100%" });
    expect(queryByText("分析代码")).not.toBeInTheDocument();
    // 点击头部展开 → 列表可见。
    fireEvent.click(container.querySelector(".pw-tasklist-head")!);
    expect(getByText("分析代码")).toBeInTheDocument();
    expect(getByText("跑测试")).toBeInTheDocument();
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

  it("探索代理卡显示中文类型、渲染 Markdown 结论，并由查看过程进入子会话", () => {
    const messages: Message[] = [{
      kind: "subagentCard",
      who: "pi",
      time: "10:00",
      uid: "sa1",
      callId: "call-explore-1",
      childSessionId: "child-explore-1",
      taskTitle: "检查项目边界",
      roleId: "explore",
      roleLabel: "Repository Explorer",
      roleColor: "#2563eb",
      status: "completed",
      startedAt: 1_000,
      finishedAt: 14_000,
      steps: 3,
      activity: "执行完成",
      summary: "## 核心结论\n\n- 发现一个 **阻断问题**",
    }];
    const qc = new QueryClient();
    usePersonalStore.setState({
      activeSessionId: "session-1",
      sessions: [
        { id: "session-1", title: "主会话", agent: "pi", createdAt: 1, updatedAt: 1 },
        { id: "child-explore-1", title: "Repository Explorer · 检查项目边界", agent: "pi", model: "deepseek-v4-pro", relation: "side", parentSessionId: "session-1", createdAt: 1, updatedAt: 1 },
      ],
    });
    qc.setQueryData<Message[]>(personalChatKeys.detail("child-explore-1"), [
      { kind: "text", who: "me", time: "10:00", text: "检查项目边界" },
      { kind: "text", who: "pi", time: "10:01", text: "子 Agent 的完整检查结果" },
    ]);
    qc.setQueryData(personalRunEventsKeys.detail("session-1"), [
      {
        runId: "run-1",
        ts: 2_000,
        ev: {
          type: "tool",
          name: "Read",
          detail: "src/a.ts",
          phase: "start",
          subagentCallId: "call-explore-1",
        },
      },
    ]);
    const view = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
        <MessageStream
          contact={teamContact}
          convo={{ headerStatus: { dot: "online", text: "" }, metaRow: [], messages }}
          onSelectFile={() => {}}
          activeFile=""
          onApprove={() => {}}
          sessionId="session-1"
        />
      </CoreProvider>,
    );
    expect(view.getByText("检查项目边界")).toBeInTheDocument();
    expect(view.getByText("探索")).toBeInTheDocument();
    expect(view.getByText("代理 探索代理 · 模型 deepseek-v4-pro")).toBeInTheDocument();
    expect(view.getByText("3 步")).toBeInTheDocument();
    expect(view.queryByText("进入子会话")).not.toBeInTheDocument();
    expect(view.queryByRole("heading", { name: "核心结论" })).not.toBeInTheDocument();
    fireEvent.click(view.getByText("展开结论"));
    expect(view.getByRole("heading", { name: "核心结论" })).toBeInTheDocument();
    expect(view.getByText("阻断问题").tagName).toBe("STRONG");
    fireEvent.click(view.getByText("预览"));
    expect(view.container.querySelector(".pw-subagent-card-result")).not.toBeInTheDocument();
    const preview = view.getByRole("dialog", { name: "预览 检查项目边界 的执行进度" });
    expect(preview).toHaveTextContent("子 Agent 的完整检查结果");
    expect(preview).toHaveTextContent("Read · src/a.ts · 调用");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(view.queryByRole("dialog", { name: "预览 检查项目边界 的执行进度" })).not.toBeInTheDocument();
    fireEvent.click(view.getByText("预览"));
    fireEvent.click(view.getByText("查看过程"));
    expect(usePersonalStore.getState().activeSessionId).toBe("child-explore-1");
    expect(view.queryByRole("dialog", { name: "预览 检查项目边界 的执行进度" })).not.toBeInTheDocument();
  });
});

describe("个人会话过程时间线", () => {
  afterEach(() => {
    cleanup();
    usePersonalStore.setState({ runningBySession: {} });
  });

  it("完成后折叠为紧凑活动台账，聊天流不再渲染工具原始详情", () => {
    const qc = new QueryClient();
    usePersonalStore.setState({ processPanelOpenReq: undefined });
    qc.setQueryData(personalRunEventsKeys.detail("session-1"), [
      {
        runId: "run-old",
        ts: 0,
        ev: {
          type: "tool",
          name: "Read",
          detail: "src/old-turn.ts",
          input: { file_path: "src/old-turn.ts" },
          phase: "start",
          toolCallId: "old-read",
        },
      },
      {
        runId: "run-1",
        ts: 1,
        ev: {
          type: "tool",
          name: "Read",
          detail: "src/chat.tsx",
          input: { file_path: "src/chat.tsx" },
          phase: "start",
          toolCallId: "read-1",
        },
      },
      {
        runId: "run-1",
        ts: 2,
        ev: {
          type: "tool",
          name: "Read",
          output: "export function MessageStream() {}",
          phase: "end",
          toolCallId: "read-1",
        },
      },
      {
        runId: "run-1",
        ts: 3,
        ev: {
          type: "tool",
          name: "Grep",
          detail: "process",
          input: { pattern: "process" },
          phase: "start",
          toolCallId: "grep-1",
        },
      },
      {
        runId: "run-1",
        ts: 4,
        ev: {
          type: "tool",
          name: "Grep",
          output: "ChatArea.tsx:913",
          phase: "end",
          toolCallId: "grep-1",
        },
      },
      {
        runId: "run-1",
        ts: 5,
        ev: {
          type: "tool",
          name: "Bash",
          detail: "transient-only-command",
          input: { command: "pwd" },
          phase: "start",
          toolCallId: "transient-tool",
        },
      },
    ]);
    const processMessages: Message[] = [
      {
        kind: "reasoning",
        who: "pi",
        time: "10:01",
        uid: "reasoning-1",
        text: "先定位消息渲染入口",
        active: false,
        completed: true,
      },
      {
        kind: "agentLog",
        who: "pi",
        time: "10:02",
        uid: "tools-1",
        title: "Agent 执行完成",
        active: false,
        completed: true,
        items: [
          { ic: "check", text: "Read · src/chat.tsx", toolName: "read", detail: "src/chat.tsx" },
          { ic: "check", text: "Grep · process", toolName: "grep", detail: "process" },
        ],
      },
    ];
    const messages: Message[] = [
      { kind: "text", who: "me", time: "10:00", uid: "user-1", text: "检查会话过程" },
      { kind: "text", who: "pi", time: "10:03", uid: "answer-1", text: "已经定位完成" },
    ];

    const view = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
        <MessageStream
          contact={teamContact}
          convo={{ headerStatus: { dot: "online", text: "" }, metaRow: [], messages }}
          onSelectFile={() => {}}
          activeFile=""
          onApprove={() => {}}
          processMessages={processMessages}
          sessionId="session-1"
        />
      </CoreProvider>,
    );

    // 回合开关只保留可扫描摘要；具体工具细节由完整过程面板负责。
    const process = view.getByRole("button", {
      name: /已处理.*读取了 1 个文件.*调用了 1 个工具/,
    });
    expect(process).toHaveAttribute("aria-expanded", "false");
    expect(view.queryByText("先定位消息渲染入口")).not.toBeInTheDocument();
    expect(view.queryByText("Read · src/chat.tsx")).not.toBeInTheDocument();

    const html = view.container.textContent ?? "";
    expect(html.indexOf("检查会话过程")).toBeLessThan(html.indexOf("读取了 1 个文件"));
    expect(html.indexOf("读取了 1 个文件")).toBeLessThan(html.indexOf("已经定位完成"));

    fireEvent.click(process);
    expect(process).toHaveAttribute("aria-expanded", "true");
    expect(view.getByText("先定位消息渲染入口")).toBeInTheDocument();
    const readRow = view.getByRole("button", { name: /读取 chat\.tsx/ });
    expect(view.queryByText(/old-turn/)).not.toBeInTheDocument();
    expect(view.queryByText(/transient-only-command/)).not.toBeInTheDocument();
    expect(view.getByRole("button", { name: /执行命令/ })).toBeInTheDocument();
    fireEvent.click(readRow);
    expect(usePersonalStore.getState().processPanelOpenReq).toMatchObject({
      sessionId: "session-1",
      toolCallId: "read-1",
    });
    expect(view.container.querySelector(".pw-conversation-process-term")).not.toBeInTheDocument();
    expect(view.queryByText("export function MessageStream() {}", { exact: false })).not.toBeInTheDocument();

    fireEvent.click(view.getByRole("button", { name: "查看完整过程" }));
    expect(usePersonalStore.getState().processPanelOpenReq?.sessionId).toBe("session-1");
  });

  it("思考内容默认最多显示 200 字，点击后在原位显示全文", () => {
    const qc = new QueryClient();
    const fullThought = `${"思".repeat(205)}结论`;
    const preview = `${"思".repeat(200)}…`;
    const view = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
        <MessageStream
          contact={teamContact}
          convo={{
            headerStatus: { dot: "online", text: "" },
            metaRow: [],
            messages: [
              { kind: "text", who: "me", time: "10:00", uid: "user-thought", text: "分析" },
              { kind: "text", who: "pi", time: "10:01", uid: "answer-thought", text: "完成" },
            ],
          }}
          onSelectFile={() => {}}
          activeFile=""
          onApprove={() => {}}
          processMessages={[
            {
              kind: "reasoning",
              who: "pi",
              time: "10:01",
              uid: "reasoning-long",
              text: fullThought,
              active: false,
              completed: true,
            },
          ]}
          sessionId="session-thought"
        />
      </CoreProvider>,
    );

    fireEvent.click(view.getByRole("button", { name: /已处理/ }));
    const reasoning = view.getByRole("button", { name: preview });
    expect(view.queryByText(fullThought)).not.toBeInTheDocument();
    fireEvent.click(reasoning);
    expect(view.getByText(fullThought)).toBeInTheDocument();
    expect(reasoning).toHaveAttribute("aria-expanded", "true");
  });

  it("失败轮结束后显示处理失败并默认展开错误动作", () => {
    const qc = new QueryClient();
    qc.setQueryData(personalRunEventsKeys.detail("session-failed"), [
      {
        runId: "run-failed",
        ts: 1,
        ev: { type: "tool", name: "Bash", detail: "pnpm typecheck", phase: "start", toolCallId: "bash-failed" },
      },
      {
        runId: "run-failed",
        ts: 2,
        ev: { type: "tool", name: "Bash", output: "TypeScript failed", isError: true, phase: "end", toolCallId: "bash-failed" },
      },
    ]);
    const view = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
        <MessageStream
          contact={teamContact}
          convo={{
            headerStatus: { dot: "online", text: "" },
            metaRow: [],
            messages: [
              { kind: "text", who: "me", time: "10:00", uid: "user-failed", text: "检查类型" },
              { kind: "text", who: "pi", time: "10:01", uid: "answer-failed", text: "未能完成" },
            ],
          }}
          onSelectFile={() => {}}
          activeFile=""
          onApprove={() => {}}
          processMessages={[
            {
              kind: "agentLog",
              who: "pi",
              time: "10:01",
              uid: "tools-failed",
              title: "Agent 执行失败",
              active: false,
              completed: true,
              items: [{ ic: "check", text: "Bash · pnpm typecheck", toolName: "bash", detail: "pnpm typecheck" }],
            },
          ]}
          sessionId="session-failed"
        />
      </CoreProvider>,
    );

    const process = view.getByRole("button", { name: /处理失败.*运行了 1 条命令/ });
    expect(process).toHaveAttribute("aria-expanded", "true");
    expect(view.getByRole("button", { name: /执行命令.*查看完整错误/ })).toBeInTheDocument();
  });

  it("运行中的过程默认展开，并取代重复的 typing 活动行", () => {
    const qc = new QueryClient();
    const view = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
        <MessageStream
          contact={teamContact}
          convo={{
            headerStatus: { dot: "online", text: "" },
            metaRow: [],
            messages: [
              { kind: "text", who: "me", time: "10:00", uid: "user-live", text: "继续检查" },
              { kind: "typing", who: "pi", uid: "typing-live", text: "Cortex 正在思考…" },
            ],
          }}
          onSelectFile={() => {}}
          activeFile=""
          onApprove={() => {}}
          processMessages={[
            {
              kind: "reasoning",
              who: "pi",
              time: "10:01",
              uid: "reasoning-live",
              text: "正在检查事件归组",
              active: true,
            },
          ]}
        />
      </CoreProvider>,
    );

    const process = view.getByRole("button", { name: /处理中/ });
    expect(process).toHaveAttribute("aria-expanded", "true");
    expect(view.getByText("正在检查事件归组")).toBeInTheDocument();
    expect(view.queryByRole("status", { name: "Cortex 正在思考…" })).not.toBeInTheDocument();

    view.rerender(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
        <MessageStream
          contact={teamContact}
          convo={{
            headerStatus: { dot: "online", text: "" },
            metaRow: [],
            messages: [
              { kind: "text", who: "me", time: "10:00", uid: "user-live", text: "继续检查" },
              { kind: "text", who: "pi", time: "10:02", uid: "answer-live", text: "检查完成" },
            ],
          }}
          onSelectFile={() => {}}
          activeFile=""
          onApprove={() => {}}
          processMessages={[
            {
              kind: "reasoning",
              who: "pi",
              time: "10:01",
              uid: "reasoning-live",
              text: "正在检查事件归组",
              active: false,
              completed: true,
            },
          ]}
        />
      </CoreProvider>,
    );
    expect(view.getByRole("button", { name: /已处理/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("会话仍在运行时，步骤切相产生的短暂 inactive 不得折叠工作过程", () => {
    const qc = new QueryClient();
    usePersonalStore.setState({ runningBySession: { "session-stable": "run-1" } });
    const renderStream = (active: boolean) => (
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
        <MessageStream
          contact={teamContact}
          convo={{
            headerStatus: { dot: "online", text: "" },
            metaRow: [],
            messages: [
              { kind: "text", who: "me", time: "10:00", uid: "user-stable", text: "持续输出" },
              { kind: "typing", who: "pi", uid: "typing-stable", text: "Cortex 正在处理…" },
            ],
          }}
          onSelectFile={() => {}}
          activeFile=""
          onApprove={() => {}}
          sessionId="session-stable"
          processMessages={[
            {
              kind: "reasoning",
              who: "pi",
              time: "10:01",
              uid: "reasoning-stable",
              text: "跨越 reasoning 与 tool 的切相窗口",
              active,
              completed: !active,
            },
          ]}
        />
      </CoreProvider>
    );

    const view = render(renderStream(true));
    const process = view.getByRole("button", { name: /处理中/ });
    expect(process).toHaveAttribute("aria-expanded", "true");

    view.rerender(renderStream(false));
    expect(process).toHaveAttribute("aria-expanded", "true");
  });
});

describe("MessageStream 自动贴底", () => {
  afterEach(() => cleanup());

  function renderPersonalStream(message: Message, stickToBottomKey: string) {
    const qc = new QueryClient();
    return render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
        <MessageStream
          contact={teamContact}
          convo={{ headerStatus: { dot: "online", text: "" }, metaRow: [], messages: [message] }}
          onSelectFile={() => {}}
          activeFile=""
          onApprove={() => {}}
          stickToBottomKey={stickToBottomKey}
        />
      </CoreProvider>,
    );
  }

  function setScrollBox(el: Element, opts: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: opts.scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: opts.clientHeight });
    Object.defineProperty(el, "scrollTop", { configurable: true, writable: true, value: opts.scrollTop });
  }

  it("个人区贴近底部时,同一条 agent 回复变长会继续滚到最后", () => {
    const first: Message = { kind: "text", who: "pi", time: "10:00", uid: "a1", text: "短回复" };
    const view = renderPersonalStream(first, "a1:3");
    const scroller = view.container.querySelector(".msgs")!;
    setScrollBox(scroller, { scrollHeight: 1000, clientHeight: 240, scrollTop: 760 });

    const next: Message = { ...first, text: "短回复\n".repeat(80) };
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1800 });
    view.rerender(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={new QueryClient()}>
        <MessageStream
          contact={teamContact}
          convo={{ headerStatus: { dot: "online", text: "" }, metaRow: [], messages: [next] }}
          onSelectFile={() => {}}
          activeFile=""
          onApprove={() => {}}
          stickToBottomKey="a1:320"
        />
      </CoreProvider>,
    );

    expect((scroller as HTMLElement).scrollTop).toBe(1800);
  });

  it("用户已经上翻时,agent 流式增长不强制打断阅读位置", () => {
    const first: Message = { kind: "text", who: "pi", time: "10:00", uid: "a1", text: "短回复" };
    const view = renderPersonalStream(first, "a1:3");
    const scroller = view.container.querySelector(".msgs")!;
    setScrollBox(scroller, { scrollHeight: 1000, clientHeight: 240, scrollTop: 120 });
    fireEvent.scroll(scroller);

    const next: Message = { ...first, text: "短回复\n".repeat(80) };
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1800 });
    view.rerender(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={new QueryClient()}>
        <MessageStream
          contact={teamContact}
          convo={{ headerStatus: { dot: "online", text: "" }, metaRow: [], messages: [next] }}
          onSelectFile={() => {}}
          activeFile=""
          onApprove={() => {}}
          stickToBottomKey="a1:320"
        />
      </CoreProvider>,
    );

    expect((scroller as HTMLElement).scrollTop).toBe(120);
  });
});

describe("ChatArea.tsx 导出面未变（R12 / KTD9）", () => {
  it("导出面 = ChatArea/ChatHeader/Composer/MessageStream（团队包装层 TeamChatArea 复用后三者），私有渲染件不泄漏", () => {
    // 运行时可见导出名（type/interface 编译后不在运行时,故只校验值导出 + 关键私有件未泄漏）。
    // ChatHeader/Composer 是 feat/team-server-workspace 刻意开放给 team/TeamChatArea 的
    // （避免 ChatArea 本体再膨胀）;守卫升级为锁定这个新导出面,防继续扩散。
    const exportedNames = Object.keys(ChatAreaModule).sort();
    expect(exportedNames).toEqual(["ChatArea", "ChatHeader", "Composer", "MessageStream"]);
    // 团队侧私有渲染件绝不被导出（KTD9:个人区用新建 ProcessStep,不复用这两个私有 const）。
    expect((ChatAreaModule as Record<string, unknown>).AgentLogMessage).toBeUndefined();
    expect((ChatAreaModule as Record<string, unknown>).ReasoningMessage).toBeUndefined();
  });
});

describe("历史轮过程归档（重开会话后仍可回看）", () => {
  afterEach(() => cleanup());

  const archivedTurn = {
    runId: "run-old",
    anchorUid: "user-1",
    startedAt: 1_000,
    endedAt: 9_800, // 8.8s：与截图里的「已处理 8.8s」同口径
    messages: [
      {
        kind: "agentLog" as const,
        who: "pi",
        time: "10:02",
        uid: "old-log",
        title: "Agent 执行完成",
        active: false,
        completed: true,
        items: [
          { ic: "check" as const, text: "Bash · ls", toolName: "bash", detail: "ls" },
          { ic: "check" as const, text: "Grep · process", toolName: "grep", detail: "process" },
        ],
      },
    ],
    invocations: [
      { key: "tool-1", name: "Bash", detail: "ls", input: { command: "ls" }, output: "a.ts\nb.ts", running: false, startedAt: 1_000, endedAt: 5_000 },
      { key: "tool-2", name: "Grep", detail: "process", output: "3 matches", running: false, startedAt: 5_000, endedAt: 9_800 },
    ],
  };

  function renderWithArchive() {
    const qc = new QueryClient();
    const messages: Message[] = [
      { kind: "text", who: "me", time: "10:00", uid: "user-1", text: "第一轮问题" },
      { kind: "text", who: "pi", time: "10:03", uid: "answer-1", text: "第一轮回答" },
      { kind: "text", who: "me", time: "10:10", uid: "user-2", text: "第二轮问题" },
    ];
    return render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
        <MessageStream
          contact={teamContact}
          convo={{ headerStatus: { dot: "online", text: "" }, metaRow: [], messages }}
          onSelectFile={() => {}}
          activeFile=""
          onApprove={() => {}}
          sessionId="session-1"
          processArchives={[archivedTurn]}
        />
      </CoreProvider>,
    );
  }

  it("归档轮渲染出摘要条，并插在它自己那条用户消息之后（不是流末尾）", () => {
    const view = renderWithArchive();
    const head = view.getByRole("button", { name: /已处理 8\.8s.*运行了 1 条命令.*调用了 1 个工具/ });
    expect(head).toHaveAttribute("aria-expanded", "false"); // 历史轮恒为完成态，默认折叠
    const text = view.container.textContent ?? "";
    expect(text.indexOf("第一轮问题")).toBeLessThan(text.indexOf("已处理 8.8s"));
    expect(text.indexOf("已处理 8.8s")).toBeLessThan(text.indexOf("第一轮回答"));
  });

  it("归档轮展开后保持紧凑活动行，不内联渲染快照正文", () => {
    const view = renderWithArchive();
    fireEvent.click(view.getByRole("button", { name: /已处理 8\.8s/ }));
    expect(view.getAllByRole("button", { name: /执行命令/ })).toHaveLength(2);
    expect(view.queryByText(/\bls\b/)).not.toBeInTheDocument();
    expect(view.queryByText(/a\.ts/)).not.toBeInTheDocument();
    // 历史轮没有瞬态原始事件，「查看完整过程」入口不给（点开只会是空面板）。
    expect(view.queryByRole("button", { name: /完整过程/ })).not.toBeInTheDocument();
  });
});

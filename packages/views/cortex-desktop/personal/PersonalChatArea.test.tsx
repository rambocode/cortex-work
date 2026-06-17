import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CoreProvider, usePersonalStore, useCortexUIStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { Message } from "@cortex-work/core/types";
import { MessageStream } from "../ChatArea";
import { PersonalChatArea } from "./PersonalChatArea";

const NOW = Date.now();

const bridge = {
  loadChat: async () => [],
  saveChat: async () => {},
} as unknown as DesktopBridge;

function renderArea(onToast: (text: string) => void = () => {}) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <PersonalChatArea onToast={onToast} />
    </CoreProvider>,
  );
}

// 注入指定聊天消息(usePersonalChat 走 bridge.loadChat)的渲染助手。
function renderAreaWithChat(messages: Message[]) {
  const b = { loadChat: async () => messages, saveChat: async () => {} } as unknown as DesktopBridge;
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
      <PersonalChatArea onToast={() => {}} />
    </CoreProvider>,
  );
}

function renderMessageStream(messages: Message[]) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <MessageStream
        contact={{
          id: "pi",
          name: "Pi",
          group: "shared",
          avatar: { initials: "PI", bg: "#4338ca" },
          agentStatus: "online",
          statusText: "",
          last: "",
          time: "",
          unread: 0,
        }}
        convo={{ headerStatus: { dot: "online", text: "" }, metaRow: [], messages }}
        onSelectFile={() => {}}
        activeFile=""
        onApprove={() => {}}
        collapsibleReasoning
      />
    </CoreProvider>,
  );
}

describe("PersonalChatArea 项目引导态（无 session）", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [],
      activeProjectId: "p1",
      activeSessionId: undefined,
      timelineProjectId: undefined,
    });
  });

  it("激活项目但无 session:显示项目名与「新建聊天」引导", () => {
    renderArea();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText(/还没有聊天/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建聊天/ })).toBeInTheDocument();
  });

  it("点击「新建聊天」创建 session 并激活", () => {
    const toast = vi.fn();
    renderArea(toast);
    fireEvent.click(screen.getByRole("button", { name: /新建聊天/ }));
    const s = usePersonalStore.getState();
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0]?.projectId).toBe("p1");
    expect(s.activeSessionId).toBe(s.sessions[0]?.id);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("alpha"));
  });

  it("项目有 session 但未选中:提示选择或新建", () => {
    usePersonalStore.setState({
      sessions: [
        {
          id: "s1",
          projectId: "p1",
          title: "Session 1",
          agent: "claude",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      activeSessionId: undefined,
    });
    renderArea();
    expect(screen.getByText(/在左侧选择一个 Session/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建聊天/ })).toBeInTheDocument();
  });

  it("未激活任何项目:保持原有通用空状态", () => {
    usePersonalStore.setState({ activeProjectId: undefined });
    renderArea();
    expect(screen.getByText("选择或新建一个 Session")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新建聊天/ })).toBeNull();
  });
});

describe("PersonalChatArea 文件链接点击 → 右栏预览", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: "s1", projectId: "p1", title: "Session 1", agent: "claude", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: "s1",
      timelineProjectId: undefined,
      filePreviewRequest: undefined,
    });
    useCortexUIStore.setState({ rightOpen: false });
  });

  it("点 Agent 文本里的项目内路径 → requestFilePreview(绝对路径/basename)+ 展开右栏", async () => {
    renderAreaWithChat([
      { kind: "text", who: "claude", time: "12:00", uid: "m1", text: "见 `packages/core/x.ts` 文件" },
    ]);
    const link = await screen.findByText("packages/core/x.ts");
    expect(link).toHaveClass("file-link");
    fireEvent.click(link);
    const s = usePersonalStore.getState();
    expect(s.filePreviewRequest).toEqual({
      projectId: "p1",
      path: "/code/alpha/packages/core/x.ts",
      name: "x.ts",
    });
    expect(s.rightView).toBe("files");
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });

  it("diff 卡片文件行点击 → 同样触发 requestFilePreview;项目外路径短路不派发", async () => {
    renderAreaWithChat([
      {
        kind: "diff",
        who: "claude",
        time: "12:01",
        uid: "d1",
        title: "变更",
        sub: "2 个文件",
        status: "pending",
        files: [
          { path: "src/a.ts", add: 1, del: 0 },
          { path: "/etc/passwd", add: 1, del: 0 },
        ],
      } as Message,
    ]);
    const rowInternal = await screen.findByText("src/a.ts");
    fireEvent.click(rowInternal);
    expect(usePersonalStore.getState().filePreviewRequest).toEqual({
      projectId: "p1",
      path: "/code/alpha/src/a.ts",
      name: "a.ts",
    });

    // 项目外路径:短路,不覆盖上一次请求(handleOpenFile within=false 直接返回)。
    usePersonalStore.setState({ filePreviewRequest: undefined });
    fireEvent.click(screen.getByText("/etc/passwd"));
    expect(usePersonalStore.getState().filePreviewRequest).toBeUndefined();
  });

  it("ref 缺目录但项目内能定位 → 用真实绝对路径派发(本次反馈核心 bug)", async () => {
    // yuque 表格只列裸文件名,真实文件在子目录;resolveProjectFile 命中子目录路径。
    const b = {
      loadChat: async () => [
        { kind: "text", who: "claude", time: "12:00", uid: "m9", text: "见 `002.md` 文件" },
      ],
      saveChat: async () => {},
      resolveProjectFile: async (_root: string, _ref: string) => "/code/alpha/outputs/yuque-kb/docs/002.md",
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
    fireEvent.click(await screen.findByText("002.md"));
    await waitFor(() =>
      expect(usePersonalStore.getState().filePreviewRequest).toEqual({
        projectId: "p1",
        path: "/code/alpha/outputs/yuque-kb/docs/002.md",
        name: "002.md",
      }),
    );
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });

  it("无项目会话:projectPath 缺失,文本路径不可点(无 .file-link)", async () => {
    usePersonalStore.setState({
      sessions: [
        { id: "s2", title: "Session 2", agent: "claude", createdAt: NOW, updatedAt: NOW, noProjectDir: "/tmp/x" },
      ],
      activeProjectId: undefined,
      activeSessionId: "s2",
    });
    renderAreaWithChat([
      { kind: "text", who: "claude", time: "12:02", uid: "m2", text: "见 `packages/core/x.ts` 文件" },
    ]);
    const code = await screen.findByText("packages/core/x.ts");
    expect(code).not.toHaveClass("file-link");
    fireEvent.click(code);
    expect(usePersonalStore.getState().filePreviewRequest).toBeUndefined();
  });
});

describe("PersonalChatArea pi 渲染：reasoning 块 + 运行时状态（U5）", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: "s1", projectId: "p1", title: "Session 1", agent: "pi", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: "s1",
      timelineProjectId: undefined,
      runningBySession: {},
      piRuntimeBySession: {},
    });
  });

  it("运行中的 reasoning 消息默认展开,展示思考文本", () => {
    renderMessageStream([{ kind: "reasoning", who: "pi", time: "12:00", uid: "r1", text: "让我想想这个问题", active: true }]);
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("让我想想这个问题")).toBeInTheDocument();
  });

  it("历史 reasoning 消息默认收起,点击后展开思考正文", async () => {
    renderAreaWithChat([{ kind: "reasoning", who: "pi", time: "12:00", uid: "r1", text: "让我想想这个问题" }]);
    const head = await screen.findByText("思考过程");
    expect(screen.queryByText("让我想想这个问题")).toBeNull();
    fireEvent.click(head);
    expect(screen.getByText("让我想想这个问题")).toBeInTheDocument();
  });

  it("点「思考过程」头部可折叠隐藏思考正文", async () => {
    renderMessageStream([{ kind: "reasoning", who: "pi", time: "12:00", uid: "r1", text: "思考内容X", active: true }]);
    const head = screen.getByText("思考过程");
    expect(screen.getByText("思考内容X")).toBeInTheDocument();
    fireEvent.click(head);
    expect(screen.queryByText("思考内容X")).toBeNull();
  });

  it("pi 运行时状态徽标:压缩 / 重试 / 待注入 / 思考强度", async () => {
    usePersonalStore.getState().setPiRuntime("s1", {
      compacting: true,
      retry: { attempt: 2, max: 3 },
      steering: 1,
      thinkingLevel: "high",
    });
    renderAreaWithChat([]);
    expect(await screen.findByText("压缩上下文…")).toBeInTheDocument();
    expect(screen.getByText(/重试中 2\/3/)).toBeInTheDocument();
    expect(screen.getByText(/1 条待注入/)).toBeInTheDocument();
    expect(screen.getByText(/思考 high/)).toBeInTheDocument();
  });

  it("claude 会话不显示 pi 运行时徽标（即便误置 runtime）", async () => {
    usePersonalStore.setState({
      sessions: [{ id: "s1", projectId: "p1", title: "S", agent: "claude", createdAt: NOW, updatedAt: NOW }],
    });
    usePersonalStore.getState().setPiRuntime("s1", { compacting: true });
    renderAreaWithChat([]);
    await screen.findAllByText(/alpha/);
    expect(screen.queryByText("压缩上下文…")).toBeNull();
  });
});

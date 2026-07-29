import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CoreProvider,
  personalChatKeys,
  personalProcessKeys,
  usePersonalActions,
  usePersonalStore,
  useCortexUIStore,
} from "@cortex-work/core";
import type { DesktopBridge, SessionMeta } from "@cortex-work/core";
import type { Message } from "@cortex-work/core/types";
import { normalizeResearchEngineSettings } from "@cortex-work/core/research/settings";
import { renderClaudeSkillSlash } from "@cortex-work/core";
import type { InjectableSkill } from "@cortex-work/core";
import { MessageStream } from "../ChatArea";
import {
  buildConversationArtifactPrompt,
  PersonalChatArea,
  resolveSkillDispatch,
} from "./PersonalChatArea";

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
    // 文件链接只显示文件名,完整路径进 title(chatMarkdown 的 FileCode 新形态)。
    const link = await screen.findByText("x.ts");
    expect(link).toHaveClass("file-link");
    expect(link).toHaveAttribute("title", "packages/core/x.ts");
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
    // 探测命中后才点亮为可点 file-link(checking 期是普通 code、无 onClick);先等点亮再点击。
    await waitFor(() => expect(screen.getByText("002.md")).toHaveClass("file-link"));
    fireEvent.click(screen.getByText("002.md"));
    await waitFor(() =>
      expect(usePersonalStore.getState().filePreviewRequest).toEqual({
        projectId: "p1",
        path: "/code/alpha/outputs/yuque-kb/docs/002.md",
        name: "002.md",
      }),
    );
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });

  it("项目外 PDF 产物 → 走右栏内置预览,不再系统打开", async () => {
    const openPath = vi.fn(async () => "");
    const b = {
      loadChat: async () => [
        { kind: "text", who: "claude", time: "12:00", uid: "mx", text: "见 `/data/outputs/x/monthly.pdf`" },
      ],
      saveChat: async () => {},
      // 项目根为 /code/alpha,文件在项目外;主进程按真实存在性解析回绝对路径。
      resolveProjectFile: async (_root: string, _ref: string) => "/data/outputs/x/monthly.pdf",
      readFileBinary: vi.fn(),
      openPath,
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
    // 项目外绝对路径也点亮为可点 file-link(渲染层放行 + 主进程解析命中);点亮后只显示文件名,完整路径在 title。
    await waitFor(() => expect(screen.getByText("monthly.pdf")).toHaveClass("file-link"));
    expect(screen.getByText("monthly.pdf")).toHaveAttribute("title", "/data/outputs/x/monthly.pdf");
    fireEvent.click(screen.getByText("monthly.pdf"));
    await waitFor(() =>
      expect(usePersonalStore.getState().filePreviewRequest).toEqual({
        projectId: "p1",
        path: "/data/outputs/x/monthly.pdf",
        name: "monthly.pdf",
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("xlsx 有内置表格预览 → 走右栏预览请求,不再系统打开", async () => {
    const openPath = vi.fn(async () => "");
    const b = {
      loadChat: async () => [
        { kind: "text", who: "claude", time: "12:00", uid: "ms", text: "见 `/data/outputs/x/monthly.xlsx`" },
      ],
      saveChat: async () => {},
      resolveProjectFile: async (_root: string, _ref: string) => "/data/outputs/x/monthly.xlsx",
      openPath,
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
    // 点亮后只显示文件名(完整路径在 title)。
    await waitFor(() => expect(screen.getByText("monthly.xlsx")).toHaveClass("file-link"));
    fireEvent.click(screen.getByText("monthly.xlsx"));
    await waitFor(() =>
      expect(usePersonalStore.getState().filePreviewRequest).toEqual({
        projectId: "p1",
        path: "/data/outputs/x/monthly.xlsx",
        name: "monthly.xlsx",
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("项目会话 DOCX 链接 → 走右栏 Word 预览请求,不再系统打开", async () => {
    const openPath = vi.fn(async () => "");
    const abs = "/data/outputs/x/report.docx";
    const b = {
      loadChat: async () => [
        { kind: "text", who: "claude", time: "12:00", uid: "mw", text: `见 [报告](${abs})` },
      ],
      saveChat: async () => {},
      resolveProjectFile: async () => abs,
      readFileBinary: vi.fn(),
      openPath,
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );

    await waitFor(() => expect(screen.getByText("报告")).toHaveClass("file-link"));
    fireEvent.click(screen.getByText("报告"));

    await waitFor(() =>
      expect(usePersonalStore.getState().filePreviewRequest).toEqual({
        projectId: "p1",
        path: abs,
        name: "report.docx",
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("项目会话 PPTX 链接 → 走右栏演示文稿预览请求", async () => {
    const openPath = vi.fn(async () => "");
    const abs = "/data/outputs/x/slides.pptx";
    const b = {
      loadChat: async () => [
        { kind: "text", who: "claude", time: "12:00", uid: "mp", text: `见 [演示文稿](${abs})` },
      ],
      saveChat: async () => {},
      resolveProjectFile: async () => abs,
      readFileBinary: vi.fn(),
      openPath,
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );

    await waitFor(() => expect(screen.getByText("演示文稿")).toHaveClass("file-link"));
    fireEvent.click(screen.getByText("演示文稿"));
    await waitFor(() =>
      expect(usePersonalStore.getState().filePreviewRequest).toEqual({
        projectId: "p1",
        path: abs,
        name: "slides.pptx",
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("聊天 DOCX 附件 chip → 复用文件打开路由进入右栏预览", async () => {
    const abs = "/Users/mike/Library/Application Support/cortex/chat-docs/s1/report.docx";
    const b = {
      loadChat: async () => [
        {
          kind: "text",
          who: "me",
          time: "12:00",
          uid: "ma",
          text: "请审阅",
          files: [{ path: abs, name: "季度报告.docx", mimeType: "application/docx", sizeBytes: 10 }],
        },
      ],
      saveChat: async () => {},
      fileExists: vi.fn(async () => true),
      readFileBinary: vi.fn(),
      openPath: vi.fn(async () => ""),
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "预览附件：季度报告.docx" }));
    await waitFor(() =>
      expect(usePersonalStore.getState().filePreviewRequest).toEqual({
        projectId: "p1",
        path: abs,
        name: "report.docx",
      }),
    );
  });

  it("无项目会话 DOCX + 二进制桥 → 聊天区 Word 浮层打开", async () => {
    usePersonalStore.setState({
      sessions: [{ id: "s5", title: "报告", agent: "codex", createdAt: NOW, updatedAt: NOW, noProjectDir: "/tmp/x" }],
      activeProjectId: undefined,
      activeSessionId: "s5",
    });
    const abs = "/Users/mike/.codex/outputs/report.docx";
    const readFileBinary = vi.fn(async () => ({
      data: "UEsDBA==",
      truncated: false,
      size: 4,
      mtimeMs: 1,
    }));
    const openPath = vi.fn(async () => "");
    const b = {
      loadChat: async () => [{ kind: "text", who: "codex", time: "06:03", uid: "m5", text: `产物在 [报告](${abs})` }],
      saveChat: async () => {},
      fileExists: vi.fn(async () => true),
      readFileBinary,
      openPath,
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );

    await waitFor(() => expect(screen.getByText("报告")).toHaveClass("file-link"));
    fireEvent.click(screen.getByText("报告"));

    expect(await screen.findByLabelText("report.docx Word 文档预览")).toBeInTheDocument();
    expect(openPath).not.toHaveBeenCalled();
  });

  it("无项目会话 PPTX + 二进制桥 → 聊天区演示文稿浮层打开", async () => {
    usePersonalStore.setState({
      sessions: [{ id: "s6", title: "演示", agent: "codex", createdAt: NOW, updatedAt: NOW, noProjectDir: "/tmp/x" }],
      activeProjectId: undefined,
      activeSessionId: "s6",
    });
    const abs = "/Users/mike/.codex/outputs/slides.pptx";
    const openPath = vi.fn(async () => "");
    const b = {
      loadChat: async () => [{ kind: "text", who: "codex", time: "06:03", uid: "m6", text: `产物在 [演示](${abs})` }],
      saveChat: async () => {},
      fileExists: vi.fn(async () => true),
      readFileBinary: vi.fn(async () => ({ data: "UEsDBA==", truncated: false, size: 4, mtimeMs: 1 })),
      openPath,
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );

    await waitFor(() => expect(screen.getByText("演示")).toHaveClass("file-link"));
    fireEvent.click(screen.getByText("演示"));

    expect(await screen.findByLabelText("slides.pptx 演示文稿预览")).toBeInTheDocument();
    expect(openPath).not.toHaveBeenCalled();
  });

  it("历史会话:file:/// HTML 链接保留绝对路径并在内置浏览器打开", async () => {
    const noProjectDir = "/Users/mike/Documents/cortex/2026-07-23";
    const expectedPath = `${noProjectDir}/outputs/report.html`;
    const fileUrl = `file://${expectedPath}`;
    usePersonalStore.setState({
      sessions: [
        { id: "s2", title: "Session 2", agent: "claude", createdAt: NOW, updatedAt: NOW, noProjectDir },
      ],
      activeProjectId: undefined,
      activeSessionId: "s2",
    });
    const openPath = vi.fn(async () => "");
    const fileExists = vi.fn(async () => true);
    const browserResolveLocalHtml = vi.fn(async () => fileUrl);
    const b = {
      loadChat: async () => [
        {
          kind: "text",
          who: "claude",
          time: "12:02",
          uid: "m2",
          // 真实历史存档格式:react-markdown 默认会把 file:// href 清空,导致 DevTools 只剩 <a href>。
          text: `已生成 [outputs/report.html](file://${expectedPath})`,
        },
      ],
      saveChat: async () => {},
      fileExists,
      openPath,
      browserResolveLocalHtml,
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );

    const link = await screen.findByRole("link", { name: "outputs/report.html" });
    await waitFor(() => expect(link).toHaveClass("file-link"));
    fireEvent.click(link);

    await waitFor(() => expect(browserResolveLocalHtml).toHaveBeenCalledWith(expectedPath));
    expect(fileExists).toHaveBeenCalledWith(expectedPath);
    expect(usePersonalStore.getState().browserUrlRequest?.url).toBe(fileUrl);
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
    expect(openPath).not.toHaveBeenCalled();
    expect(usePersonalStore.getState().filePreviewRequest).toBeUndefined();
  });

  it("无项目会话:codex 绝对路径产物(.docx)经 fileExists 命中 → 可点 + 系统打开(截图回归)", async () => {
    // 复现用户截图:无项目会话里 codex 输出指向项目外绝对路径的文件,旧逻辑(!projectPath 短路)→
    // 死链接点击无反应。现按 fileExists 存在性放行,点击经 openPath 系统打开。
    usePersonalStore.setState({
      sessions: [{ id: "s3", title: "总结", agent: "codex", createdAt: NOW, updatedAt: NOW, noProjectDir: "/tmp/x" }],
      activeProjectId: undefined,
      activeSessionId: "s3",
    });
    const openPath = vi.fn(async () => "");
    const fileExists = vi.fn(async () => true);
    const abs = "/Users/mike/.codex/outputs/report.docx";
    const b = {
      loadChat: async () => [{ kind: "text", who: "codex", time: "06:03", uid: "m3", text: `产物在 [报告](${abs})` }],
      saveChat: async () => {},
      fileExists,
      openPath,
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
    await waitFor(() => expect(screen.getByText("报告")).toHaveClass("file-link"));
    fireEvent.click(screen.getByText("报告"));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith(abs));
    expect(usePersonalStore.getState().filePreviewRequest).toBeUndefined();
  });

  it("无项目会话:xlsx + 二进制桥 → 聊天区 SheetOverlay 浮层打开,不走系统打开", async () => {
    usePersonalStore.setState({
      sessions: [{ id: "s4", title: "分析", agent: "claude", createdAt: NOW, updatedAt: NOW, noProjectDir: "/tmp/x" }],
      activeProjectId: undefined,
      activeSessionId: "s4",
    });
    const openPath = vi.fn(async () => "");
    // 无效 xlsx 字节:SheetViewer 解析失败降级错误占位,但浮层与二进制读取路径已生效。
    const readFileBinary = vi.fn(async () => ({ data: "AAAA", truncated: false, size: 3, mtimeMs: 1 }));
    const abs = "/Users/mike/Documents/cortex/2026-07-18/财务分析.xlsx";
    const b = {
      loadChat: async () => [{ kind: "text", who: "claude", time: "06:03", uid: "m4", text: `文件在 [工作簿](${abs})` }],
      saveChat: async () => {},
      fileExists: vi.fn(async () => true),
      openPath,
      readFileBinary,
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
    await waitFor(() => expect(screen.getByText("工作簿")).toHaveClass("file-link"));
    fireEvent.click(screen.getByText("工作簿"));
    // 浮层头部显示文件名,且经二进制通道读取;不再交系统应用打开。
    await waitFor(() => expect(screen.getByText("财务分析.xlsx")).toBeInTheDocument());
    await waitFor(() => expect(readFileBinary).toHaveBeenCalledWith(abs));
    expect(openPath).not.toHaveBeenCalled();
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

  it("历史 reasoning 经加载被 sanitize 清理,不再渲染思考块", async () => {
    renderAreaWithChat([
      { kind: "reasoning", who: "pi", time: "12:00", uid: "r1", text: "让我想想这个问题" },
      { kind: "text", who: "pi", time: "12:01", uid: "a1", text: "这是答案" },
    ]);
    // 历史思考(reasoning)不作为长期记录,加载时已被剔除;正文照常渲染。
    expect(await screen.findByText("这是答案")).toBeInTheDocument();
    expect(screen.queryByText("思考过程")).toBeNull();
    expect(screen.queryByText("让我想想这个问题")).toBeNull();
  });

  it("点「思考过程」头部可折叠隐藏思考正文", async () => {
    renderMessageStream([{ kind: "reasoning", who: "pi", time: "12:00", uid: "r1", text: "思考内容X", active: true }]);
    const head = screen.getByText("思考过程");
    expect(screen.getByText("思考内容X")).toBeInTheDocument();
    fireEvent.click(head);
    expect(screen.queryByText("思考内容X")).toBeNull();
  });

  // pi 运行时徽标（压缩/重试/待注入/思考强度）已随会话标题上移到中栏顶栏,
  // 相关断言移至 PersonalTopBar.test.tsx（PersonalSessionHeader）。
});

describe("PersonalChatArea 历史会话分页渲染窗口", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: "s1", projectId: "p1", title: "S1", agent: "claude", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: "s1",
      timelineProjectId: undefined,
      runningBySession: {},
    });
  });

  // n 条用户文本消息(走 renderRich 纯文本,findByText 稳定)。
  const many = (n: number, prefix = "消息"): Message[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: "text" as const,
      who: "me",
      time: "10:00",
      text: `${prefix}${i + 1}`,
      uid: `m${i + 1}`,
    }));

  it("默认只渲染尾部 20 条,更早的折叠", async () => {
    renderAreaWithChat(many(30));
    expect(await screen.findByText("消息30")).toBeInTheDocument();
    expect(screen.getByText("消息11")).toBeInTheDocument(); // 尾部第 20 条
    expect(screen.queryByText("消息10")).toBeNull(); // 第 21 条往前折叠
    expect(screen.queryByText("消息1")).toBeNull();
  });

  it("折叠时显示「展开更多」入口并标注剩余条数", async () => {
    renderAreaWithChat(many(30));
    await screen.findByText("消息30");
    expect(screen.getByText(/还有 10 条更早消息/)).toBeInTheDocument();
    expect(screen.getByText("展开更多")).toBeInTheDocument();
  });

  it("点「展开更多」多渲染一页,覆盖全部后入口消失", async () => {
    renderAreaWithChat(many(30));
    await screen.findByText("消息30");
    fireEvent.click(screen.getByText("展开更多"));
    expect(await screen.findByText("消息1")).toBeInTheDocument(); // 20→40 覆盖 30 条
    expect(screen.getByText("消息10")).toBeInTheDocument();
    expect(screen.queryByText("展开更多")).toBeNull();
  });

  it("消息不足 20 条:不显示入口,全部渲染", async () => {
    renderAreaWithChat(many(12));
    expect(await screen.findByText("消息12")).toBeInTheDocument();
    expect(screen.getByText("消息1")).toBeInTheDocument();
    expect(screen.queryByText("展开更多")).toBeNull();
  });

  it("切换会话后窗口重置为尾部 20 条", async () => {
    const b = {
      loadChat: async (sid: string) => (sid === "s1" ? many(30) : many(25, "B")),
      saveChat: async () => {},
    } as unknown as DesktopBridge;
    usePersonalStore.setState({
      sessions: [
        { id: "s1", projectId: "p1", title: "S1", agent: "claude", createdAt: NOW, updatedAt: NOW },
        { id: "s2", projectId: "p1", title: "S2", agent: "claude", createdAt: NOW, updatedAt: NOW },
      ],
    });
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
    await screen.findByText("消息30");
    fireEvent.click(screen.getByText("展开更多"));
    await screen.findByText("消息1"); // s1 全展开

    usePersonalStore.getState().setActiveSession("s2");
    expect(await screen.findByText("B25")).toBeInTheDocument();
    expect(screen.getByText("B6")).toBeInTheDocument(); // 尾部 20(25-20+1=6)
    expect(screen.queryByText("B5")).toBeNull(); // 窗口已重置,更早折叠
  });

  it("/clear 后:窗口优先,展完可见集才出现「显示隐藏」入口", async () => {
    usePersonalStore.setState({
      sessions: [
        {
          id: "s1",
          projectId: "p1",
          title: "S1",
          agent: "claude",
          createdAt: NOW,
          updatedAt: NOW,
          hiddenHistory: { count: 5, throughUid: "m5", hiddenAt: NOW },
        },
      ],
    });
    renderAreaWithChat(many(30)); // 隐藏 m1..m5 → 可见 m6..m30(25 条)
    await screen.findByText("消息30");
    expect(screen.getByText(/还有 5 条更早消息/)).toBeInTheDocument(); // 25-20=5
    expect(screen.queryByText(/已隐藏/)).toBeNull(); // 窗口未展完,不显示隐藏 gate
    fireEvent.click(screen.getByText("展开更多")); // +20 → 覆盖可见 25 条
    expect(await screen.findByText("消息6")).toBeInTheDocument(); // 可见集顶部
    expect(screen.queryByText("消息5")).toBeNull(); // 仍属 /clear 隐藏区
    expect(screen.getByText(/已隐藏 5 条历史记录/)).toBeInTheDocument(); // 现在出现隐藏 gate
  });
});

describe("PersonalChatArea 运行态占位位置", () => {
  afterEach(() => cleanup());

  function renderRunning(opts: {
    messages?: Message[];
    process?: Message[];
    running?: boolean;
    sessionId?: string;
  }) {
    const sessionId = opts.sessionId ?? "s1";
    const qc = new QueryClient();
    if (opts.process) qc.setQueryData(personalProcessKeys.detail(sessionId), opts.process);
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: sessionId, projectId: "p1", title: "S1", agent: "claude", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: sessionId,
      timelineProjectId: undefined,
      runningBySession: opts.running ? { [sessionId]: "run-1" } : {},
      piRuntimeBySession: {},
    });
    const b = { loadChat: async () => opts.messages ?? [], saveChat: async () => {} } as unknown as DesktopBridge;
    const view = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b} queryClient={qc}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
    return { qc, view, sessionId };
  }

  it("running=true 时不在消息流外渲染 .pw-running-hint", async () => {
    const { view } = renderRunning({ messages: [], running: true });
    await waitFor(() => expect(view.container.querySelector(".chat")).toBeInTheDocument());
    expect(view.container.querySelector(".pw-running-hint")).toBeNull();
  });

  it("即便有过程流,也不在输入框上方渲染外部运行提示", async () => {
    const process: Message[] = [
      {
        kind: "agentLog",
        who: "claude",
        time: "12:00",
        title: "执行",
        active: true,
        items: [
          { ic: "check", text: "Bash · ls" },
          { ic: "running", text: "Edit · b.ts" },
        ],
        uid: "log1",
      },
    ];
    const { view } = renderRunning({ messages: [], process, running: true });
    await waitFor(() => expect(view.container.querySelector(".chat")).toBeInTheDocument());
    expect(view.container.querySelector(".pw-running-hint")).toBeNull();
  });
});

describe("PersonalChatArea editResend 截断后中栏不闪回旧 agentLog（U5·R12）", () => {
  afterEach(() => cleanup());

  const claudeSession: SessionMeta = {
    id: "s1",
    projectId: "p1",
    title: "S1",
    agent: "claude",
    agentSessionIds: { claude: "c1" },
    createdAt: NOW,
    updatedAt: NOW,
  };

  // 探针组件:把 editResend 暴露到外部引用,便于在 act 里驱动真实编辑重发链路。
  function EditResendProbe({ onReady }: { onReady: (fn: ReturnType<typeof usePersonalActions>["editResend"]) => void }) {
    const { editResend } = usePersonalActions();
    onReady(editResend);
    return null;
  }

  it("旧档缓存含 agentLog,editResend 截断后写回缓存被 sanitize → 中栏不渲染 .agent-log", async () => {
    const qc = new QueryClient();
    // 旧档残留:u1(问) → agentLog(旧工具步骤) → a1(答) → u2(待编辑问) → a2(答)。
    const stale: Message[] = [
      { kind: "text", who: "me", time: "10:00", uid: "u1", text: "第一问" },
      {
        kind: "agentLog",
        who: "claude",
        time: "10:01",
        uid: "g1",
        title: "旧执行",
        active: false,
        completed: true,
        items: [{ ic: "check", text: "Edit · old.ts" }],
      },
      { kind: "text", who: "claude", time: "10:02", uid: "a1", text: "第一答" },
      { kind: "text", who: "me", time: "10:03", uid: "u2", text: "第二问" },
      { kind: "text", who: "claude", time: "10:04", uid: "a2", text: "第二答" },
    ];
    qc.setQueryData(personalChatKeys.detail("s1"), stale);
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [claudeSession],
      activeProjectId: "p1",
      activeSessionId: "s1",
      agentsAvailable: { claude: true, codex: true, pi: true },
      runningBySession: {},
      timelineProjectId: undefined,
    });
    // loadChat 返回同一份旧档（ensureChatLoaded 内部已过 sanitize,但缓存里已是含 agentLog 的脏态:
    // 模拟「加载后流式期写入又未及重载」的边界,固化 editResend 写回前 sanitize 的护栏）。
    const b = {
      loadChat: async () => stale,
      saveChat: vi.fn(async () => undefined),
      startCli: vi.fn(async () => undefined),
      killCli: vi.fn(async () => undefined),
      trimAgentSession: vi.fn(async () => true),
    } as unknown as DesktopBridge;

    let editResendFn: ReturnType<typeof usePersonalActions>["editResend"] | undefined;
    const view = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b} queryClient={qc}>
        <PersonalChatArea onToast={() => {}} />
        <EditResendProbe onReady={(fn) => (editResendFn = fn)} />
      </CoreProvider>,
    );
    // 初始:旧档含 agentLog → 中栏内联渲染 .agent-log（编辑前的现状）。
    await screen.findByText("第二答");
    expect(view.container.querySelector(".agent-log")).toBeInTheDocument();

    // 编辑重发「第二问」(u2):截断到 u2 之前 → [u1, agentLog, a1],写回前 sanitize → agentLog 被剥离。
    await act(async () => {
      await editResendFn!(claudeSession, "/code/alpha", "u2", "改后的第二问", []);
    });

    // 落盘内容不含 agentLog（saveChat 经 sanitizeForSave）。
    for (const call of (b.saveChat as ReturnType<typeof vi.fn>).mock.calls) {
      const saved = call[1] as Message[];
      expect(saved.some((m) => m.kind === "agentLog")).toBe(false);
    }
    // 缓存（中栏数据源）也不再含 agentLog → 中栏不再渲染 .agent-log（不闪回旧工具步骤）。
    const cached = qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? [];
    expect(cached.some((m) => m.kind === "agentLog")).toBe(false);
    await waitFor(() => expect(view.container.querySelector(".agent-log")).toBeNull());
    // 重发经 startCli（claude 链路,R10 零回归）。
    expect((b.startCli as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("Pi 编辑重发 fork 失败时不再显示定位告警,并清理旧告警", async () => {
    const qc = new QueryClient();
    const piSession: SessionMeta = {
      id: "s1",
      projectId: "p1",
      title: "S1",
      agent: "pi",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const warning = "⚠️ 未能在 pi 侧定位编辑点,已带原有上下文重发（pi 仍记得被编辑前的内容）。";
    // 报错提示在生产中恒由 uid("err") 创建（→ "err-…"）；sanitizeForSave 按该命名空间剥离。
    const stale: Message[] = [
      { kind: "text", who: "pi", time: "09:18", uid: "err-1-w1", text: warning },
      { kind: "text", who: "pi", time: "09:36", uid: "err-2-w2", text: warning },
      { kind: "text", who: "me", time: "09:49", uid: "u2", text: "总结提交" },
      { kind: "text", who: "pi", time: "09:50", uid: "a2", text: "旧回答" },
    ];
    qc.setQueryData(personalChatKeys.detail("s1"), stale);
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [piSession],
      activeProjectId: "p1",
      activeSessionId: "s1",
      agentsAvailable: { claude: true, codex: true, pi: true },
      runningBySession: {},
      timelineProjectId: undefined,
    });
    const b = {
      loadChat: async () => stale,
      saveChat: vi.fn(async () => undefined),
      piOpen: vi.fn(async () => ({ uiSessionId: "s1", sessionId: "pi-live", sessionFile: "/tmp/pi.jsonl" })),
      piPrompt: vi.fn(async () => undefined),
    } as unknown as DesktopBridge;

    let editResendFn: ReturnType<typeof usePersonalActions>["editResend"] | undefined;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b} queryClient={qc}>
        <PersonalChatArea onToast={() => {}} />
        <EditResendProbe onReady={(fn) => (editResendFn = fn)} />
      </CoreProvider>,
    );
    await screen.findByText("旧回答");

    await act(async () => {
      await editResendFn!(piSession, "/code/alpha", "u2", "重新总结", []);
    });

    const cached = qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? [];
    expect(cached.filter((m) => m.kind === "text" && m.who === "pi" && m.text === warning)).toHaveLength(0);
    expect(cached.some((m) => m.kind === "text" && m.who === "pi" && m.uid === "err-1-w1")).toBe(false);
    usePersonalStore.getState().setRunning("s1", undefined);
  });

  it("Pi 编辑重发 /skill:slides 仍创建隔离产物并走内置 skill", async () => {
    const qc = new QueryClient();
    const piSession: SessionMeta = {
      id: "s1",
      projectId: "p1",
      title: "已有会话",
      agent: "pi",
      providerId: "deepseek",
      model: "deepseek-v4-flash",
      useOwnSkills: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const stale: Message[] = [
      { kind: "text", who: "me", time: "18:25", uid: "u1", text: "帮我做一个简单的演示文稿" },
      { kind: "text", who: "pi", time: "18:26", uid: "a1", text: "旧回答" },
    ];
    const artifact = {
      kind: "slides" as const,
      documentId: "slides-1",
      title: "帮我做一个简单的演示文稿",
      workspaceRoot: "/code/alpha/.cortex-design/slides-1",
      entryPath: "/code/alpha/.cortex-design/slides-1/deck.bento.html",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const artifactCreate = vi.fn(async () => ({ ok: true as const, artifact }));
    const startCli = vi.fn(async () => undefined);
    const piPrompt = vi.fn(async () => undefined);
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [piSession],
      activeProjectId: "p1",
      activeSessionId: "s1",
      agentsAvailable: { claude: true, codex: true, pi: true },
      runningBySession: {},
      piRuntimeBySession: {},
      timelineProjectId: undefined,
      rightView: "files",
      providerSettings: {
        providers: [
          {
            id: "deepseek",
            name: "DeepSeek",
            baseUrl: "https://api.deepseek.com",
            apiKey: "sk-test",
            endpointFormat: "chat_completions",
            enabled: true,
            models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
          },
        ],
        defaultProviderId: "deepseek",
        defaultModel: "deepseek-v4-flash",
      },
    });
    useCortexUIStore.setState({ rightOpen: false });
    const b = {
      loadChat: async () => stale,
      saveChat: vi.fn(async () => undefined),
      artifactCreate,
      builtinSkillGet: async () => ({
        name: "slides",
        description: "创建演示文稿",
        dir: "/builtin/slides",
        skillMdPath: "/builtin/slides/SKILL.md",
      }),
      piSkillsList: async () => [],
      startCli,
      piOpen: vi.fn(async () => ({ uiSessionId: "s1", sessionId: "pi-live", sessionFile: "/tmp/pi.jsonl" })),
      piPrompt,
    } as unknown as DesktopBridge;

    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b} queryClient={qc}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
    await screen.findByText("旧回答");

    fireEvent.click(screen.getByTitle("编辑后重新发送(将清除其后的所有消息)"));
    const input = screen.getByRole("textbox");
    await waitFor(() => expect(input).toHaveValue("帮我做一个简单的演示文稿"));
    fireEvent.change(input, { target: { value: "/skill:slides 帮我做一个简单的演示文稿" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(artifactCreate).toHaveBeenCalledWith({
        kind: "slides",
        title: "帮我做一个简单的演示文稿",
        projectId: "p1",
      }),
    );
    await waitFor(() => expect(startCli).toHaveBeenCalled());
    expect(startCli).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "pi",
        cwd: artifact.workspaceRoot,
        prompt: "/skill:slides 帮我做一个简单的演示文稿",
        artifactContext: artifact,
        model: "deepseek-v4-flash",
        provider: {
          id: "deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-test",
          models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        },
        skillPaths: ["/builtin/slides"],
        invokedSkill: undefined,
      }),
    );
    expect(piPrompt).not.toHaveBeenCalled();
    expect(usePersonalStore.getState()).toMatchObject({
      rightView: "artifact",
      sessions: [expect.objectContaining({ id: "s1", activeArtifact: artifact })],
    });
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
    usePersonalStore.getState().setRunning("s1", undefined);
  });
});

// U5:assistant 消息「追问」按钮 + 浮层挂载 + Web/能力门控。
describe("PersonalChatArea 追问入口（U5）", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: "s1", projectId: "p1", title: "S1", agent: "claude", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: "s1",
      timelineProjectId: undefined,
      runningBySession: {},
      providerSettings: { providers: [] },
    });
  });

  // 带 askFollowupStream 能力的桥（桌面端）。
  function bridgeWithAsk(messages: Message[]): DesktopBridge {
    return {
      loadChat: async () => messages,
      saveChat: async () => {},
      askFollowupStream: async () => {},
      onAskFollowupEvent: () => () => {},
      cancelFollowup: async () => {},
    } as unknown as DesktopBridge;
  }

  function renderWith(b: DesktopBridge) {
    return render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
  }

  it("assistant 文本消息出现「追问」按钮,排在复制/朗读之后", async () => {
    renderWith(bridgeWithAsk([{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "答案正文" }]));
    await screen.findByText("答案正文");
    const followBtn = screen.getByRole("button", { name: "追问" });
    expect(followBtn).toBeInTheDocument();
    // 同一操作行内:复制在追问之前(顺序固定)。
    const row = followBtn.closest(".m-act-row");
    const btns = row ? Array.from(row.querySelectorAll<HTMLButtonElement>("button")) : [];
    const copyIdx = btns.findIndex((b) => b.getAttribute("title") === "复制回复内容");
    const followIdx = btns.findIndex((b) => b === followBtn);
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(followIdx).toBeGreaterThan(copyIdx);
  });

  it("me（用户）消息不出现「追问」按钮", async () => {
    renderWith(bridgeWithAsk([{ kind: "text", who: "me", time: "12:00", uid: "m1", text: "我的问题" }]));
    await screen.findByText("我的问题");
    expect(screen.queryByRole("button", { name: "追问" })).toBeNull();
  });

  it("无 askFollowupStream 能力（Web/旧壳）→ 不渲染「追问」按钮", async () => {
    const webBridge = { loadChat: async () => [{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "答案正文" }], saveChat: async () => {} } as unknown as DesktopBridge;
    renderWith(webBridge);
    await screen.findByText("答案正文");
    expect(screen.queryByRole("button", { name: "追问" })).toBeNull();
  });

  it("点击「追问」→ 打开浮层,种子为该条正文(R2)", async () => {
    renderWith(bridgeWithAsk([{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "可被追问的回复" }]));
    await screen.findByText("可被追问的回复");
    fireEvent.click(screen.getByRole("button", { name: "追问" }));
    // 浮层就绪:dialog + 种子正文(浮层内再次出现该文本)。
    const dialog = await screen.findByRole("dialog", { name: "追问" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("就这条回复追问")).toBeInTheDocument();
    // 浮层内出现种子正文(顶部种子区)。
    expect(screen.getAllByText("可被追问的回复").length).toBeGreaterThanOrEqual(1);
  });

  it("关闭浮层 → 焦点归还触发按钮", async () => {
    renderWith(bridgeWithAsk([{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "回复正文Z" }]));
    await screen.findByText("回复正文Z");
    const trigger = screen.getByRole("button", { name: "追问" });
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "追问" });
    // 点关闭(浮层右上角 X)。
    fireEvent.click(screen.getByTitle("关闭"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "追问" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("pi 自定义供应商:sessionCtx.provider 经 askFollowupStream 解析传入", async () => {
    usePersonalStore.setState({
      sessions: [
        { id: "s1", projectId: "p1", title: "S1", agent: "pi", createdAt: NOW, updatedAt: NOW, providerId: "deepseek", model: "ds-chat" },
      ],
      providerSettings: {
        providers: [
          {
            id: "deepseek",
            name: "DeepSeek",
            baseUrl: "https://api.deepseek.com",
            apiKey: "sk-x",
            endpointFormat: "chat_completions",
            enabled: true,
            models: [{ id: "ds-chat", label: "DeepSeek Chat" }],
          },
        ],
        defaultProviderId: "deepseek",
      },
    });
    const askSpy = vi.fn(async (_req: { agent: string; model?: string; cwd: string; provider?: { id: string; baseUrl: string; apiKey?: string } }) => {});
    const b = {
      loadChat: async () => [{ kind: "text", who: "pi", time: "12:00", uid: "a1", text: "pi 的回复" }],
      saveChat: async () => {},
      askFollowupStream: askSpy,
      onAskFollowupEvent: () => () => {},
      cancelFollowup: async () => {},
    } as unknown as DesktopBridge;
    renderWith(b);
    await screen.findByText("pi 的回复");
    fireEvent.click(screen.getByRole("button", { name: "追问" }));
    await screen.findByRole("dialog", { name: "追问" });
    // 在浮层里发一问,验证传入的 sessionCtx(agent/model/cwd/provider)。
    const ta = screen.getByPlaceholderText(/继续追问/);
    fireEvent.change(ta, { target: { value: "为什么?" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(askSpy).toHaveBeenCalled());
    const req = askSpy.mock.calls[0]![0];
    expect(req.agent).toBe("pi");
    expect(req.model).toBe("ds-chat");
    expect(req.cwd).toBe("/code/alpha");
    expect(req.provider).toMatchObject({ id: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-x" });
  });

  it("无项目会话:cwd 取 noProjectDir,仍可发起追问(R9 由主进程兜底)", async () => {
    usePersonalStore.setState({
      sessions: [
        { id: "s2", title: "S2", agent: "claude", createdAt: NOW, updatedAt: NOW, noProjectDir: "/tmp/noproj" },
      ],
      activeProjectId: undefined,
      activeSessionId: "s2",
    });
    const askSpy = vi.fn(async (_req: { agent: string; model?: string; cwd: string; provider?: { id: string; baseUrl: string; apiKey?: string } }) => {});
    const b = {
      loadChat: async () => [{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "无项目回复" }],
      saveChat: async () => {},
      askFollowupStream: askSpy,
      onAskFollowupEvent: () => () => {},
      cancelFollowup: async () => {},
    } as unknown as DesktopBridge;
    renderWith(b);
    await screen.findByText("无项目回复");
    fireEvent.click(screen.getByRole("button", { name: "追问" }));
    await screen.findByRole("dialog", { name: "追问" });
    const ta = screen.getByPlaceholderText(/继续追问/);
    fireEvent.change(ta, { target: { value: "追问内容" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(askSpy).toHaveBeenCalled());
    expect(askSpy.mock.calls[0]![0].cwd).toBe("/tmp/noproj");
    // 无真实项目 → tightenTools=true(FIX-3,主进程据此剥离跳审批标志)。
    expect((askSpy.mock.calls[0]![0] as { tightenTools?: boolean }).tightenTools).toBe(true);
  });

  it("真实项目会话:tightenTools=false(FIX-3)", async () => {
    const askSpy = vi.fn(async (_req: { tightenTools?: boolean }) => {});
    const b = {
      loadChat: async () => [{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "有项目回复" }],
      saveChat: async () => {},
      askFollowupStream: askSpy,
      onAskFollowupEvent: () => () => {},
      cancelFollowup: async () => {},
    } as unknown as DesktopBridge;
    renderWith(b);
    await screen.findByText("有项目回复");
    fireEvent.click(screen.getByRole("button", { name: "追问" }));
    await screen.findByRole("dialog", { name: "追问" });
    const ta = screen.getByPlaceholderText(/继续追问/);
    fireEvent.change(ta, { target: { value: "问" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(askSpy).toHaveBeenCalled());
    expect((askSpy.mock.calls[0]![0] as { tightenTools?: boolean }).tightenTools).toBe(false);
  });

  it("追问继承当前会话 effort", async () => {
    usePersonalStore.setState({
      sessions: [
        { id: "s1", projectId: "p1", title: "S1", agent: "claude", effort: "high", createdAt: NOW, updatedAt: NOW },
      ],
    });
    const askSpy = vi.fn(async (_req: { effort?: string }) => {});
    const b = {
      loadChat: async () => [{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "可追问回复" }],
      saveChat: async () => {},
      askFollowupStream: askSpy,
      onAskFollowupEvent: () => () => {},
      cancelFollowup: async () => {},
    } as unknown as DesktopBridge;
    renderWith(b);
    await screen.findByText("可追问回复");
    fireEvent.click(screen.getByRole("button", { name: "追问" }));
    await screen.findByRole("dialog", { name: "追问" });
    const ta = screen.getByPlaceholderText(/继续追问/);
    fireEvent.change(ta, { target: { value: "继续?" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(askSpy).toHaveBeenCalled());
    expect((askSpy.mock.calls[0]![0] as { effort?: string }).effort).toBe("high");
  });

  it("仅 askFollowupStream、缺 onAskFollowupEvent/cancelFollowup → 不渲染「追问」按钮(FIX-2)", async () => {
    const partial = {
      loadChat: async () => [{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "部分桥回复" }],
      saveChat: async () => {},
      askFollowupStream: async () => {},
      // onAskFollowupEvent / cancelFollowup 缺失(旧壳)。
    } as unknown as DesktopBridge;
    renderWith(partial);
    await screen.findByText("部分桥回复");
    expect(screen.queryByRole("button", { name: "追问" })).toBeNull();
  });
});

// FIX-1 / FIX-6:经真实 useFollowupAsk(浮层挂载)验证收尾语义与重试替换。
describe("PersonalChatArea 追问收尾语义(FIX-1 / FIX-6)", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: "s1", projectId: "p1", title: "S1", agent: "claude", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: "s1",
      timelineProjectId: undefined,
      runningBySession: {},
      providerSettings: { providers: [] },
    });
  });

  // 捕获事件回调的桥:emit(askId, event) 可主动注入 ask:event。
  function makeEventBridge() {
    let cb: ((askId: string, ev: unknown) => void) | null = null;
    const askSpy = vi.fn(async (_req: { askId: string }) => {});
    const cancelSpy = vi.fn(async (_askId: string) => {});
    const bridge = {
      loadChat: async () => [{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "种子回复" }],
      saveChat: async () => {},
      askFollowupStream: askSpy,
      onAskFollowupEvent: (fn: (askId: string, ev: unknown) => void) => {
        cb = fn;
        return () => {
          cb = null;
        };
      },
      cancelFollowup: cancelSpy,
    } as unknown as DesktopBridge;
    return {
      bridge,
      askSpy,
      cancelSpy,
      emit: (ev: unknown) => {
        const askId = askSpy.mock.calls[askSpy.mock.calls.length - 1]![0].askId;
        act(() => {
          cb?.(askId, ev);
        });
      },
    };
  }

  function renderWith(b: DesktopBridge) {
    return render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
  }

  async function openOverlayAndAsk(h: ReturnType<typeof makeEventBridge>, question: string) {
    renderWith(h.bridge);
    await screen.findByText("种子回复");
    fireEvent.click(screen.getByRole("button", { name: "追问" }));
    await screen.findByRole("dialog", { name: "追问" });
    const ta = screen.getByPlaceholderText(/继续追问/);
    fireEvent.change(ta, { target: { value: question } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(h.askSpy).toHaveBeenCalled());
  }

  it("init→(长间隔静默)→text→result:不被提前收尾,answer 正常渲染(FIX-1)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = makeEventBridge();
    await openOverlayAndAsk(h, "为什么?");

    // init 后推进 30s(远超旧的 1.5s grace),期间无新事件。
    h.emit({ type: "init", sessionId: "x" });
    vi.advanceTimersByTime(30_000);
    // 此时仍应在 running(未被提前判 done):停止按钮在,输入禁用。
    expect(screen.getByRole("button", { name: /停止/ })).toBeInTheDocument();

    // 真实 text 到达 → 必须被渲染(activeRef 仍在,未被代际守卫丢弃)。
    h.emit({ type: "text", delta: "因为如此" });
    expect(await screen.findByText("因为如此")).toBeInTheDocument();

    // result 才正常收尾 → running 关闭,回到「发送」按钮。
    h.emit({ type: "result", ok: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: /停止/ })).toBeNull());
  });

  it("仅 text 无 result:不再因 1.5s 不活动提前收尾(FIX-1,删除旧 grace 语义)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = makeEventBridge();
    await openOverlayAndAsk(h, "问");
    h.emit({ type: "text", delta: "片段" });
    vi.advanceTimersByTime(10_000); // 远超旧 1.5s
    // 没有 result → 仍在 running(旧实现此刻已误关)。
    expect(screen.getByRole("button", { name: /停止/ })).toBeInTheDocument();
  });

  it("error 轮重试:原位替换该轮而非并存(FIX-6)", async () => {
    const h = makeEventBridge();
    await openOverlayAndAsk(h, "会失败的问");
    // 失败收尾。
    h.emit({ type: "result", ok: false, error: "炸了" });
    expect(await screen.findByText("炸了")).toBeInTheDocument();

    // 点重试 → 应调 ask(question, retryOf);新轮替换旧 error 轮(turns 仍只 1 轮)。
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(h.askSpy).toHaveBeenCalledTimes(2));
    // 旧 error 文案消失(被替换),问题文本仍只出现一次。
    await waitFor(() => expect(screen.queryByText("炸了")).toBeNull());
    expect(screen.getAllByText("会失败的问")).toHaveLength(1);
  });
});

// U6:/skill:name 发送侧派发(纯函数,onSend 内组装并调用它们)。
describe("PersonalChatArea /skill 发送派发（U6）", () => {
  const skill: InjectableSkill = { name: "My Skill!", description: "干活", dir: "/g/s" };

  it("产物上下文明确锁定工作区、文稿 id 与入口", () => {
    const prompt = buildConversationArtifactPrompt({
      kind: "slides",
      documentId: "deck-1",
      title: "Quarterly",
      workspaceRoot: "/project",
      entryPath: "/project/.cortex-design/deck-1/deck.bento.html",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(prompt).toContain("类型:slides");
    expect(prompt).toContain("文稿 ID:deck-1");
    expect(prompt).toContain("入口:/project/.cortex-design/deck-1/deck.bento.html");
  });

  // 实测事故:agent 把海报写成了 <文稿目录>/poster.html + 自造 entry.json,而画布只扫描
  // <文稿目录>/<屏幕id>/v<N>.html —— 结果右侧画布一片空白,用户以为「设计没跑」。
  it("design 产物上下文写死画布能识别的落盘布局", () => {
    const prompt = buildConversationArtifactPrompt({
      kind: "design",
      documentId: "doc-1",
      title: "海报",
      workspaceRoot: "/project",
      entryPath: "/project/.cortex-design/doc-1",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(prompt).toContain("v1.html");
    expect(prompt).toContain("/project/.cortex-design/doc-1/<屏幕 id>/v1.html");
    // 两条踩过的坑必须显式禁止:写在文稿目录根、自造索引文件。
    expect(prompt).toContain("不要把 .html 直接写在文稿目录根");
    expect(prompt).toContain("entry.json");
    // design-system.json 由应用维护;agent 手写过一份自定义结构,直接让画布白屏。
    expect(prompt).toContain("design-system.json");
  });

  it("slides 产物不带 design 的画布布局契约(它走 cortex-slides 工具)", () => {
    const prompt = buildConversationArtifactPrompt({
      kind: "slides",
      documentId: "deck-1",
      title: "Quarterly",
      workspaceRoot: "/project",
      entryPath: "/project/.cortex-design/deck-1/deck.bento.html",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(prompt).not.toContain("v1.html");
  });

  describe("resolveSkillDispatch 主会话改写", () => {
    // allRecords 传本批次全部已启用 skill(此处只有一条),供 claude 分支推导跨进程一致的命令名。
    const allRecords = [skill];

    it("claude 单发 → 裸 slash,不带 invokedSkill", () => {
      const d = resolveSkillDispatch("claude", "/skill:my-skill foo bar", "foo bar", skill, allRecords);
      expect(d.outText).toBe(renderClaudeSkillSlash(skill, "foo bar", allRecords));
      expect(d.outText.startsWith("/")).toBe(true);
      expect(d.invokedSkill).toBeUndefined();
    });

    it("codex 单发 → 文本保留 args + 结构化 invokedSkill{name,path=dir}", () => {
      const d = resolveSkillDispatch("codex", "/skill:my-skill foo bar", "foo bar", skill, allRecords);
      expect(d.outText).toBe("foo bar");
      expect(d.invokedSkill).toEqual({ name: "My Skill!", path: "/g/s" });
    });

    it("codex 单发 + 空 args → 文本为空但仍带 invokedSkill(不丢原生触发)", () => {
      const d = resolveSkillDispatch("codex", "/skill:my-skill", "", skill, allRecords);
      expect(d.outText).toBe("");
      expect(d.invokedSkill).toEqual({ name: "My Skill!", path: "/g/s" });
    });

    it("第一方 design/slides skill 标记产物类型,普通 skill 不获得产物权限", () => {
      const design: InjectableSkill = { name: "design", dir: "/builtin/design" };
      const slides: InjectableSkill = { name: "slides", dir: "/builtin/slides" };

      expect(
        resolveSkillDispatch("codex", "/skill:design landing page", "landing page", design, [design]),
      ).toMatchObject({ artifactKind: "design" });
      expect(
        resolveSkillDispatch("claude", "/skill:slides quarterly review", "quarterly review", slides, [slides]),
      ).toMatchObject({ artifactKind: "slides" });
      expect(resolveSkillDispatch("codex", "/skill:my-skill", "", skill, allRecords)).not.toHaveProperty(
        "artifactKind",
      );
    });

    it("同批次命名碰撞时,裸 slash 与主进程桥接目录的消歧命名一致(code review 修复)", () => {
      // 两条 skill 归一化后同 slug("my/skill" 与 "my-skill" 都 → "my-skill")。
      const a: InjectableSkill = { name: "my/skill", dir: "/a" };
      const b: InjectableSkill = { name: "my-skill", dir: "/b" };
      const dispatchA = resolveSkillDispatch("claude", "/skill:a", "", a, [a, b]);
      const dispatchB = resolveSkillDispatch("claude", "/skill:b", "", b, [a, b]);
      // 先到者(a)拿裸 slug,后到者(b)必须拿到消歧后缀,两者裸 slash 不能相同——否则点 b 会误触发 a。
      expect(dispatchA.outText).toBe("/my-skill");
      expect(dispatchB.outText).not.toBe("/my-skill");
      expect(dispatchB.outText.startsWith("/my-skill-")).toBe(true);
    });
  });
});

// 新建会话(尚无消息)与新会话落地页应当是同一个页面:同样的 Hero + 场景 tab/chips,
// 唯一区别是落地页还要选项目、这里项目已经定了。避免两套落地内容各自漂移。
describe("PersonalChatArea 空会话落地内容", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: "s1", projectId: "p1", title: "S1", agent: "claude", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: "s1",
      timelineProjectId: undefined,
      runningBySession: {},
      composerSkill: undefined,
    });
  });

  it("没有任何消息时渲染与落地页相同的 Hero + 场景 chips", async () => {
    const { container } = renderAreaWithChat([]);
    await waitFor(() => expect(container.querySelector(".pw-hero-title")?.textContent).toBeTruthy());
    expect(screen.getByRole("tab", { name: "日常办公" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "设计创意" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "演示文稿" })).toBeInTheDocument();
  });

  it("已有消息时不再渲染落地内容(回到消息流)", async () => {
    const { container } = renderAreaWithChat([
      { kind: "text", who: "me", time: "10:00", text: "第一句", uid: "m1" },
    ]);
    expect(await screen.findByText("第一句")).toBeInTheDocument();
    expect(container.querySelector(".pw-hero-title")).toBeNull();
    expect(screen.queryByRole("tab", { name: "日常办公" })).toBeNull();
  });
});

// `/skill:<name>` 是派发指令不是内容。pi 会话把整条命令原样透传给 CLI（存储 == 发送文本），
// 于是气泡里就露出「/skill:incident-apology-report 昨晚…」（用户实测）。这里守显示层剥前缀，
// 与 core 侧 fallbackTitle 剥标题是同一口径、同一个 stripSkillDirective。
describe("PersonalChatArea 会话流不显示 /skill: 派发前缀", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: "s1", projectId: "p1", title: "S1", agent: "pi", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: "s1",
      runningBySession: {},
    });
  });

  it("用户消息只显示内容,不显示 /skill:<name>", async () => {
    renderAreaWithChat([
      {
        kind: "text",
        who: "me",
        time: "11:19",
        uid: "u1",
        text: "/skill:incident-apology-report 昨晚 23:05 到今天 01:10 平台无法访问",
      },
    ]);
    expect(await screen.findByText(/昨晚 23:05 到今天 01:10 平台无法访问/)).toBeInTheDocument();
    expect(screen.queryByText(/\/skill:incident-apology-report/)).toBeNull();
  });

  // 只敲命令没写内容时剥干净会得到空气泡 —— 那比露出前缀更糟,保持原样。
  it("无参数的 /skill: 消息原样显示(不产出空气泡)", async () => {
    renderAreaWithChat([{ kind: "text", who: "me", time: "11:20", uid: "u1", text: "/skill:design" }]);
    expect(await screen.findByText("/skill:design")).toBeInTheDocument();
  });

  // agent 侧文本不碰:它可能在正常讲解「用 /skill:xxx 可以……」,剥掉就改写了 agent 的话。
  it("agent 侧消息里的 /skill: 文本不动", async () => {
    renderAreaWithChat([
      { kind: "text", who: "pi", time: "11:21", uid: "a1", text: "/skill:design 是创建设计稿的命令" },
    ]);
    expect(await screen.findByText(/\/skill:design 是创建设计稿的命令/)).toBeInTheDocument();
  });
});

// /skill:research 分叉：研究由 CRE 引擎跑，**这条路径绝不能走到 agent 上**。
//
// 守两件事：一是不 spawn CLI（走上 send 的老路会让每次发起研究白烧一轮 agent 的钱，
// 而界面上看不出异常）；二是不落到产物派发（研究没有可以喂给 agent 的 outText）。
describe("PersonalChatArea /skill:research 派发分叉", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: "s1", projectId: "p1", title: "S1", agent: "claude", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: "s1",
      runningBySession: {},
      providerSettings: { providers: [] },
    });
    // generalSettings 是整块结构，只改研究切片要走展开写法（其余字段仍需存在）。
    usePersonalStore.setState((s) => ({
      generalSettings: {
        ...s.generalSettings,
        researchEngine: normalizeResearchEngineSettings({ enabled: true, deepResearchEnabled: true }),
      },
    }));
  });

  function researchBridge(createRejects?: Error) {
    const create = vi.fn(async () => ({
      sessionId: "res-1",
      consumer: "deep_research",
      objective: "调研向量数据库选型",
      mode: "standard",
      status: "created",
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
      roundCount: 0,
      documentCount: 0,
      chunkCount: 0,
    }));
    const b = {
      loadChat: async () => [],
      saveChat: async () => {},
      startCli: vi.fn(),
      oneshotCli: vi.fn(),
      artifactCreate: vi.fn(),
      research: {
        create: createRejects ? vi.fn(async () => { throw createRejects; }) : create,
        run: vi.fn(async () => {}),
        onEvent: () => () => {},
        list: async () => [],
      },
    } as unknown as DesktopBridge;
    return b;
  }

  async function sendResearch(b: DesktopBridge, onToast: (t: string) => void = () => {}) {
    const view = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={onToast} />
      </CoreProvider>,
    );
    const ta = view.container.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "/skill:research 调研向量数据库选型" } });
    await act(async () => {
      fireEvent.click(screen.getByTitle("发送 (Enter)"));
    });
    return view;
  }

  it("命中研究：建会话并启动，但不 spawn 任何 CLI、也不走产物派发", async () => {
    const b = researchBridge();
    await sendResearch(b);
    const research = (b as unknown as { research: { create: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> } }).research;

    expect(research.create).toHaveBeenCalledTimes(1);
    expect(research.run).toHaveBeenCalledTimes(1);
    expect(b.startCli).not.toHaveBeenCalled();
    expect(b.oneshotCli).not.toHaveBeenCalled();
    expect(b.artifactCreate).not.toHaveBeenCalled();
  });

  it("绑定写进会话并把右栏切到研究面板", async () => {
    await sendResearch(researchBridge());
    const session = usePersonalStore.getState().sessions.find((s) => s.id === "s1")!;

    expect(session.researchSessions?.map((r) => r.sessionId)).toEqual(["res-1"]);
    expect(session.activeResearchSessionId).toBe("res-1");
    expect(usePersonalStore.getState().rightView).toBe("research");
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });

  // 会话流留痕,但**只留研究目标、不留 /skill:research 前缀**：前缀是派发指令不是内容,
  // 显示出来是噪音,还会经 applyFallbackTitle 把会话标题也污染成 "/skill:research ..."（用户反馈）。
  it("会话流里留下研究目标本身（不含 /skill:research 前缀）", async () => {
    await sendResearch(researchBridge());
    expect(await screen.findByText("调研向量数据库选型", { selector: ".m-text" })).toBeInTheDocument();
    expect(screen.queryByText(/\/skill:research/)).toBeNull();
  });

  it("create 失败：toast 报错，不绑定、不切右栏", async () => {
    const onToast = vi.fn();
    await sendResearch(researchBridge(new Error("搜索服务未配置")), onToast);

    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("搜索服务未配置"));
    const session = usePersonalStore.getState().sessions.find((s) => s.id === "s1")!;
    expect(session.researchSessions).toBeUndefined();
  });
});

// 操作条(时间/复制/朗读/追问/分支分页器)收敛:只挂「每轮完整输出的最后一条 agent 文本」,
// 且当前正在流式输出的那一轮不显示——run 结束后才出现。历史轮每轮末条保留。
describe("PersonalChatArea 操作条只挂每轮末条 agent 文本", () => {
  afterEach(() => cleanup());

  const u = (uid: string, text: string): Message => ({ kind: "text", who: "me", time: "12:00", uid, text });
  const a = (uid: string, text: string): Message => ({ kind: "text", who: "claude", time: "12:01", uid, text });

  function setup(running = false) {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: "s1", projectId: "p1", title: "S1", agent: "claude", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: "s1",
      timelineProjectId: undefined,
      runningBySession: running ? { s1: "run-1" } : {},
      providerSettings: { providers: [] },
    });
  }

  // loaded 直接喂给 bridge.loadChat:裸数组 = v1,对象 = v2(带 branchGroups)。
  function renderChat(loaded: unknown) {
    const b = {
      loadChat: async () => loaded,
      saveChat: async () => {},
      askFollowupStream: async () => {},
      onAskFollowupEvent: () => () => {},
      cancelFollowup: async () => {},
    } as unknown as DesktopBridge;
    return render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
  }

  // 某条正文所在消息行(.msg)内是否有操作条。
  function tailOf(text: string): Element | null {
    return screen.getByText(text).closest(".msg")!.querySelector(".m-msg-actions");
  }

  it("一轮多段输出:只有末段带操作条,中间段完全无 tail", async () => {
    setup();
    renderChat([u("m1", "问题"), a("a1", "第一段"), a("a2", "第二段")]);
    await screen.findByText("第二段");

    expect(tailOf("第一段")).toBeNull();
    expect(tailOf("第二段")).not.toBeNull();
    // 复制/追问全局只出现一次(挂在末段)。
    expect(screen.getAllByTitle("复制回复内容")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "追问" })).toHaveLength(1);
  });

  it("文本段之间夹过程块(todoList)不影响末条判定", async () => {
    setup();
    renderChat([
      u("m1", "问题"),
      a("a1", "第一段"),
      {
        kind: "todoList",
        who: "claude",
        time: "12:01",
        uid: "t1",
        runId: "run-1",
        todos: [{ text: "步骤", status: "completed" }],
      } as Message,
      a("a2", "第二段"),
    ]);
    await screen.findByText("第二段");

    expect(tailOf("第一段")).toBeNull();
    expect(tailOf("第二段")).not.toBeNull();
  });

  it("回合结束后在末尾常驻显示精确的输入和输出 token", async () => {
    setup();
    renderChat([
      u("m1", "问题"),
      a("a1", "回答"),
      {
        kind: "turnUsage",
        who: "claude",
        time: "12:01",
        uid: "usage-1",
        runId: "run-1",
        inputTokens: 12_345,
        outputTokens: 678,
      } satisfies Message,
    ]);
    await screen.findByText("回答");

    const usage = screen.getByLabelText("本轮 Token 用量");
    expect(usage).toHaveTextContent("输入 12,345");
    expect(usage).toHaveTextContent("输出 678");
    expect(usage).toHaveTextContent("tokens");
  });

  it("running 时当前轮末段也不显示操作条", async () => {
    setup(true);
    renderChat([u("m1", "问题"), a("a1", "第一段"), a("a2", "第二段")]);
    await screen.findByText("第二段");

    expect(tailOf("第一段")).toBeNull();
    expect(tailOf("第二段")).toBeNull();
    expect(screen.queryByTitle("复制回复内容")).toBeNull();
  });

  it("running 时历史轮(其后已有用户消息)末段仍显示操作条", async () => {
    setup(true);
    renderChat([u("m1", "问题一"), a("a1", "旧末段"), u("m2", "问题二"), a("a2", "新末段")]);
    await screen.findByText("新末段");

    // 上一轮已收尾,操作条保留;当前正在输出的这一轮不显示。
    expect(tailOf("旧末段")).not.toBeNull();
    expect(tailOf("新末段")).toBeNull();
  });

  it("分支分页器出现在轮末条,而非首条", async () => {
    setup();
    renderChat({
      version: 2,
      messages: [u("m1", "问题"), a("a1", "第一段"), a("a2", "第二段")],
      branchGroups: [
        {
          anchorUid: "m1",
          activeId: "b2",
          variants: [
            { id: "b1", createdAt: 1, tail: [a("x1", "旧回复")], pointer: null },
            { id: "b2", createdAt: 2, tail: null, pointer: null },
          ],
        },
      ],
    });
    await screen.findByText("第二段");

    const pager = screen.getByTitle("切换查看不同的回复分支");
    expect(pager).toBeInTheDocument();
    expect(screen.getByText("2/2")).toBeInTheDocument();
    expect(pager.closest(".msg")).toBe(screen.getByText("第二段").closest(".msg"));
  });
});

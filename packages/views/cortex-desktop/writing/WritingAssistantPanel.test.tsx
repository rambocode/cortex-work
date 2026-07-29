// WritingAssistantPanel 单测(U8):空态三卡填输入框/润色无选区禁用、选区引用快照冻结、
// pending 审阅禁发、新建会话/切会话 resume、发送前 flush 先于 startCli。
// MarkdownView 桩掉避免重依赖;fake bridge 提供 startCli/killCli/onCliEvent/onCliExit。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { CliStartRequest, DesktopBridge } from "@cortex-work/core";
import {
  __resetWritingRunManagerForTest,
  setResumeSessionId,
  useWritingRunStore,
} from "@cortex-work/core/writing/run/writing-run-manager";
import {
  __resetWritingThreadsForTest,
  useWritingThreadsStore,
} from "@cortex-work/core/writing/threads";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import { defaultWritingQuickActions } from "@cortex-work/core/writing/quick-actions";
import { WritingAssistantPanel } from "./WritingAssistantPanel";

vi.mock("../personal/MarkdownView", () => ({
  MarkdownView: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

const SPACE = { id: "space-1", name: "写作空间", root: "/space" };
const FILE = "/space/a.md";

// 记录 startCli 调用序;onCliEvent/onCliExit 返回空 unsubscribe(本测不驱动事件)。
// skills 传入时提供 piSkillsList(slash skill 呼出用;global scope 免授信)。
function fakeBridge(skills?: { name: string; description: string; dir: string }[]) {
  const startCalls: CliStartRequest[] = [];
  const bridge = {
    startCli: vi.fn(async (req: CliStartRequest) => {
      startCalls.push(req);
    }),
    killCli: vi.fn(async () => {}),
    onCliEvent: vi.fn(() => () => {}),
    onCliExit: vi.fn(() => () => {}),
    ...(skills
      ? {
          piSkillsList: vi.fn(async () =>
            skills.map((s) => ({
              ...s,
              rootPath: "/skills",
              scope: "global",
              enabled: true,
              trusted: true,
              docs: [],
            })),
          ),
        }
      : {}),
  } as unknown as DesktopBridge;
  return { bridge, startCalls };
}

function renderPanel(
  bridge: DesktopBridge,
  props: Partial<Parameters<typeof WritingAssistantPanel>[0]> = {},
) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <WritingAssistantPanel space={SPACE} activeFilePath={FILE} {...props} />
    </CoreProvider>,
  );
}

describe("WritingAssistantPanel", () => {
  afterEach(cleanup);
  beforeEach(() => {
    __resetWritingThreadsForTest();
    __resetWritingRunManagerForTest();
    // 复位快捷指令到内置默认集(建议卡从此渲染;避免用例间串场)+ 助手 composer 选择记忆。
    useWritingSpacesStore.setState({
      quickActions: defaultWritingQuickActions(),
      assistantAgent: null,
      assistantModelByAgent: {},
      assistantThinkingByAgent: {},
      assistantPiProviderId: null,
    });
  });

  it("空态固定三卡(对齐 Kun):chat 卡点击填入输入框且不自动发送;其余快捷指令不进空态", () => {
    const { bridge, startCalls } = fakeBridge();
    renderPanel(bridge);

    // 待命卡文案(Kun 形态)
    expect(screen.getByText("写作助手待命中")).toBeInTheDocument();
    // 内置 summarize(chat):填入输入框、不发送。
    fireEvent.click(screen.getByText("总结当前文档"));
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.value).toContain("请总结当前文档");
    expect(startCalls).toHaveLength(0); // 只填充,不发送

    // 空态收敛为固定三卡:选区类快捷指令(如 reformat)不再渲染空态卡(无选区时选区 chip 条也不显示)。
    expect(screen.queryByText("重新格式化")).not.toBeInTheDocument();
  });

  it("顶栏:固定标题「写作助手」+ 折叠按钮回调;会话历史挂文件夹按钮", () => {
    const { bridge } = fakeBridge();
    const onCollapse = vi.fn();
    renderPanel(bridge, { onCollapse });

    expect(screen.getByText("写作助手")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("收起写作助手"));
    expect(onCollapse).toHaveBeenCalledTimes(1);

    // 文件夹按钮展开会话历史菜单(含新建会话入口)
    fireEvent.click(screen.getByLabelText("会话历史"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("edit 类建议卡(有选区)→ 调 onRunInlineEdit(就地改写链路)", async () => {
    const { bridge } = fakeBridge();
    const onRunInlineEdit = vi.fn().mockResolvedValue({ ok: true });
    renderPanel(bridge, {
      selection: { text: "选中段", charCount: 3, lineStart: 1, lineEnd: 1 },
      onRunInlineEdit,
    });
    fireEvent.click(screen.getByText("重新格式化"));
    await waitFor(() =>
      expect(onRunInlineEdit).toHaveBeenCalledWith(expect.stringContaining("整理")),
    );
  });

  it("chat 类建议卡(有选区)→ 引用选区 + 填入输入框(不发送)", () => {
    const { bridge, startCalls } = fakeBridge();
    renderPanel(bridge, { selection: { text: "选中段", charCount: 3, lineStart: 1, lineEnd: 1 } });
    fireEvent.click(screen.getByText("润色")); // 内置 polish = chat
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.value).toContain("润色");
    expect(screen.getByText(/1-1行/)).toBeInTheDocument(); // 引用 chip
    expect(startCalls).toHaveLength(0);
  });

  it("选区引用 chip:创建后修改文档,chip 内容不变(快照语义)", () => {
    const { bridge } = fakeBridge();
    const { rerender } = renderPanel(bridge, {
      selection: { text: "第一段", charCount: 3, lineStart: 1, lineEnd: 1 },
    });

    // 点击「引用当前选区」创建 chip
    fireEvent.click(screen.getByLabelText("引用当前选区"));
    expect(screen.getByText(/1-1行/)).toBeInTheDocument();

    // 模拟文档改动:选区 prop 变了,已建 chip 仍是创建时的快照(1-1行,不随新选区变)
    rerender(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <WritingAssistantPanel
          space={SPACE}
          activeFilePath={FILE}
          selection={{ text: "改动后的第九段", charCount: 7, lineStart: 9, lineEnd: 9 }}
        />
      </CoreProvider>,
    );
    expect(screen.getByText(/1-1行/)).toBeInTheDocument();
    expect(screen.queryByText(/9-9行/)).not.toBeInTheDocument();
  });

  it("pending 审阅存在时发送按钮禁用;裁决完毕恢复", () => {
    const { bridge } = fakeBridge();
    const { rerender } = renderPanel(bridge, { hasPendingReview: true });

    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "改一下" } });
    expect(screen.getByLabelText("发送")).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("未处理的改动审阅");

    // 裁决完毕:hasPendingReview=false,发送恢复可用
    rerender(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <WritingAssistantPanel space={SPACE} activeFilePath={FILE} hasPendingReview={false} />
      </CoreProvider>,
    );
    expect(screen.getByLabelText("发送")).not.toBeDisabled();
  });

  it("新建会话产生新 threadUuid", async () => {
    const { bridge } = fakeBridge();
    renderPanel(bridge);
    // 挂载 effect 自动为空间建默认会话
    await waitFor(() =>
      expect(useWritingThreadsStore.getState().threadsForSpace(SPACE.id)).toHaveLength(1),
    );
    const first = useWritingThreadsStore.getState().activeThreadId(SPACE.id);

    fireEvent.click(screen.getByLabelText("新建会话"));
    const threads = useWritingThreadsStore.getState().threadsForSpace(SPACE.id);
    expect(threads).toHaveLength(2);
    const active = useWritingThreadsStore.getState().activeThreadId(SPACE.id);
    expect(active).not.toBe(first);
  });

  it("切会话后发送使用该会话的 resumeSessionId", async () => {
    const { bridge, startCalls } = fakeBridge();
    renderPanel(bridge);
    await waitFor(() =>
      expect(useWritingThreadsStore.getState().activeThreadId(SPACE.id)).toBeTruthy(),
    );
    const threadA = useWritingThreadsStore.getState().activeThreadId(SPACE.id)!;
    // 为会话 A 预置续接 id(模拟上一轮 init 事件已捕获)
    setResumeSessionId(threadA, "sess-A");

    // 新建会话 B → 再切回 A
    fireEvent.click(screen.getByLabelText("新建会话"));
    act(() => {
      useWritingThreadsStore.getState().setActiveThread(SPACE.id, threadA);
    });

    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "继续改" } });
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => expect(startCalls).toHaveLength(1));
    expect(startCalls[0]!.sessionId).toBe(`writing-${threadA}`);
    expect(startCalls[0]!.resumeSessionId).toBe("sess-A");
    expect(startCalls[0]!.runId.startsWith(`writing:${SPACE.id}:`)).toBe(true);
  });

  it("发送触发 flush 且 flush 先于 startCli", async () => {
    const { bridge, startCalls } = fakeBridge();
    const order: string[] = [];
    const onFlushBeforeSend = vi.fn(async () => {
      order.push("flush");
    });
    (bridge.startCli as ReturnType<typeof vi.fn>).mockImplementation(async (req: CliStartRequest) => {
      order.push("startCli");
      startCalls.push(req);
    });
    renderPanel(bridge, { onFlushBeforeSend });

    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "润色全文" } });
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => expect(startCalls).toHaveLength(1));
    expect(onFlushBeforeSend).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["flush", "startCli"]);
    // prompt 恒含改稿约定
    expect(startCalls[0]!.prompt).toContain("行级红绿 Diff");
  });

  it("pill 选择的模型与思考强度随发送透传(claude → model + effort)", async () => {
    const { bridge, startCalls } = fakeBridge();
    // 模拟用户已在 pill 选择:claude 用 Opus 5 (1M) + 思考「高」(assistantAgent 记忆使面板初始
    // agent=claude,测试环境无已安装 agent,否则默认回落 pi)。取 AGENT_MODELS 里的现存值——
    // 旧的 `opus` 别名档已下线,拿它当有效值会退化成脏值回落用例(下一条已覆盖)。
    useWritingSpacesStore.setState({
      assistantAgent: "claude",
      assistantModelByAgent: { claude: "claude-opus-5[1m]" },
      assistantThinkingByAgent: { claude: "high" },
    });
    renderPanel(bridge);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "改一下" } });
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => expect(startCalls).toHaveLength(1));
    expect(startCalls[0]!.model).toBe("claude-opus-5[1m]");
    expect(startCalls[0]!.effort).toBe("high");
  });

  it("pill 记忆为脏值/缺省时回落默认模型;思考 default 档不透传 effort", async () => {
    const { bridge, startCalls } = fakeBridge();
    useWritingSpacesStore.setState({
      assistantAgent: "claude",
      assistantModelByAgent: { claude: "no-such-model" },
    });
    renderPanel(bridge);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "改" } });
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => expect(startCalls).toHaveLength(1));
    expect(startCalls[0]!.model).toBe("sonnet"); // DEFAULT_MODEL.claude
    expect(startCalls[0]!.effort).toBeUndefined();
  });

  it("slash 呼出:输入 / 弹已启用 skill 菜单,Enter 插入 /skill:name 待填参", async () => {
    const { bridge } = fakeBridge([{ name: "demo-skill", description: "演示技能", dir: "/skills/demo-skill" }]);
    useWritingSpacesStore.setState({ assistantAgent: "claude" });
    renderPanel(bridge);

    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    // 等 skill 记录异步加载完成后输入 "/" 触发菜单
    fireEvent.change(input, { target: { value: "/" } });
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    expect(screen.getByText("Demo Skill")).toBeInTheDocument();

    // Enter 选中 → 插入 `/skill:demo-skill `(带尾随空格,菜单关闭),不发送
    fireEvent.keyDown(input, { key: "Enter" });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("/skill:demo-skill ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("claude slash 发送:prompt 为裸 slash 开头,skillRecords 注入,写作上下文降级进 appendSystemPrompt", async () => {
    const { bridge, startCalls } = fakeBridge([
      { name: "demo-skill", description: "演示技能", dir: "/skills/demo-skill" },
    ]);
    useWritingSpacesStore.setState({ assistantAgent: "claude" });
    renderPanel(bridge);

    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/skill:demo-skill 帮我润色" } });
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => expect(startCalls).toHaveLength(1));
    const req = startCalls[0]!;
    expect(req.prompt).toBe("/demo-skill 帮我润色"); // 裸 slash 整条 prompt,claude 原生展开
    expect(req.skillRecords?.length).toBe(1); // 桥接目录记录
    expect(req.appendSystemPrompt).toContain("行级红绿 Diff"); // 改稿约定降级进 system 缝
  });

  it("codex slash 发送:正文留参数,invokedSkill 结构化字段 + skill prose 进 appendSystemPrompt", async () => {
    const { bridge, startCalls } = fakeBridge([
      { name: "demo-skill", description: "演示技能", dir: "/skills/demo-skill" },
    ]);
    useWritingSpacesStore.setState({ assistantAgent: "codex" });
    renderPanel(bridge);

    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/skill:demo-skill 参数A" } });
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => expect(startCalls).toHaveLength(1));
    const req = startCalls[0]!;
    expect(req.invokedSkill).toEqual({ name: "demo-skill", path: "/skills/demo-skill" });
    expect(req.prompt).toContain("参数A"); // 正文只留 args,仍带写作上下文拼装
    expect(req.prompt).toContain("行级红绿 Diff");
    expect(req.prompt).not.toContain("/skill:"); // slash 已被改写
    expect(req.appendSystemPrompt).toContain("已启用的 Skills"); // codex prose 注入
    expect(req.skillRecords).toBeUndefined();
  });

  it("/skill:未启用名 → 原样发送不阻断、无 skill 注入", async () => {
    const { bridge, startCalls } = fakeBridge([
      { name: "demo-skill", description: "演示技能", dir: "/skills/demo-skill" },
    ]);
    useWritingSpacesStore.setState({ assistantAgent: "claude" });
    renderPanel(bridge);

    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/skill:no-such 试试" } });
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => expect(startCalls).toHaveLength(1));
    const req = startCalls[0]!;
    expect(req.prompt).toContain("/skill:no-such 试试"); // 原样进正文
    expect(req.skillRecords).toBeUndefined();
    expect(req.invokedSkill).toBeUndefined();
  });

  it("成功发送后清空输入框,用户消息落入时间线", async () => {
    const { bridge } = fakeBridge();
    renderPanel(bridge);
    await waitFor(() =>
      expect(useWritingThreadsStore.getState().activeThreadId(SPACE.id)).toBeTruthy(),
    );
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "写个开头" } });
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(""));
    const threadId = useWritingThreadsStore.getState().activeThreadId(SPACE.id)!;
    const msgs = useWritingRunStore.getState().messagesByThread[threadId] ?? [];
    expect(msgs.some((m) => m.role === "user")).toBe(true);
  });
});

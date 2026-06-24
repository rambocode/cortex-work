import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { AutomationMeta, AutomationRun, DesktopBridge } from "@cortex-work/core";

// 用 vi.hoisted 暴露受控的 mutation mock 与 runs 数据,供 vi.mock 工厂(提升)引用。
const h = vi.hoisted(() => ({
  runNowMutate: vi.fn(),
  setEnabledMutate: vi.fn(),
  delRunMutate: vi.fn(),
  delAutoMutate: vi.fn(),
  createMutate: vi.fn(),
  runsData: [] as AutomationRun[],
}));

// 仅 mock automation 数据/变更 hooks;CoreProvider / usePersonalStore / useDesktopBridge 保持真实,
// 使 MarkdownView 在整页运行详情中能正常渲染。
vi.mock("@cortex-work/core", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useAutomationRuns: () => ({ data: h.runsData }),
    useRunAutomationNow: () => ({ mutate: h.runNowMutate, isPending: false }),
    useSetAutomationEnabled: () => ({ mutate: h.setEnabledMutate }),
    useDeleteAutomationRun: () => ({ mutate: h.delRunMutate }),
    useDeleteAutomation: () => ({ mutate: h.delAutoMutate }),
    useCreateAutomation: () => ({ mutate: h.createMutate }),
  };
});
vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: "<svg></svg>" }) },
}));

const { AutomationDetail } = await import("./AutomationDetail");

afterEach(() => cleanup());

const meta = (over: Partial<AutomationMeta> = {}): AutomationMeta => ({
  id: "auto-1",
  name: "历史上的今天",
  enabled: true,
  agent: "claude",
  model: "sonnet",
  effort: "medium",
  prompt: "讲一件历史上的今天",
  schedule: { kind: "daily", hour: 9, minute: 10 },
  createdAt: 0,
  updatedAt: 0,
  lastRunAt: new Date(2026, 5, 24, 9, 10).getTime(),
  lastStatus: "ok",
  nextRunAt: new Date(2026, 5, 25, 9, 10).getTime(),
  ...over,
});

const run = (over: Partial<AutomationRun> = {}): AutomationRun => ({
  id: "r1",
  automationId: "auto-1",
  startedAt: new Date(2026, 5, 24, 9, 10).getTime(),
  endedAt: new Date(2026, 5, 24, 9, 10, 37).getTime(),
  status: "ok",
  trigger: "schedule",
  agent: "claude",
  prompt: "p",
  output: "这是最新一次的运行输出",
  ...over,
});

const bridge = { openExternal: vi.fn() } as unknown as DesktopBridge;
function renderDetail(props: Partial<Parameters<typeof AutomationDetail>[0]> = {}) {
  const onBack = vi.fn();
  const onEdit = vi.fn();
  const onToast = vi.fn();
  const utils = render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <AutomationDetail meta={meta()} onBack={onBack} onEdit={onEdit} onToast={onToast} {...props} />
    </CoreProvider>,
  );
  return { ...utils, onBack, onEdit, onToast };
}

beforeEach(() => {
  h.runsData = [run()];
  h.runNowMutate.mockReset();
  h.setEnabledMutate.mockReset();
  h.delRunMutate.mockReset();
  h.delAutoMutate.mockReset().mockImplementation((_id, opts) => opts?.onSuccess?.());
  h.createMutate.mockReset();
  // jsdom 不实现 createObjectURL,导出测试需补桩。
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:x");
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
});

describe("AutomationDetail(编排器)", () => {
  it("渲染五大区:顶栏/meta 行/hero/运行历史/配置栏", () => {
    const { getByText } = renderDetail();
    expect(getByText("立即运行")).toBeTruthy(); // 顶栏
    expect(getByText(/上次成功/)).toBeTruthy(); // meta 行
    expect(getByText("最新结果")).toBeTruthy(); // hero 区标题
    expect(getByText("这是最新一次的运行输出")).toBeTruthy(); // hero 正文(runs[0])
    expect(getByText("运行历史")).toBeTruthy();
    expect(getByText("配置")).toBeTruthy(); // 配置栏
  });

  it("整页运行详情:展开运行 → 查看完整 → 返回", () => {
    const { getByText, queryByText, getAllByText, getByTitle, container } = renderDetail();
    // 用 querySelector 点运行历史那一行(日期文本在 meta 行/hero 处重复,getByText 会多匹配)。
    fireEvent.click(container.querySelector(".pw-auto-run-h")!);
    fireEvent.click(getByText("查看完整"));
    // 进入整页:仍渲染完整输出,且顶栏切为返回态(立即运行消失)
    expect(queryByText("立即运行")).toBeNull();
    expect(getAllByText("这是最新一次的运行输出").length).toBeGreaterThan(0);
    fireEvent.click(getByTitle("返回"));
    expect(getByText("立即运行")).toBeTruthy(); // 回到主布局
  });

  it("创建副本调 useCreateAutomation,入参剥离服务端字段且名称加副本", () => {
    const { getByTitle, getByText } = renderDetail();
    fireEvent.click(getByTitle("更多"));
    fireEvent.click(getByText("创建副本"));
    expect(h.createMutate).toHaveBeenCalledTimes(1);
    const input = h.createMutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.name).toBe("历史上的今天 副本");
    expect(input.id).toBeUndefined();
  });

  it("导出运行历史触发 Blob 下载并 toast", () => {
    const { getByTitle, getByText, onToast } = renderDetail();
    fireEvent.click(getByTitle("更多"));
    fireEvent.click(getByText("导出运行历史"));
    expect((URL as unknown as { createObjectURL: ReturnType<typeof vi.fn> }).createObjectURL).toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith("运行历史已导出");
  });

  it("删除自动化(二次确认)调 useDeleteAutomation 并回退列表", () => {
    // 经配置栏删除(菜单关闭时「删除自动化」文案唯一);顶栏菜单删除已在 Header 单测覆盖。
    const { getByText, onBack } = renderDetail();
    fireEvent.click(getByText("删除自动化"));
    fireEvent.click(getByText("确认删除？"));
    expect(h.delAutoMutate).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("启用开关调 useSetAutomationEnabled(取反)", () => {
    const { container } = renderDetail();
    fireEvent.click(container.querySelector(".twk-toggle")!);
    expect(h.setEnabledMutate).toHaveBeenCalledWith(
      { id: "auto-1", enabled: false },
      expect.anything(),
    );
  });

  it("无运行记录:hero 空态 + meta 行「尚未运行」", () => {
    h.runsData = [];
    const { getByText } = renderDetail({ meta: meta({ lastStatus: undefined, lastRunAt: undefined }) });
    expect(getByText("暂无运行结果")).toBeTruthy();
    expect(getByText("尚未运行")).toBeTruthy();
  });
});

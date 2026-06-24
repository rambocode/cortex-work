// 设置入口 + 整页设置视图（PersonalSettingsView）的最小渲染测试。
// 仅依赖 store（openSettings/closeSettings）与默认 profile/通用分区,不需真实 bridge。
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import type { ReactElement } from "react";
import { CoreProvider, DEFAULT_TWEAKS, useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import { changeLanguage, i18n, i18nReady } from "@cortex-work/core/i18n";
import type { DesktopBridge, UpdateState } from "@cortex-work/core";
import { SettingsMenu, PersonalSettingsView } from "./SettingsMenu";
import { useTweaksPersistence } from "../useTweaksPersistence";

function renderUI(ui: ReactElement, bridge: DesktopBridge | null = null) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      {ui}
    </CoreProvider>,
  );
}

function fakeUpdateBridge(initial: UpdateState, checked: UpdateState) {
  let listener: ((s: UpdateState) => void) | null = null;
  // 真实主进程:update:check 触发 electron-updater 事件 → 广播 update:state。
  // 故 fake 在被调时经 listener 广播结果（单一来源,UI 经 useUpdateState 反映）。
  const updateCheck = vi.fn(async () => {
    listener?.(checked);
    return checked;
  });
  const bridge = {
    appInfo: { version: "0.1.1", os: "macos" },
    updateGetState: async () => initial,
    updateCheck,
    updateDownload: vi.fn(async () => {}),
    updateInstall: vi.fn(async () => {}),
    onUpdateState: (cb: (s: UpdateState) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  } as unknown as DesktopBridge;
  return { bridge, updateCheck, push: (s: UpdateState) => listener?.(s) };
}

describe("设置入口与整页设置视图", () => {
  beforeEach(() => {
    usePersonalStore.setState({ settingsOpen: false, profile: {} });
  });
  afterEach(() => cleanup());

  it("点击侧栏「设置」入口打开整页(settingsOpen=true)", () => {
    renderUI(<SettingsMenu />);
    expect(usePersonalStore.getState().settingsOpen).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(usePersonalStore.getState().settingsOpen).toBe(true);
  });

  it("点击「返回应用」关闭整页(settingsOpen=false)", () => {
    usePersonalStore.setState({ settingsOpen: true });
    renderUI(<PersonalSettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "返回应用" }));
    expect(usePersonalStore.getState().settingsOpen).toBe(false);
  });

  it("挂载时焦点移入覆盖层(返回按钮)", () => {
    usePersonalStore.setState({ settingsOpen: true });
    renderUI(<PersonalSettingsView />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "返回应用" }));
  });

  it("非输入态按 ESC 返回", () => {
    usePersonalStore.setState({ settingsOpen: true });
    renderUI(<PersonalSettingsView />);
    // 挂载后焦点在返回按钮(非输入态),ESC 触发 closeSettings。
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(usePersonalStore.getState().settingsOpen).toBe(false);
  });

  it("输入态按 ESC 不返回(避免误关/丢输入)", () => {
    usePersonalStore.setState({ settingsOpen: true });
    renderUI(<PersonalSettingsView />);
    const nickname = screen.getByPlaceholderText("我"); // ProfileSection 昵称输入
    nickname.focus();
    expect(document.activeElement).toBe(nickname);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(usePersonalStore.getState().settingsOpen).toBe(true);
  });

  it("默认「个人资料」分区,切到「通用」右栏与菜单态同步(Covers R4)", () => {
    usePersonalStore.setState({ settingsOpen: true });
    renderUI(<PersonalSettingsView />);
    // 默认 profile 分区（以其唯一描述文案断言）。
    expect(screen.getByText("设置你的昵称和头像,会话中你发出的消息会用它们显示。")).toBeTruthy();
    // 切到通用 → 右栏换为 GeneralSection（唯一描述文案）。
    fireEvent.click(screen.getByRole("button", { name: "通用" }));
    expect(screen.getByText("管理界面偏好、默认工作目录与桌面行为。")).toBeTruthy();
    // 菜单态：通用项 is-active + aria-current=page。
    const active = screen.getByRole("button", { name: "通用" });
    expect(active.className).toContain("is-active");
    expect(active.getAttribute("aria-current")).toBe("page");
  });

  it("通用分区显示版本更新,可手动检查并展示失败", async () => {
    usePersonalStore.setState({ settingsOpen: true });
    const { bridge, updateCheck } = fakeUpdateBridge(
      { phase: "idle" },
      { phase: "error", error: "No published versions on GitHub" },
    );
    renderUI(<PersonalSettingsView />, bridge);
    fireEvent.click(screen.getByRole("button", { name: "通用" }));

    expect(screen.getByText("版本更新")).toBeTruthy();
    expect(screen.getByText("v0.1.1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "检查新版本" }));

    await waitFor(() => expect(updateCheck).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("检查失败")).toBeTruthy();
    expect(screen.getByText("No published versions on GitHub")).toBeTruthy();
  });

  it("非 dev 环境不显示 Agent 调试跟踪", () => {
    usePersonalStore.setState({ settingsOpen: true });
    const bridge = { appInfo: { version: "0.1.1", os: "macos", devMode: false } } as unknown as DesktopBridge;
    renderUI(<PersonalSettingsView />, bridge);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));

    expect(screen.queryByText("调试跟踪")).toBeNull();
  });

  it("dev 环境显示 Agent 调试跟踪窗口入口,点击后打开独立窗口", async () => {
    usePersonalStore.setState({ settingsOpen: true });
    const openAgentTraceWindow = vi.fn(async () => undefined);
    const bridge = {
      appInfo: { version: "0.1.1", os: "macos", devMode: true },
      openAgentTraceWindow,
    } as unknown as DesktopBridge;
    renderUI(<PersonalSettingsView />, bridge);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));

    expect(await screen.findByText("调试跟踪")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开调试跟踪窗口" }));

    await waitFor(() => expect(openAgentTraceWindow).toHaveBeenCalledTimes(1));
  });

  it("卸载后 window keydown 监听解绑(ESC 不再返回)", () => {
    usePersonalStore.setState({ settingsOpen: true });
    const { unmount } = renderUI(<PersonalSettingsView />);
    unmount();
    usePersonalStore.setState({ settingsOpen: true });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(usePersonalStore.getState().settingsOpen).toBe(true);
  });
});

describe("语言切换器(U3)", () => {
  // 挂载持久化 hook,使切换器 setTweak → changeLanguage 全链生效(同真实 CortexDesktopView)。
  function SettingsWithPersistence() {
    useTweaksPersistence();
    return <PersonalSettingsView />;
  }

  beforeAll(async () => {
    await i18nReady;
  });
  beforeEach(() => {
    usePersonalStore.setState({ settingsOpen: true, profile: {} });
    useCortexUIStore.setState({ tweaks: { ...DEFAULT_TWEAKS } });
    localStorage.clear();
  });
  afterEach(async () => {
    cleanup();
    useCortexUIStore.setState({ tweaks: { ...DEFAULT_TWEAKS } });
    await changeLanguage("zh-Hans");
  });

  it("通用分区渲染语言切换器(默认中文,选项含 English)", () => {
    renderUI(<PersonalSettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "通用" }));
    expect(screen.getByText("语言")).toBeTruthy(); // 行标题(zh 源串)
    expect(screen.getByText("English")).toBeTruthy(); // 选项(语言名以本族文字显示)
    expect(screen.getByText("中文")).toBeTruthy();
  });

  it("点 English → tweaks.language=en", () => {
    renderUI(<PersonalSettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "通用" }));
    fireEvent.click(screen.getByText("English"));
    expect(useCortexUIStore.getState().tweaks.language).toBe("en");
  });

  it("切到 English 经持久化全链 → i18n 切换且行标题变英文(Covers R7)", async () => {
    renderUI(<SettingsWithPersistence />);
    fireEvent.click(screen.getByRole("button", { name: "通用" }));
    fireEvent.click(screen.getByText("English"));
    await waitFor(() => expect(i18n.language).toBe("en"));
    expect(useCortexUIStore.getState().tweaks.language).toBe("en");
    expect(screen.getByText("Language")).toBeTruthy(); // 行标题切英文
  });
});

describe("Pi 设置分区(聚合 + 迁移)", () => {
  beforeEach(() => {
    usePersonalStore.setState((s) => ({
      settingsOpen: true,
      profile: {},
      generalSettings: {
        ...s.generalSettings,
        piCustomization: undefined,
        piSystemPrompt: undefined,
        piThinkingDefault: undefined,
      },
    }));
  });
  afterEach(() => cleanup());

  it("切到「Pi」分区:右栏渲染 PiSection,菜单态同步", () => {
    renderUI(<PersonalSettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Pi" }));
    expect(screen.getByText(/Pi 是内置 Agent/)).toBeTruthy();
    const active = screen.getByRole("button", { name: "Pi" });
    expect(active.className).toContain("is-active");
    expect(active.getAttribute("aria-current")).toBe("page");
  });

  it("pi 设置已从「通用」迁出,聚合到「Pi」分区", () => {
    renderUI(<PersonalSettingsView />);
    // 「通用」不再含 pi 工具审批开关。
    fireEvent.click(screen.getByRole("button", { name: "通用" }));
    expect(screen.queryByText("工具执行审批")).toBeNull();
    // 「Pi」含工具审批 + 默认供应商(空态下「默认供应商」为卡片标题,唯一)。
    fireEvent.click(screen.getByRole("button", { name: "Pi" }));
    expect(screen.getByText("工具执行审批")).toBeTruthy();
    expect(screen.getByText("默认供应商")).toBeTruthy();
  });

  it("工具审批开启时渲染可勾选工具清单,点击切换写入 approvalTools", () => {
    usePersonalStore.setState((s) => ({
      generalSettings: {
        ...s.generalSettings,
        piCustomization: { toolApproval: true, sampleTools: false, sampleCommands: false },
      },
    }));
    renderUI(<PersonalSettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Pi" }));
    expect(screen.getByText("需审批的工具")).toBeTruthy();
    // 默认勾选 bash/write/edit（approvalTools 未设 → 兜底默认三件）。
    expect((screen.getByLabelText("bash") as HTMLInputElement).checked).toBe(true);
    const read = screen.getByLabelText("read") as HTMLInputElement;
    expect(read.checked).toBe(false);
    // 勾选 read → approvalTools 含 read。
    fireEvent.click(read);
    expect(usePersonalStore.getState().generalSettings.piCustomization?.approvalTools).toContain("read");
  });

  it("工具审批关闭时不渲染工具清单", () => {
    renderUI(<PersonalSettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Pi" }));
    expect(screen.queryByText("需审批的工具")).toBeNull();
  });

  it("System Prompt textarea 绑定 piSystemPrompt,输入写入、清空归一 undefined", () => {
    renderUI(<PersonalSettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Pi" }));
    const ta = screen.getByPlaceholderText(/资深 TypeScript/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "你是简洁的助手" } });
    expect(usePersonalStore.getState().generalSettings.piSystemPrompt).toBe("你是简洁的助手");
    fireEvent.change(ta, { target: { value: "" } });
    expect(usePersonalStore.getState().generalSettings.piSystemPrompt).toBeUndefined();
  });

  it("思考强度全局默认下拉绑定 piThinkingDefault", () => {
    renderUI(<PersonalSettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Pi" }));
    const select = screen.getByDisplayValue("关闭") as HTMLSelectElement; // 默认 off → 展示「关闭」
    fireEvent.change(select, { target: { value: "high" } });
    expect(usePersonalStore.getState().generalSettings.piThinkingDefault).toBe("high");
  });

  it("切到「插件」标签渲染插件管理器(三层 IA 顶栏:插件/技能)", () => {
    renderUI(<PersonalSettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "插件" }));
    // 三层 IA 取代旧 Skill/MCP 两 tab:顶栏为「插件 / 技能」两大类。
    expect(screen.getByRole("tab", { name: "插件" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "技能" })).toBeTruthy();
  });
});

describe("设置菜单分组 + 应用/浏览器分区", () => {
  beforeEach(() => {
    usePersonalStore.setState({ settingsOpen: true, profile: {} });
  });
  afterEach(() => cleanup());

  it("左栏渲染 5 个分组标题(组标题用 .pw-dlg-nav-h,与同名菜单项区分)", () => {
    const { container } = renderUI(<PersonalSettingsView />);
    // 组标题节点（非 button）：逐字校验 5 组顺序与文案。
    const heads = Array.from(container.querySelectorAll(".pw-dlg-nav-h")).map((el) => el.textContent);
    expect(heads).toEqual(["通用", "模型与 Agent", "应用", "个性化", "自动化"]);
  });

  it("「应用」组并列「插件」「浏览器」两个菜单项", () => {
    renderUI(<PersonalSettingsView />);
    expect(screen.getByRole("button", { name: "插件" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "浏览器" })).toBeTruthy();
  });

  it("切到「浏览器」分区:右栏渲染内置浏览器控制开关,菜单态同步(Covers R4)", () => {
    renderUI(<PersonalSettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "浏览器" }));
    // BrowserControlSection 的总开关(原埋在 插件→管理→MCP,现提升为顶层分区)。
    expect(screen.getByLabelText("允许 agent 控制内置浏览器")).toBeTruthy();
    const active = screen.getByRole("button", { name: "浏览器" });
    expect(active.className).toContain("is-active");
    expect(active.getAttribute("aria-current")).toBe("page");
  });

  it("「通用」组含「已归档对话」菜单项,切换后右栏渲染该分区(Covers R1)", () => {
    renderUI(<PersonalSettingsView />);
    const item = screen.getByRole("button", { name: "已归档对话" });
    fireEvent.click(item);
    // ArchivedSessionsSection 的搜索占位符(分区特征文案)。
    expect(screen.getByPlaceholderText("搜索已归档对话")).toBeTruthy();
    expect(item.className).toContain("is-active");
    expect(item.getAttribute("aria-current")).toBe("page");
  });

  it("「应用」组含「媒体生成」菜单项,切换后右栏渲染该分区(U2)", () => {
    const { container } = renderUI(<PersonalSettingsView />);
    const item = screen.getByRole("button", { name: "媒体生成" });
    expect(item).toBeTruthy();
    fireEvent.click(item);
    // 外壳 MediaGenSection 渲染的 pw-dlg-desc 描述文案(唯一出现,Section 组件返回 null)。
    expect(container.querySelector(".pw-dlg-desc")?.textContent).toBe(
      "配置图像、视频、音频生成能力,供 agent 在会话中调用。",
    );
    expect(item.className).toContain("is-active");
    expect(item.getAttribute("aria-current")).toBe("page");
  });

  it("「个性化」组含「语音转文字」菜单项,切换后右栏渲染该分区(U2)", () => {
    const { container } = renderUI(<PersonalSettingsView />);
    const item = screen.getByRole("button", { name: "语音转文字" });
    expect(item).toBeTruthy();
    fireEvent.click(item);
    // 外壳 SttSection 渲染的 pw-dlg-desc 描述文案(唯一出现,Section 组件返回 null)。
    expect(container.querySelector(".pw-dlg-desc")?.textContent).toBe(
      "配置语音识别引擎与输入方式,支持本地 Whisper 与云端 API。",
    );
    expect(item.className).toContain("is-active");
    expect(item.getAttribute("aria-current")).toBe("page");
  });

  it("「媒体生成」归入「应用」组,「语音转文字」归入「个性化」组(U2 分组正确性)", () => {
    const { container } = renderUI(<PersonalSettingsView />);
    // 组标题节点（.pw-dlg-nav-h 非 button）:此时应有 5 个组标题（新增未改组数）。
    const heads = Array.from(container.querySelectorAll(".pw-dlg-nav-h")).map((el) => el.textContent);
    expect(heads).toEqual(["通用", "模型与 Agent", "应用", "个性化", "自动化"]);
    // 「应用」组同时包含「媒体生成」
    expect(screen.getByRole("button", { name: "媒体生成" })).toBeTruthy();
    // 「个性化」组同时包含「语音转文字」
    expect(screen.getByRole("button", { name: "语音转文字" })).toBeTruthy();
  });
});

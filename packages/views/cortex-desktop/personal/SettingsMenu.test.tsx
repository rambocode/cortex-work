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

  it("切到「插件」标签渲染插件管理器(MCP/Skill 分段)", () => {
    renderUI(<PersonalSettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "插件" }));
    expect(screen.getByRole("tab", { name: "Skill" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "MCP" })).toBeTruthy();
  });
});

// PluginManager 三层 IA 壳测试（U7–U10）：顶栏两首页 / 管理页四 sub-tab / 详情页 / 插件启停。
// CoreProvider 注入 fake bridge（pluginList/marketplaceList/piSkillsList）；usePersonalStore 真实。
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore, DEFAULT_GENERAL_SETTINGS, DEFAULT_PI_SKILLS } from "@cortex-work/core";
import type { DesktopBridge, InstalledPlugin, MarketplaceEntry } from "@cortex-work/core";
import { PluginManager } from "./PluginManager";

function plug(id: string, name: string, opts: Partial<InstalledPlugin["manifest"]> & { skillsDir?: string } = {}): InstalledPlugin {
  const { skillsDir, ...mf } = opts;
  return {
    manifest: { id, name, ...mf },
    installPath: `/p/${id}`,
    skillsDir,
    manifestKind: "codex",
  };
}

function fakeBridge(opts: {
  plugins?: InstalledPlugin[];
  market?: MarketplaceEntry[];
  marketError?: string;
  marketRootExists?: boolean;
} = {}): DesktopBridge {
  return {
    piSkillsList: vi.fn(async () => []),
    pluginList: vi.fn(async () => ({ items: opts.plugins ?? [], rootExists: true })),
    marketplaceList: vi.fn(async () => ({
      items: opts.market ?? [],
      rootExists: opts.marketRootExists ?? true,
      error: opts.marketError,
    })),
  } as unknown as DesktopBridge;
}

function renderWith(bridge: DesktopBridge | null) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <PluginManager />
    </CoreProvider>,
  );
}

beforeEach(() => {
  usePersonalStore.setState({
    generalSettings: { ...DEFAULT_GENERAL_SETTINGS, piSkills: { ...DEFAULT_PI_SKILLS }, plugins: { enabled: [], distrusted: [] } },
    projects: [],
    activeProjectId: undefined,
  });
});
afterEach(() => cleanup());

describe("PluginManager 三层 IA", () => {
  it("顶栏两首页：默认插件首页，可切到技能首页（SkillPanel）", async () => {
    renderWith(fakeBridge({ plugins: [plug("a", "Alpha")] }));
    expect(screen.getByRole("tab", { name: "插件" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "技能" })).toBeTruthy();
    // 默认插件首页：渲染已装插件
    expect(await screen.findByText("Alpha")).toBeTruthy();
    // 切技能 → SkillPanel 的三端作用域说明
    fireEvent.click(screen.getByRole("tab", { name: "技能" }));
    expect(await screen.findByText(/三端均生效/)).toBeTruthy();
  });

  it("插件首页空态：无已装插件给引导", async () => {
    renderWith(fakeBridge({ plugins: [] }));
    expect(await screen.findByText("还没有已装插件")).toBeTruthy();
  });

  it("插件行开关 → 写 store.plugins.enabled（opt-in）", async () => {
    renderWith(fakeBridge({ plugins: [plug("pdf", "PDF")] }));
    const sw = await screen.findByRole("switch", { name: /PDF/ });
    fireEvent.click(sw);
    expect(usePersonalStore.getState().generalSettings.plugins!.enabled).toContain("pdf");
  });

  it("插件首页「管理」→ 进管理页四 sub-tab（插件/MCP/技能/市场，无应用）", async () => {
    renderWith(fakeBridge({ plugins: [plug("a", "Alpha")] }));
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    expect(await screen.findByRole("tab", { name: /插件/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /MCP/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /技能/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /市场/ })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /应用/ })).toBeNull();
  });

  it("管理页 MCP sub-tab：MCP 工具 + pi 原生扩展并列（pi 扩展并入 MCP 同级）", async () => {
    renderWith(fakeBridge({ plugins: [plug("a", "Alpha")] }));
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    fireEvent.click(await screen.findByRole("tab", { name: /MCP/ }));
    expect(await screen.findByText(/pi 原生扩展/)).toBeTruthy();
  });

  it("管理页 MCP sub-tab 不再含内置浏览器控制开关（已迁至「应用→浏览器」分区）", async () => {
    renderWith(fakeBridge({ plugins: [plug("a", "Alpha")] }));
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    fireEvent.click(await screen.findByRole("tab", { name: /MCP/ }));
    await screen.findByText(/pi 原生扩展/);
    expect(screen.queryByLabelText("允许 agent 控制内置浏览器")).toBeNull();
  });

  it("管理页 市场 sub-tab：只读列条目 + 安装按钮禁用", async () => {
    renderWith(
      fakeBridge({
        plugins: [plug("a", "Alpha")],
        market: [{ name: "Cowart", sourceKind: "local", sourcePath: "./plugins/cowart", ok: true }],
      }),
    );
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    fireEvent.click(await screen.findByRole("tab", { name: /市场/ }));
    expect(await screen.findByText("Cowart")).toBeTruthy();
    const installBtn = screen.getByRole("button", { name: /安装/ });
    expect((installBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("市场坏条目 → 错误卡（对齐设计稿）", async () => {
    renderWith(
      fakeBridge({
        plugins: [plug("a", "Alpha")],
        market: [{ name: "Broken", sourceKind: "unknown", ok: false, error: "缺少 source 字段" }],
      }),
    );
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    fireEvent.click(await screen.findByRole("tab", { name: /市场/ }));
    expect(await screen.findByText(/部分插件市场条目无法加载/)).toBeTruthy();
    expect(screen.getByText(/缺少 source 字段/)).toBeTruthy();
  });

  it("点插件进详情页：富元数据 + 能力 + 「···」菜单含路径/升级禁用", async () => {
    renderWith(fakeBridge({ plugins: [plug("a", "Alpha", { category: "Productivity", capabilities: ["Read"] })] }));
    fireEvent.click(await screen.findByText("Alpha"));
    expect(screen.getAllByText("Read").length).toBeGreaterThan(0); // 能力(功能行 + chip)
    // 打开 ··· 菜单 → 升级禁用 + 本地路径
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    const upgrade = screen.getByRole("menuitem", { name: "升级" });
    expect((upgrade as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("/p/a")).toBeTruthy();
  });

  it("详情页「···」菜单启停 → 写 store；面包屑可返回", async () => {
    renderWith(fakeBridge({ plugins: [plug("pdf", "PDF")] }));
    fireEvent.click(await screen.findByText("PDF"));
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "启用" }));
    expect(usePersonalStore.getState().generalSettings.plugins!.enabled).toContain("pdf");
    // 面包屑返回首页
    fireEvent.click(screen.getByRole("button", { name: "插件" }));
    expect(await screen.findByRole("tab", { name: "技能" })).toBeTruthy();
  });

  it("详情页头部「在对话中试用」→ 启用插件 + 预填 defaultPrompt 到输入框", async () => {
    renderWith(fakeBridge({ plugins: [plug("pdf", "PDF", { defaultPrompt: "Review this PDF" })] }));
    fireEvent.click(await screen.findByText("PDF"));
    // 头部按钮(exact)避免与 banner 的 aria-label「在对话中试用 PDF」冲突
    const tryBtn = screen.getByRole("button", { name: "在对话中试用" });
    fireEvent.click(tryBtn);
    expect(usePersonalStore.getState().generalSettings.plugins!.enabled).toContain("pdf");
    expect(usePersonalStore.getState().composerInsert?.text).toBe("Review this PDF");
    expect(usePersonalStore.getState().composerInsert?.plugin).toMatchObject({ id: "pdf", name: "PDF" });
  });

  it("详情页渐变 banner 可点击试用（启用 + 预填）", async () => {
    renderWith(fakeBridge({ plugins: [plug("pdf", "PDF", { defaultPrompt: "Review this PDF" })] }));
    fireEvent.click(await screen.findByText("PDF"));
    fireEvent.click(screen.getByRole("button", { name: "在对话中试用 PDF" })); // banner aria-label
    expect(usePersonalStore.getState().generalSettings.plugins!.enabled).toContain("pdf");
    expect(usePersonalStore.getState().composerInsert?.text).toBe("Review this PDF");
  });

  it("bridge=null（web/旧壳）→ 插件首页降级空态", async () => {
    renderWith(null);
    expect(await screen.findByText(/当前环境不支持插件扫描/)).toBeTruthy();
  });
});

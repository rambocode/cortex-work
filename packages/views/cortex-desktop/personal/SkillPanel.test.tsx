// SkillPanel（技能面板）渲染与交互测试。从 PluginManager 抽出后直接渲染 SkillPanel。
// CoreProvider 注入 fake bridge;usePersonalStore 真实。
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { CoreProvider, usePersonalStore, DEFAULT_GENERAL_SETTINGS, DEFAULT_PI_SKILLS } from "@cortex-work/core";
import type { DesktopBridge, PluginSkill } from "@cortex-work/core";
import { SkillPanel } from "./SkillPanel";
import { useDesktopBridge } from "@cortex-work/core";

function sk(
  name: string,
  scope: "global" | "workspace",
  dir: string,
  docs: PluginSkill["docs"] = [],
): PluginSkill {
  return { name, description: `${name} 描述`, dir, rootPath: "/root", scope, enabled: true, trusted: scope === "global", docs };
}

function SkillPanelHost() {
  const bridge = useDesktopBridge();
  return <SkillPanel bridge={bridge} />;
}

function renderWith(bridge: DesktopBridge | null, ui: ReactElement = <SkillPanelHost />) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      {ui}
    </CoreProvider>,
  );
}

function fakeBridge(skills: PluginSkill[], createSkill?: DesktopBridge["createSkill"]): DesktopBridge {
  return {
    piSkillsList: vi.fn(async () => skills),
    openSkillDir: vi.fn(async () => ({ ok: true })),
    createSkill: createSkill ?? vi.fn(async () => ({ ok: true })),
  } as unknown as DesktopBridge;
}

beforeEach(() => {
  usePersonalStore.setState({
    generalSettings: { ...DEFAULT_GENERAL_SETTINGS, piSkills: { ...DEFAULT_PI_SKILLS } },
    projects: [],
    activeProjectId: undefined,
  });
});
afterEach(() => cleanup());

describe("SkillPanel", () => {
  it("渲染全局 skill 列表 + 统计", async () => {
    renderWith(fakeBridge([sk("code-review", "global", "/g/cr"), sk("bug-hunt", "global", "/g/bh")]));
    expect(await screen.findByText("Code Review")).toBeTruthy(); // 展示名 title-case
    expect(screen.getByText("Bug Hunt")).toBeTruthy();
    expect(screen.getByText(/已扫描 2 个/)).toBeTruthy();
    expect(screen.getByText(/2 个启用/)).toBeTruthy();
  });

  it("作用域说明 banner:点明 skill 对 claude/codex/pi 三端均生效(R9)", async () => {
    renderWith(fakeBridge([sk("code-review", "global", "/g/cr")]));
    const note = await screen.findByRole("note");
    expect(note.textContent).toMatch(/pi/);
    expect(note.textContent).toMatch(/codex/);
    expect(note.textContent).toMatch(/claude/);
    expect(note.textContent).toMatch(/三端均生效/); // 跨 agent,取代旧「仅对 pi」语义
  });

  it("点禁用 → 写 disabledSkills,统计减一", async () => {
    renderWith(fakeBridge([sk("code-review", "global", "/g/cr"), sk("bug-hunt", "global", "/g/bh")]));
    const toggle = await screen.findByRole("switch", { name: /code-review/ });
    fireEvent.click(toggle);
    expect(usePersonalStore.getState().generalSettings.piSkills!.disabledSkills).toContain("global:code-review");
    await waitFor(() => expect(screen.getByText(/1 个启用/)).toBeTruthy());
  });

  it("搜索过滤", async () => {
    renderWith(fakeBridge([sk("code-review", "global", "/g/cr"), sk("bug-hunt", "global", "/g/bh")]));
    await screen.findByText("Code Review");
    fireEvent.change(screen.getByLabelText("搜索 Skill"), { target: { value: "bug" } });
    expect(screen.queryByText("Code Review")).toBeNull();
    expect(screen.getByText("Bug Hunt")).toBeTruthy();
  });

  it("工作区未授信 skill → 显示「信任并启用」,点击写 trustedWorkspaceSkillDirs", async () => {
    usePersonalStore.setState({
      generalSettings: { ...DEFAULT_GENERAL_SETTINGS, piSkills: { ...DEFAULT_PI_SKILLS } },
      projects: [{ id: "p1", name: "p", path: "/proj", addedAt: 1 }],
      activeProjectId: "p1",
    });
    renderWith(fakeBridge([sk("ws-skill", "workspace", "/proj/.cortex-desktop/skills/ws-skill")]));
    const trustBtn = await screen.findByRole("button", { name: "信任并启用" });
    fireEvent.click(trustBtn);
    expect(usePersonalStore.getState().generalSettings.piSkills!.trustedWorkspaceSkillDirs).toContain(
      "/proj/.cortex-desktop/skills/ws-skill",
    );
  });

  it("同名全局+工作区 → 工作区卡标「已被全局同名覆盖」", async () => {
    usePersonalStore.setState({
      generalSettings: { ...DEFAULT_GENERAL_SETTINGS, piSkills: { ...DEFAULT_PI_SKILLS } },
      projects: [{ id: "p1", name: "p", path: "/proj", addedAt: 1 }],
      activeProjectId: "p1",
    });
    renderWith(
      fakeBridge([sk("dup", "global", "/g/dup"), sk("dup", "workspace", "/proj/.cortex-desktop/skills/dup")]),
    );
    expect(await screen.findByText("已被全局同名覆盖")).toBeTruthy();
  });

  it("配套文档（U5）:渲染 docs chip,点击调 bridge.openPath", async () => {
    const bridge = fakeBridge([
      sk("with-docs", "global", "/g/wd", [
        { name: "reference.md", path: "/g/wd/reference.md" },
        { name: "config.json", path: "/g/wd/config.json" },
      ]),
    ]);
    const openPath = vi.fn(async () => {});
    (bridge as unknown as { openPath: typeof openPath }).openPath = openPath;
    renderWith(bridge);
    const docBtn = await screen.findByRole("button", { name: /reference\.md/ });
    expect(screen.getByRole("button", { name: /config\.json/ })).toBeTruthy();
    fireEvent.click(docBtn);
    expect(openPath).toHaveBeenCalledWith("/g/wd/reference.md");
  });

  it("无配套文档 → 不渲染文档区", async () => {
    renderWith(fakeBridge([sk("bare", "global", "/g/bare")]));
    await screen.findByText("Bare");
    expect(screen.queryByRole("button", { name: /\.md|\.json/ })).toBeNull();
  });

  it("空结果 → 引导空态", async () => {
    renderWith(fakeBridge([]));
    expect(await screen.findByText("未发现 Skill")).toBeTruthy();
  });


  it("管理面板:添加全局目录 → 写 userGlobalRoots", async () => {
    renderWith(fakeBridge([]));
    await screen.findByText("未发现 Skill");
    fireEvent.click(screen.getByRole("button", { name: /管理/ })); // 展开管理面板
    fireEvent.change(screen.getByLabelText("新增全局目录"), { target: { value: "~/my/skills" } });
    fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
    expect(usePersonalStore.getState().generalSettings.piSkills!.userGlobalRoots).toContain("~/my/skills");
  });

  it("添加全局目录:validateDir 返回 false → 报错且不写入", async () => {
    const bridge = fakeBridge([]);
    (bridge as unknown as { validateDir: () => Promise<boolean> }).validateDir = vi.fn(async () => false);
    renderWith(bridge);
    await screen.findByText("未发现 Skill");
    fireEvent.click(screen.getByRole("button", { name: /管理/ }));
    fireEvent.change(screen.getByLabelText("新增全局目录"), { target: { value: "~/not/exist" } });
    fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
    await screen.findByRole("alert");
    expect(usePersonalStore.getState().generalSettings.piSkills!.userGlobalRoots).not.toContain("~/not/exist");
  });

  it("添加全局目录:validateDir 返回 true → 写入 userGlobalRoots", async () => {
    const bridge = fakeBridge([]);
    (bridge as unknown as { validateDir: () => Promise<boolean> }).validateDir = vi.fn(async () => true);
    renderWith(bridge);
    await screen.findByText("未发现 Skill");
    fireEvent.click(screen.getByRole("button", { name: /管理/ }));
    fireEvent.change(screen.getByLabelText("新增全局目录"), { target: { value: "~/real/skills" } });
    fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
    await waitFor(() =>
      expect(usePersonalStore.getState().generalSettings.piSkills!.userGlobalRoots).toContain("~/real/skills"),
    );
  });

  it("创建:点「创建」展开表单,填写后「添加自定义」调 createSkill", async () => {
    const createSkill = vi.fn(async () => ({ ok: true }));
    renderWith(fakeBridge([], createSkill));
    await screen.findByText("未发现 Skill");
    fireEvent.click(screen.getByRole("button", { name: /创建/ }));
    fireEvent.change(screen.getByLabelText("Skill 名称"), { target: { value: "my-plugin" } });
    fireEvent.change(screen.getByLabelText("基础描述"), { target: { value: "我的插件" } });
    fireEvent.change(screen.getByLabelText("Skill 指令"), { target: { value: "你是助手" } });
    fireEvent.click(screen.getByRole("button", { name: /添加自定义/ }));
    await waitFor(() =>
      expect(createSkill).toHaveBeenCalledWith(
        expect.objectContaining({ name: "my-plugin", description: "我的插件", body: "你是助手" }),
      ),
    );
  });

  it("目录选择器:选具体目录 → 统计按该目录计", async () => {
    usePersonalStore.setState({
      generalSettings: {
        ...DEFAULT_GENERAL_SETTINGS,
        piSkills: { ...DEFAULT_PI_SKILLS, globalRoots: ["~/.agents/skills", "~/other"] },
      },
      projects: [],
      activeProjectId: undefined,
    });
    // 两个 skill,rootPath 落在不同根。
    const a: PluginSkill = { ...sk("a", "global", "/g/a"), rootPath: "/home/u/.agents/skills" };
    const b: PluginSkill = { ...sk("b", "global", "/o/b"), rootPath: "/home/u/other" };
    renderWith(fakeBridge([a, b]));
    await screen.findByText("A");
    expect(screen.getByText(/已扫描 2 个/)).toBeTruthy();
    // 选 ~/.agents/skills → 只数尾段匹配的那 1 个。
    fireEvent.change(screen.getByLabelText("选择 Skill 目录"), { target: { value: "~/.agents/skills" } });
    expect(screen.getByText(/已扫描 1 个/)).toBeTruthy();
  });

  it("bridge=null（web/旧壳）→ 降级空态", () => {
    renderWith(null);
    expect(screen.getByText(/当前环境不支持 Skill 扫描/)).toBeTruthy();
  });
});

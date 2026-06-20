import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider, useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, GitInfoResult, ProjectMeta } from "@cortex-work/core";
import { COMMIT_PROMPT, GitBar } from "./GitBar";

const NOW = 1700000000000;

function makeProject(id: string): ProjectMeta {
  return { id, name: `proj-${id}`, path: `/code/${id}`, addedAt: NOW };
}

// GitBar 现在始终渲染(左侧 ProjectPicker),分支/统计段仅在 git 仓库时出现。
// 项目名由内置 ProjectPicker 从 store.projects 查 value 显示,故把 project 放进 store
// 并传 projectValue=project.id。
function renderBar(
  info: GitInfoResult | null,
  opts: { project?: ProjectMeta; running?: boolean; onSend?: (t: string) => void; onToast?: (t: string) => void } = {},
) {
  const project = opts.project ?? makeProject("p1");
  usePersonalStore.setState({ projects: [project] });
  const bridge = (info ? { gitInfo: async () => info } : {}) as unknown as DesktopBridge;
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <GitBar
        project={project}
        projectValue={project.id}
        running={opts.running ?? false}
        onSend={opts.onSend ?? (() => {})}
        onToast={opts.onToast ?? (() => {})}
      />
    </CoreProvider>,
  );
}

describe("GitBar 项目·分支信息条", () => {
  afterEach(() => cleanup());

  it("非 git 仓库:仍显示项目选择器,但无分支段/统计", async () => {
    const { container } = renderBar(
      { isRepo: false, additions: 0, deletions: 0, dirty: false },
      { project: makeProject("norepo") },
    );
    await Promise.resolve();
    // 整条始终在(含项目选择器),只是分支按钮/统计不出现。
    expect(container.querySelector(".pw-gitbar")).not.toBeNull();
    expect(container.querySelector(".pw-gitbar-branch")).toBeNull();
    expect(screen.queryByTitle("查看 diff")).toBeNull();
  });

  it("无 gitInfo 能力(旧壳/web):仍显示项目选择器,无分支段", () => {
    const { container } = renderBar(null, { project: makeProject("nocap") });
    expect(container.querySelector(".pw-gitbar")).not.toBeNull();
    expect(container.querySelector(".pw-gitbar-branch")).toBeNull();
  });

  it("工作区干净:显示项目名(ProjectPicker)与分支,无统计徽章和 Commit 按钮", async () => {
    renderBar(
      { isRepo: true, branch: "main", additions: 0, deletions: 0, dirty: false },
      { project: makeProject("clean") },
    );
    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(screen.getByText("proj-clean")).toBeInTheDocument();
    expect(screen.queryByTitle("查看 diff")).toBeNull();
    expect(screen.queryByRole("button", { name: "Commit changes" })).toBeNull();
  });

  it("工作区脏:显示 ± 统计(千分位)与 Commit 按钮", async () => {
    renderBar(
      { isRepo: true, branch: "master", additions: 4743, deletions: 109, dirty: true },
      { project: makeProject("dirty") },
    );
    expect(await screen.findByText("+4,743")).toBeInTheDocument();
    expect(screen.getByText("−109")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit changes" })).toBeEnabled();
  });

  it("点击 ± 徽章:打开右栏并发出整仓 diff 请求(rightView 切到 files)", async () => {
    useCortexUIStore.setState({ rightOpen: false });
    usePersonalStore.setState({ gitDiffRequest: undefined, rightView: "todos" });
    const project = makeProject("diffreq");
    renderBar({ isRepo: true, branch: "main", additions: 1, deletions: 2, dirty: true }, { project });
    fireEvent.click(await screen.findByTitle("查看 diff"));
    expect(usePersonalStore.getState().gitDiffRequest).toEqual({ projectId: project.id });
    expect(usePersonalStore.getState().rightView).toBe("files");
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });

  it("点击 Commit changes:发送固定提交指令并 toast", async () => {
    const onSend = vi.fn();
    const onToast = vi.fn();
    renderBar(
      { isRepo: true, branch: "main", additions: 5, deletions: 0, dirty: true },
      { project: makeProject("commit"), onSend, onToast },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Commit changes" }));
    expect(onSend).toHaveBeenCalledWith(COMMIT_PROMPT);
    expect(onSend).toHaveBeenCalledWith("Commit the working tree changes with a sensible message.");
    expect(onToast).toHaveBeenCalled();
  });

  it("session 运行中:Commit 按钮禁用", async () => {
    renderBar(
      { isRepo: true, branch: "main", additions: 5, deletions: 0, dirty: true },
      { project: makeProject("running"), running: true },
    );
    expect(await screen.findByRole("button", { name: "Commit changes" })).toBeDisabled();
  });

  it("统计被截断时显示 ≈ 提示", async () => {
    renderBar(
      { isRepo: true, branch: "main", additions: 10, deletions: 0, dirty: true, truncated: true },
      { project: makeProject("trunc") },
    );
    expect(await screen.findByText("≈")).toBeInTheDocument();
  });

  it("项目档只读:展示项目名但点击不弹出切换菜单(换项目走「新会话」)", () => {
    renderBar({ isRepo: true, branch: "main", additions: 0, deletions: 0, dirty: false }, { project: makeProject("ro") });
    const trigger = screen.getByText("proj-ro").closest("button")!;
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(trigger);
    // 只读:不出现可切换面板项（搜索框 / 添加新项目 / 不使用项目）。
    expect(screen.queryByPlaceholderText(/检索项目/)).toBeNull();
    expect(screen.queryByText("添加新项目")).toBeNull();
    expect(screen.queryByText("不使用项目")).toBeNull();
  });

  it("新会话页用法(传 onChangeProject、不传 onSend):项目可切 + 分支显示 + 无 Commit", async () => {
    const project = makeProject("new");
    usePersonalStore.setState({ projects: [project] });
    const bridge = {
      gitInfo: async () => ({ isRepo: true, branch: "dev", additions: 5, deletions: 1, dirty: true }),
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <GitBar project={project} projectValue={project.id} onChangeProject={() => {}} running={false} onToast={() => {}} />
      </CoreProvider>,
    );
    // 分支信息保留。
    expect(await screen.findByText("dev")).toBeInTheDocument();
    // 无 session:不显示 ± 统计 / Commit。
    expect(screen.queryByRole("button", { name: "Commit changes" })).toBeNull();
    expect(screen.queryByTitle("查看 diff")).toBeNull();
    // 项目可切:trigger 非只读,点击弹出选择面板。
    const trigger = screen.getByText("proj-new").closest("button")!;
    expect(trigger).not.toHaveAttribute("aria-disabled");
    fireEvent.click(trigger);
    expect(screen.getByPlaceholderText(/检索项目/)).toBeInTheDocument();
    expect(screen.getByText("不使用项目")).toBeInTheDocument();
  });
});

describe("GitBar 运行模式选择器", () => {
  afterEach(() => cleanup());

  function renderMode(props: {
    permissionMode?: "plan" | "accept-edits" | "full-auto";
    onChangeMode?: (m: string) => void;
  }) {
    const project = makeProject("mode");
    usePersonalStore.setState({ projects: [project] });
    return render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={{} as unknown as DesktopBridge}>
        <GitBar
          project={project}
          projectValue={project.id}
          permissionMode={props.permissionMode}
          onChangeMode={props.onChangeMode}
          running={false}
          onToast={() => {}}
        />
      </CoreProvider>,
    );
  }

  // 模式 select = pw-gitbar-left 内含 full-auto 选项的那个 select（与无关 select 区分）。
  function modeSelect(container: HTMLElement): HTMLSelectElement {
    const selects = Array.from(container.querySelectorAll<HTMLSelectElement>(".pw-gitbar-left select"));
    const sel = selects.find((s) => Array.from(s.options).some((o) => o.value === "full-auto"));
    if (!sel) throw new Error("模式选择器未渲染");
    return sel;
  }

  it("提供 onChangeMode → 项目前渲染三档选择器,缺省回显 full-auto", () => {
    const { container } = renderMode({ onChangeMode: () => {} });
    const sel = modeSelect(container);
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["plan", "accept-edits", "full-auto"]);
    expect(sel.value).toBe("full-auto");
    // 位置:模式选择器在项目名(ProjectPicker)之前。
    const left = container.querySelector(".pw-gitbar-left")!;
    const proj = left.querySelector(".pw-gitbar-mode");
    expect(proj).not.toBeNull();
    expect(left.firstElementChild).toBe(proj);
  });

  it("选择 plan → 触发 onChangeMode('plan')", () => {
    const onChangeMode = vi.fn();
    const { container } = renderMode({ permissionMode: "full-auto", onChangeMode });
    fireEvent.change(modeSelect(container), { target: { value: "plan" } });
    expect(onChangeMode).toHaveBeenCalledWith("plan");
  });

  it("受控回显:permissionMode=accept-edits → select 显示该档", () => {
    const { container } = renderMode({ permissionMode: "accept-edits", onChangeMode: () => {} });
    expect(modeSelect(container).value).toBe("accept-edits");
  });

  it("未提供 onChangeMode → 不渲染模式选择器(隐藏入口)", () => {
    const { container } = renderMode({});
    expect(container.querySelector(".pw-gitbar-mode")).toBeNull();
  });
});

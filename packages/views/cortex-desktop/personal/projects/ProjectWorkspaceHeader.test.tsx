// 项目详情头部 + 设置面板 + 阶段栏组件测试：进度实时、删除解锁门控、阶段 tab 过滤/视图切换/添加。
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskMeta, TaskProject } from "@cortex-work/core/desktop/types";
import { ProjectWorkspaceHeader } from "./ProjectWorkspaceHeader";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { ProjectStagesBar } from "./ProjectStagesBar";

const updateProject = vi.fn();
const deleteProject = vi.fn();
vi.mock("@cortex-work/core/personal/tasks", () => ({
  useUpdateTaskProject: () => ({ mutate: updateProject }),
  useDeleteTaskProject: () => ({ mutate: deleteProject }),
  useStageTemplates: () => ({ data: [] }), // 自定义模板空；内置模板由 mergeTemplates 真实合并
}));

const project: TaskProject = { id: "p1", name: "发布计划", kind: "project", note: "第一行描述\n第二行" };
const t = (status: TaskMeta["status"]): TaskMeta =>
  ({ id: Math.random().toString(), title: "t", status, tags: [], source: "manual", createdAt: 0, updatedAt: 0 });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectWorkspaceHeader", () => {
  it("进度 = done/非 dropped 总数（3 任务 1 done + 1 dropped → 50%），描述只显首行", () => {
    render(
      <ProjectWorkspaceHeader project={project} tasks={[t("done"), t("active"), t("dropped")]} onToast={vi.fn()} />,
    );
    expect(screen.getByText(/50%/)).toBeTruthy();
    expect(screen.getByText("第一行描述")).toBeTruthy();
    expect(screen.queryByText(/第二行/)).toBeNull();
  });

  it("零任务 → 0%；齿轮点击弹出项目设置面板", () => {
    render(<ProjectWorkspaceHeader project={project} tasks={[]} onToast={vi.fn()} />);
    expect(screen.getByText(/0%/)).toBeTruthy();
    fireEvent.click(screen.getByTitle("项目设置"));
    expect(screen.getByRole("dialog", { name: "项目设置" })).toBeTruthy();
  });
});

describe("ProjectSettingsPanel", () => {
  it("删除按钮在输入项目名精确匹配前 disabled，匹配后可删", () => {
    render(<ProjectSettingsPanel project={project} onClose={vi.fn()} onToast={vi.fn()} />);
    const deleteBtn = screen.getByText("删除") as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);

    const confirm = screen.getByPlaceholderText("发布计划");
    fireEvent.change(confirm, { target: { value: "发布" } });
    expect((screen.getByText("删除") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(confirm, { target: { value: "发布计划" } });
    const unlocked = screen.getByText("删除") as HTMLButtonElement;
    expect(unlocked.disabled).toBe(false);
    fireEvent.click(unlocked);
    expect(deleteProject).toHaveBeenCalledWith("p1", expect.anything());
  });

  it("应用阶段模板：无阶段项目直接应用（实例化 not-started 阶段整表提交）", () => {
    render(<ProjectSettingsPanel project={project} onClose={vi.fn()} onToast={vi.fn()} />);
    const select = screen.getByLabelText("选择阶段模板") as HTMLSelectElement;
    const applyBtn = screen.getByText("应用") as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true); // 未选模板不可应用

    fireEvent.change(select, { target: { value: "tpl-builtin-product" } }); // 产品设计（4 阶段）
    fireEvent.click(screen.getByText("应用"));
    const arg = updateProject.mock.calls[0]![0] as { id: string; patch: { stages: Array<Record<string, unknown>> } };
    expect(arg.id).toBe("p1");
    expect(arg.patch.stages.map((s) => s.name)).toEqual(["调研", "设计", "开发", "发布"]);
    expect(arg.patch.stages.every((s) => s.status === "not-started")).toBe(true);
  });

  it("已有阶段的项目应用模板需两步确认（首击不提交）", () => {
    const staged = { ...project, stages: [{ id: "s1", name: "旧阶段", status: "active" as const, order: 0 }] };
    render(<ProjectSettingsPanel project={staged} onClose={vi.fn()} onToast={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("选择阶段模板"), { target: { value: "tpl-builtin-simple" } });
    fireEvent.click(screen.getByText("应用"));
    expect(updateProject).not.toHaveBeenCalled(); // 首击只进确认态
    expect(screen.getByText(/将替换现有 1 个阶段/)).toBeTruthy();
    fireEvent.click(screen.getByText("确认替换"));
    const arg = updateProject.mock.calls[0]![0] as { patch: { stages: Array<{ name: string }> } };
    expect(arg.patch.stages.map((s) => s.name)).toEqual(["待办"]);
  });

  it("状态 chips 点击发 status patch；备注失焦发 note patch", () => {
    render(<ProjectSettingsPanel project={project} onClose={vi.fn()} onToast={vi.fn()} />);
    fireEvent.click(screen.getByText("暂停"));
    expect(updateProject).toHaveBeenCalledWith(
      { id: "p1", patch: { status: "on-hold" } },
      expect.anything(),
    );
    const note = screen.getByPlaceholderText("项目描述…");
    fireEvent.change(note, { target: { value: "新描述" } });
    fireEvent.blur(note);
    expect(updateProject).toHaveBeenCalledWith({ id: "p1", patch: { note: "新描述" } }, expect.anything());
  });
});

describe("ProjectStagesBar", () => {
  const staged: TaskProject = {
    ...project,
    stages: [
      { id: "s1", name: "调研", status: "done", order: 0 },
      { id: "s2", name: "开发", status: "active", order: 1 },
    ],
  };

  it("渲染「全部」+ 各阶段 tab（状态色圆点）；点击 tab 回调 stage id、「全部」回 null", () => {
    const onStageChange = vi.fn();
    const { container } = render(
      <ProjectStagesBar
        project={staged}
        activeStageId={null}
        onStageChange={onStageChange}
        view="list"
        onViewChange={vi.fn()}
        onToast={vi.fn()}
      />,
    );
    expect(container.querySelector(".pw-stage-dot--done")).toBeTruthy();
    expect(container.querySelector(".pw-stage-dot--active")).toBeTruthy();

    fireEvent.click(screen.getByText("开发"));
    expect(onStageChange).toHaveBeenCalledWith("s2");
    fireEvent.click(screen.getByText("全部"));
    expect(onStageChange).toHaveBeenCalledWith(null);
  });

  it("视图切换按钮回调 list/timeline", () => {
    const onViewChange = vi.fn();
    render(
      <ProjectStagesBar
        project={staged}
        activeStageId={null}
        onStageChange={vi.fn()}
        view="list"
        onViewChange={onViewChange}
        onToast={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle("Timeline 视图"));
    expect(onViewChange).toHaveBeenCalledWith("timeline");
  });

  it("「添加」内联输入回车 → 整表替换追加新阶段（not-started、order 递增）", () => {
    render(
      <ProjectStagesBar
        project={staged}
        activeStageId={null}
        onStageChange={vi.fn()}
        view="list"
        onViewChange={vi.fn()}
        onToast={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("添加"));
    const input = screen.getByPlaceholderText("阶段名，回车添加");
    fireEvent.change(input, { target: { value: "测试" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(updateProject).toHaveBeenCalledTimes(1);
    const arg = updateProject.mock.calls[0]![0] as { id: string; patch: { stages: Array<Record<string, unknown>> } };
    expect(arg.id).toBe("p1");
    expect(arg.patch.stages).toHaveLength(3);
    expect(arg.patch.stages[2]).toMatchObject({ name: "测试", status: "not-started", order: 2 });
  });

  it("阶段编辑浮层是表单型：鼠标移出与 window blur 都不自动关闭（原生日期日历会移出 DOM 且抢焦点）", async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <ProjectStagesBar
          project={staged}
          activeStageId={null}
          onStageChange={vi.fn()}
          view="list"
          onViewChange={vi.fn()}
          onToast={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByTitle("编辑阶段「调研」"));
      expect(screen.getByRole("dialog", { name: "编辑阶段「调研」" })).toBeTruthy();

      // 鼠标移出 tabs 区（原生日历悬停等价场景）→ 过 220ms 收起定时器窗口后仍在。
      fireEvent.mouseLeave(container.querySelector(".pw-stages-tabs")!);
      vi.advanceTimersByTime(500);
      expect(screen.getByRole("dialog", { name: "编辑阶段「调研」" })).toBeTruthy();

      // 原生日历弹层抢走窗口焦点（window blur）→ 仍在。
      fireEvent.blur(window);
      expect(screen.getByRole("dialog", { name: "编辑阶段「调研」" })).toBeTruthy();

      // Esc 仍可关闭（关闭通路保留：外点 / Esc / 关闭按钮）。
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "编辑阶段「调研」" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("阶段编辑浮层：改状态 patch 只动目标阶段；删除两步确认且当前过滤指向被删阶段时回「全部」", () => {
    const onStageChange = vi.fn();
    render(
      <ProjectStagesBar
        project={staged}
        activeStageId="s1"
        onStageChange={onStageChange}
        view="list"
        onViewChange={vi.fn()}
        onToast={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle("编辑阶段「调研」"));
    // 状态改为「进行中」。
    fireEvent.click(screen.getByRole("dialog", { name: "编辑阶段「调研」" }).querySelector("button.pw-ps-chip:nth-of-type(2)")!);
    const stagesAfterStatus = (updateProject.mock.calls[0]![0] as { patch: { stages: Array<{ id: string; status: string }> } })
      .patch.stages;
    expect(stagesAfterStatus.find((s) => s.id === "s1")!.status).toBe("active");
    expect(stagesAfterStatus.find((s) => s.id === "s2")!.status).toBe("active"); // 未动

    // 两步删除。
    fireEvent.click(screen.getByText("删除阶段"));
    expect(updateProject).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("确认删除"));
    const stagesAfterDelete = (updateProject.mock.calls[1]![0] as { patch: { stages: Array<{ id: string }> } }).patch.stages;
    expect(stagesAfterDelete.map((s) => s.id)).toEqual(["s2"]);
    expect(onStageChange).toHaveBeenCalledWith(null); // 过滤回「全部」
  });
});

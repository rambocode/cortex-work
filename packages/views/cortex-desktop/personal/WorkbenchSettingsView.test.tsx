// 设置视图（阶段模板 / 项目资源）组件测试：tab 切换、内置模板锁定、模板/成员 CRUD 回调、岗位标签。
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchSettingsView } from "./WorkbenchSettingsView";
import { StageTemplateManager } from "./StageTemplateManager";
import { MemberManager } from "./MemberManager";

// mock core hooks（纯函数 stageTemplates/members 保持真实）。
const addTemplate = vi.fn();
const updateTemplate = vi.fn();
const deleteTemplate = vi.fn();
const addMember = vi.fn();
const updateMember = vi.fn();
const deleteMember = vi.fn();
const setJobTypes = vi.fn();
let customTemplates: unknown[] = [];
let members: unknown[] = [];
let jobTypes: string[] | undefined;

vi.mock("@cortex-work/core/personal/tasks", () => ({
  useStageTemplates: () => ({ data: customTemplates }),
  useAddStageTemplate: () => ({ mutate: addTemplate }),
  useUpdateStageTemplate: () => ({ mutate: updateTemplate }),
  useDeleteStageTemplate: () => ({ mutate: deleteTemplate }),
  useMembers: () => ({ data: members }),
  useAddMember: () => ({ mutate: addMember }),
  useUpdateMember: () => ({ mutate: updateMember }),
  useDeleteMember: () => ({ mutate: deleteMember }),
  useJobTypes: () => ({ data: jobTypes }),
  useSetJobTypes: () => ({ mutate: setJobTypes }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  customTemplates = [];
  members = [];
  jobTypes = undefined;
});

describe("WorkbenchSettingsView", () => {
  it("默认显示阶段模板 tab，可切到项目资源，关闭回调触发", () => {
    const onClose = vi.fn();
    render(<WorkbenchSettingsView onClose={onClose} onToast={vi.fn()} />);
    expect(screen.getByText("创建项目时可选择的阶段模板")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "项目资源" }));
    expect(screen.getByText("团队成员")).toBeTruthy();

    fireEvent.click(screen.getByTitle("关闭设置"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("StageTemplateManager", () => {
  it("内置模板全部渲染、带内置徽标且无编辑/删除入口", () => {
    render(<StageTemplateManager onToast={vi.fn()} />);
    expect(screen.getByText("软件项目")).toBeTruthy();
    expect(screen.getByText("营销活动")).toBeTruthy();
    expect(screen.getAllByText("内置")).toHaveLength(6);
    // 内置卡片锁定：整页无编辑/删除按钮（无自定义模板时）。
    expect(screen.queryByTitle("编辑模板")).toBeNull();
    expect(screen.queryByTitle("删除模板（不影响已创建的项目）")).toBeNull();
    // 软件项目 8 阶段链式预览首尾。
    expect(screen.getByText("客户洽谈")).toBeTruthy();
    expect(screen.getByText("结项")).toBeTruthy();
  });

  it("新建模板：输入名称 + 回车加阶段 → 创建提交清洗后的输入", () => {
    render(<StageTemplateManager onToast={vi.fn()} />);
    fireEvent.click(screen.getByText("新建模板"));
    fireEvent.change(screen.getByPlaceholderText("模板名称"), { target: { value: " 我的流程 " } });
    const stageInput = screen.getByPlaceholderText("输入阶段名，回车添加…");
    fireEvent.change(stageInput, { target: { value: "启动" } });
    fireEvent.keyDown(stageInput, { key: "Enter" });
    fireEvent.change(stageInput, { target: { value: "收尾" } });
    fireEvent.keyDown(stageInput, { key: "Enter" });
    fireEvent.click(screen.getByText("创建"));
    expect(addTemplate).toHaveBeenCalledWith(
      { name: "我的流程", description: undefined, stages: ["启动", "收尾"] },
      expect.anything(),
    );
  });

  it("名称为空时不提交并显示校验错误", () => {
    render(<StageTemplateManager onToast={vi.fn()} />);
    fireEvent.click(screen.getByText("新建模板"));
    fireEvent.click(screen.getByText("创建"));
    expect(addTemplate).not.toHaveBeenCalled();
    expect(screen.getByText("模板名称不能为空")).toBeTruthy();
  });

  it("自定义模板可编辑与两步确认删除", () => {
    customTemplates = [{ id: "tpl-x", name: "自定义流程", stages: ["a"] }];
    render(<StageTemplateManager onToast={vi.fn()} />);
    expect(screen.getByText("自定义流程")).toBeTruthy();

    // 两步删除：第一步出确认按钮，第二步真正 mutate。
    fireEvent.click(screen.getByTitle("删除模板（不影响已创建的项目）"));
    expect(deleteTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("确认删除"));
    expect(deleteTemplate).toHaveBeenCalledWith("tpl-x", expect.anything());
  });
});

describe("MemberManager", () => {
  it("岗位标签：未编辑时显示默认六岗位；快速新增走整表替换", () => {
    render(<MemberManager onToast={vi.fn()} />);
    for (const jt of ["开发", "设计", "产品", "测试", "运维", "项目经理"]) {
      expect(screen.getByText(jt)).toBeTruthy();
    }
    const input = screen.getByPlaceholderText("快速新增…");
    fireEvent.change(input, { target: { value: "运营" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setJobTypes).toHaveBeenCalledWith(
      ["开发", "设计", "产品", "测试", "运维", "项目经理", "运营"],
      expect.anything(),
    );
  });

  it("添加成员：姓名 + 点选岗位 chip → 提交", () => {
    render(<MemberManager onToast={vi.fn()} />);
    fireEvent.click(screen.getByText("添加成员"));
    fireEvent.change(screen.getByPlaceholderText("成员姓名"), { target: { value: "jone" } });
    // 表单里的岗位 chips 与标签区并存 → 取表单作用域内的「开发」。
    const form = screen.getByRole("form", { name: "添加成员" });
    fireEvent.click(Array.from(form.querySelectorAll("button")).find((b) => b.textContent === "开发")!);
    fireEvent.click(screen.getByText("添加"));
    expect(addMember).toHaveBeenCalledWith({ name: "jone", role: "开发" }, expect.anything());
  });

  it("空姓名不提交并显示校验错误", () => {
    render(<MemberManager onToast={vi.fn()} />);
    fireEvent.click(screen.getByText("添加成员"));
    fireEvent.click(screen.getByText("添加"));
    expect(addMember).not.toHaveBeenCalled();
    expect(screen.getByText("成员姓名不能为空")).toBeTruthy();
  });

  it("成员卡片：渲染岗位 tag 与截断 ID；删除走两步确认（提示解绑）", () => {
    members = [{ id: "member-abc12345678901234", name: "mike", role: "设计" }];
    render(<MemberManager onToast={vi.fn()} />);
    expect(screen.getByText("mike")).toBeTruthy();
    // 「设计」在岗位标签区与成员 role tag 各出现一次 → 断言出现两处。
    expect(screen.getAllByText("设计")).toHaveLength(2);
    expect(screen.getByText(/^ID: member-abc/)).toBeTruthy();

    fireEvent.click(screen.getByTitle("删除成员（将从所有任务解绑）"));
    expect(deleteMember).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("确认删除"));
    expect(deleteMember).toHaveBeenCalledWith("member-abc12345678901234", expect.anything());
  });
});

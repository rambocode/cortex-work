// 任务「阶段 / 成员」字段测试：写回 useUpdateTask 的 patch 形状、悬空引用容错、空库降级。
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectStage, TaskMeta } from "@cortex-work/core/desktop/types";
import { StageSelectField } from "./StageSelectField";
import { TaskMemberField } from "./TaskMemberField";

const updateTask = vi.fn();
let members: Array<{ id: string; name: string; role?: string }> = [];
vi.mock("@cortex-work/core/personal/tasks", () => ({
  useUpdateTask: () => ({ mutate: updateTask }),
  useMembers: () => ({ data: members }),
}));

const task = (extra: Partial<TaskMeta> = {}): TaskMeta =>
  ({ id: "t1", title: "任务", status: "active", tags: [], source: "manual", createdAt: 0, updatedAt: 0, ...extra });

const stages: ProjectStage[] = [
  { id: "s2", name: "开发", status: "active", order: 1 },
  { id: "s1", name: "调研", status: "done", order: 0 },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  members = [];
});

describe("StageSelectField", () => {
  it("按 order 排序渲染选项；选择阶段写 stageId、选「未归阶段」清空", () => {
    render(<StageSelectField task={task()} stages={stages} />);
    const select = screen.getByLabelText("所属阶段") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["未归阶段", "调研", "开发"]);

    fireEvent.change(select, { target: { value: "s2" } });
    expect(updateTask).toHaveBeenCalledWith({ id: "t1", patch: { stageId: "s2" } });

    fireEvent.change(select, { target: { value: "" } });
    expect(updateTask).toHaveBeenCalledWith({ id: "t1", patch: { stageId: undefined } });
  });

  it("悬空 stageId（阶段已删）按未归阶段显示", () => {
    render(<StageSelectField task={task({ stageId: "gone" })} stages={stages} />);
    expect((screen.getByLabelText("所属阶段") as HTMLSelectElement).value).toBe("");
  });
});

describe("TaskMemberField", () => {
  it("成员库为空 → 引导文案", () => {
    render(<TaskMemberField task={task()} />);
    expect(screen.getByText(/成员库为空/)).toBeTruthy();
  });

  it("下拉追加成员：patch 追加 id；已选成员从下拉消失", () => {
    members = [
      { id: "m1", name: "jone", role: "开发" },
      { id: "m2", name: "mike" },
    ];
    render(<TaskMemberField task={task({ memberIds: ["m1"] })} />);
    // 已选 m1 → chip 呈现且下拉只剩 m2。
    expect(screen.getByText("jone")).toBeTruthy();
    const select = screen.getByLabelText("分配成员") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "m2"]);

    fireEvent.change(select, { target: { value: "m2" } });
    expect(updateTask).toHaveBeenCalledWith({ id: "t1", patch: { memberIds: ["m1", "m2"] } });
  });

  it("移除唯一成员 → memberIds 置 undefined（清字段而非留空数组）", () => {
    members = [{ id: "m1", name: "jone" }];
    render(<TaskMemberField task={task({ memberIds: ["m1"] })} />);
    fireEvent.click(screen.getByTitle("移除成员 jone"));
    expect(updateTask).toHaveBeenCalledWith({ id: "t1", patch: { memberIds: undefined } });
  });

  it("悬空成员 id（已删）不渲染 chip", () => {
    members = [{ id: "m1", name: "jone" }];
    render(<TaskMemberField task={task({ memberIds: ["gone", "m1"] })} />);
    expect(screen.getByText("jone")).toBeTruthy();
    expect(screen.queryByText("gone")).toBeNull();
  });
});

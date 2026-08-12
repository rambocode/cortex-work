import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, ProjectMeta } from "@cortex-work/core";
import { ProjectBar } from "./ProjectBar";

const NOW = 1700000000000;

function makeProject(id: string): ProjectMeta {
  return { id, name: `proj-${id}`, path: `/code/${id}`, addedAt: NOW };
}

// 项目名由内置 ProjectPicker 从 store.projects 查 value 显示,故先把项目放进 store。
function renderBar(value: string | undefined, projects: ProjectMeta[], onChange = () => {}) {
  usePersonalStore.setState({ projects });
  return render(
    <CoreProvider
      wsId="test-ws"
      identity={{ userId: "me", name: "我" }}
      desktopBridge={{} as unknown as DesktopBridge}
    >
      <ProjectBar value={value} onChange={onChange} onToast={() => {}} />
    </CoreProvider>,
  );
}

describe("ProjectBar 新会话项目条", () => {
  afterEach(() => cleanup());

  it("未选项目:显示「不使用项目」", () => {
    const { container } = renderBar(undefined, [makeProject("p1")]);
    expect(container.querySelector(".pw-project-bar")).not.toBeNull();
    expect(screen.getByText("不使用项目")).toBeInTheDocument();
  });

  it("已选项目:显示项目名,且可点开切换面板(含「不使用项目」项)", () => {
    const project = makeProject("picked");
    renderBar(project.id, [project]);
    const trigger = screen.getByText("proj-picked").closest("button")!;
    expect(trigger).not.toHaveAttribute("aria-disabled");
    fireEvent.click(trigger);
    expect(screen.getByPlaceholderText(/检索项目/)).toBeInTheDocument();
    expect(screen.getByText("添加新项目")).toBeInTheDocument();
    expect(screen.getByText("不使用项目")).toBeInTheDocument();
  });

  it("不再展示 git 信息(分支 / ± 统计 / Commit)", () => {
    const project = makeProject("git");
    const { container } = renderBar(project.id, [project]);
    expect(container.querySelector(".pw-gitbar-branch")).toBeNull();
    expect(screen.queryByTitle("查看 diff")).toBeNull();
    expect(screen.queryByRole("button", { name: "Commit changes" })).toBeNull();
  });
});

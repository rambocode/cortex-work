import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider, useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, GitInfoResult, ProjectMeta } from "@cortex-work/core";
import { COMMIT_PROMPT, GitBar } from "./GitBar";

const NOW = 1700000000000;

function makeProject(id: string): ProjectMeta {
  return { id, name: `proj-${id}`, path: `/code/${id}`, addedAt: NOW };
}

function renderBar(
  info: GitInfoResult | null,
  opts: { project?: ProjectMeta; running?: boolean; onSend?: (t: string) => void; onToast?: (t: string) => void } = {},
) {
  const project = opts.project ?? makeProject("p1");
  const bridge = (info
    ? { gitInfo: async () => info }
    : {}) as unknown as DesktopBridge;
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <GitBar
        project={project}
        running={opts.running ?? false}
        onSend={opts.onSend ?? (() => {})}
        onToast={opts.onToast ?? (() => {})}
      />
    </CoreProvider>,
  );
}

describe("GitBar git 信息条", () => {
  afterEach(() => cleanup());

  it("非 git 仓库不渲染", async () => {
    const { container } = renderBar(
      { isRepo: false, additions: 0, deletions: 0, dirty: false },
      { project: makeProject("norepo") },
    );
    // 等一拍让 query 落定
    await Promise.resolve();
    expect(container.querySelector(".pw-gitbar")).toBeNull();
  });

  it("无 gitInfo 能力(旧壳/web)不渲染", () => {
    const { container } = renderBar(null, { project: makeProject("nocap") });
    expect(container.querySelector(".pw-gitbar")).toBeNull();
  });

  it("工作区干净:只显示项目名与分支,无统计徽章和 Commit 按钮", async () => {
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
});

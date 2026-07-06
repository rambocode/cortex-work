// 写作工作区运行态 store 单测:当前文件切换、重命名同步、删除收敛。
import { beforeEach, describe, expect, it } from "vitest";
import { useWritingWorkspaceStore } from "./workspace-store";

beforeEach(() => {
  useWritingWorkspaceStore.setState({ currentFile: null });
});

describe("useWritingWorkspaceStore", () => {
  it("setCurrentFile 打开/关闭", () => {
    useWritingWorkspaceStore.getState().setCurrentFile("/root/a.md");
    expect(useWritingWorkspaceStore.getState().currentFile).toBe("/root/a.md");
    useWritingWorkspaceStore.getState().setCurrentFile(null);
    expect(useWritingWorkspaceStore.getState().currentFile).toBeNull();
  });

  it("renameCurrentFile 命中当前文件 → 同步到新路径", () => {
    useWritingWorkspaceStore.getState().setCurrentFile("/root/a.md");
    useWritingWorkspaceStore.getState().renameCurrentFile("/root/a.md", "/root/b.md");
    expect(useWritingWorkspaceStore.getState().currentFile).toBe("/root/b.md");
  });

  it("renameCurrentFile 未命中 → 不动", () => {
    useWritingWorkspaceStore.getState().setCurrentFile("/root/a.md");
    useWritingWorkspaceStore.getState().renameCurrentFile("/root/other.md", "/root/x.md");
    expect(useWritingWorkspaceStore.getState().currentFile).toBe("/root/a.md");
  });

  it("handlePathRemoved 删除当前文件 → 回落 null", () => {
    useWritingWorkspaceStore.getState().setCurrentFile("/root/a.md");
    useWritingWorkspaceStore.getState().handlePathRemoved("/root/a.md");
    expect(useWritingWorkspaceStore.getState().currentFile).toBeNull();
  });

  it("handlePathRemoved 删除祖先目录 → 当前文件一并关闭", () => {
    useWritingWorkspaceStore.getState().setCurrentFile("/root/sub/a.md");
    useWritingWorkspaceStore.getState().handlePathRemoved("/root/sub");
    expect(useWritingWorkspaceStore.getState().currentFile).toBeNull();
  });

  it("handlePathRemoved 删除无关路径 → 当前文件保留", () => {
    useWritingWorkspaceStore.getState().setCurrentFile("/root/a.md");
    useWritingWorkspaceStore.getState().handlePathRemoved("/root/b.md");
    expect(useWritingWorkspaceStore.getState().currentFile).toBe("/root/a.md");
  });
});

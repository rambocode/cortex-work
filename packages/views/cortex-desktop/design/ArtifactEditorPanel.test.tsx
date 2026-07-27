import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import {
  ArtifactEditorPanel,
  switchArtifactWorkspace,
} from "./ArtifactEditorPanel";

describe("ArtifactEditorPanel", () => {
  it("切换工作区前清空上一个项目的设计 store", () => {
    const resetWorkspace = vi.fn();
    const setWorkspaceRoot = vi.fn();
    switchArtifactWorkspace(
      { workspaceRoot: "/project-a", resetWorkspace, setWorkspaceRoot },
      "/project-b",
    );
    expect(resetWorkspace).toHaveBeenCalledOnce();
    expect(setWorkspaceRoot).toHaveBeenCalledWith("/project-b");
  });

  it("重复打开同一工作区不清空当前设计 store", () => {
    const resetWorkspace = vi.fn();
    const setWorkspaceRoot = vi.fn();
    switchArtifactWorkspace(
      { workspaceRoot: "/project", resetWorkspace, setWorkspaceRoot },
      "/project",
    );
    expect(resetWorkspace).not.toHaveBeenCalled();
    expect(setWorkspaceRoot).toHaveBeenCalledWith("/project");
  });

  it("持久引用失效时显示错误且不打开其它文稿", async () => {
    const bridge = {
      artifactValidate: async () => ({ ok: false as const, error: "产物入口不存在" }),
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
        <ArtifactEditorPanel
          artifact={{
            kind: "design",
            documentId: "missing",
            title: "Missing",
            workspaceRoot: "/project",
            entryPath: "/project/.cortex-design/missing",
            createdAt: 1,
            updatedAt: 1,
          }}
        />
      </CoreProvider>,
    );
    expect(await screen.findByText("产物入口不存在")).toBeTruthy();
  });
});

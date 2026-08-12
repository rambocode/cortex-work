// WritingSidebar 徽标单测(U6):文件树对存在待审阅(pending)的文件显示徽标;审阅清除后徽标消失。
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge, PromptNode } from "@cortex-work/core";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import { useWritingWorkspaceStore } from "@cortex-work/core/writing/workspace-store";
import {
  __resetWritingReviews,
  useWritingReviewStore,
} from "@cortex-work/core/writing/review-manager";
import { WritingSidebar } from "./WritingSidebar";

const ROOT = "/space";
const A = "/space/a.md";
const B = "/space/b.md";

// 固定文件树:两个文件,徽标只应挂在 pending 命中的那个上。
const TREE: PromptNode = {
  name: "space",
  path: ROOT,
  kind: "dir",
  children: [
    { name: "a.md", path: A, kind: "file" },
    { name: "b.md", path: B, kind: "file" },
  ],
};

function fakeBridge(): DesktopBridge {
  return {
    scanDirTree: async () => TREE,
  } as unknown as DesktopBridge;
}

describe("WritingSidebar pending 徽标", () => {
  afterEach(cleanup);
  beforeEach(() => {
    __resetWritingReviews();
    useWritingSpacesStore.setState({
      spaces: [{ id: "s1", name: "space", root: ROOT }],
      activeSpaceId: "s1",
    });
    useWritingWorkspaceStore.setState({ currentFile: null });
  });

  it("pending 文件显示徽标,其它文件无徽标;清除后徽标消失", async () => {
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={fakeBridge()}>
        <WritingSidebar />
      </CoreProvider>,
    );
    // 等文件树渲染。
    await screen.findByText("a");
    expect(screen.queryByLabelText("有待审阅的改动")).toBeNull();

    // 给 a.md 入队审阅 → 徽标出现且仅一个。
    act(() => {
      useWritingReviewStore.getState().beginReview({
        path: A,
        baseline: "old",
        next: "new",
        origin: "agent",
      });
    });
    await waitFor(() => expect(screen.getAllByLabelText("有待审阅的改动")).toHaveLength(1));

    // 清除审阅 → 徽标消失。
    act(() => {
      useWritingReviewStore.getState().clearReview(A);
    });
    await waitFor(() => expect(screen.queryByLabelText("有待审阅的改动")).toBeNull());
  });
});

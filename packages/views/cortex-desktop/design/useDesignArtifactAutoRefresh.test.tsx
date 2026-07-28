// 会话里 agent 写完设计稿后,右栏画布必须自己刷出来。
// 回归的是「agent 说生成好了,画布还是空的,得关掉面板重开」。
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationArtifactRef } from "@cortex-work/core";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { useDesignWorkspaceStore } from "@cortex-work/core/design/design-workspace-store";
import { useDesignArtifactAutoRefresh } from "./useDesignArtifactAutoRefresh";

const ARTIFACT: ConversationArtifactRef = {
  kind: "design",
  documentId: "doc-1",
  title: "海报",
  workspaceRoot: "/ws",
  entryPath: "/ws/.cortex-design/doc-1",
  createdAt: 0,
  updatedAt: 0,
};

function Host({ artifact }: { artifact: ConversationArtifactRef }) {
  useDesignArtifactAutoRefresh(artifact);
  return null;
}

const rehydrate = vi.fn(async () => undefined);

function setRunning(runId: string | undefined): void {
  usePersonalStore.setState({ runningBySession: runId ? { s1: runId } : {} });
}

describe("useDesignArtifactAutoRefresh", () => {
  beforeEach(() => {
    rehydrate.mockClear();
    usePersonalStore.setState({ activeSessionId: "s1", runningBySession: {} });
    useDesignWorkspaceStore.setState({ rehydrateArtifacts: rehydrate });
  });

  afterEach(cleanup);

  it("回合结束(running 由有变无)时重扫产物目录", async () => {
    setRunning("run-1");
    render(<Host artifact={ARTIFACT} />);
    expect(rehydrate).not.toHaveBeenCalled();

    setRunning(undefined);
    await waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
  });

  it("挂载时会话本来就空闲不重扫(面板打开已经扫过一次)", () => {
    render(<Host artifact={ARTIFACT} />);
    expect(rehydrate).not.toHaveBeenCalled();
  });

  it("演示文稿不走这条路(它有 deckChanged 事件驱动刷新)", async () => {
    setRunning("run-1");
    render(<Host artifact={{ ...ARTIFACT, kind: "slides" }} />);
    setRunning(undefined);
    await Promise.resolve();
    expect(rehydrate).not.toHaveBeenCalled();
  });
});

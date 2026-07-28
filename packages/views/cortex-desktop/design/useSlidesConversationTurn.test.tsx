// 会话产物面板的 slides 回合回流:审批等动作必须发回「打开这个产物的那条会话」,
// 而不是设计工作台自己的隐形对话(否则左侧看不到任何消息,用户只能再手打一遍)。
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationArtifactRef } from "@cortex-work/core";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import {
  resolveSlidesTurnDispatcher,
} from "@cortex-work/core/design/slides/slides-turn-dispatch";

const send = vi.fn(async (...args: unknown[]) => {
  void args;
  return true;
});
vi.mock("@cortex-work/core/personal/messages", () => ({
  usePersonalActions: () => ({ send }),
}));

import { useSlidesConversationTurn } from "./useSlidesConversationTurn";

const ARTIFACT: ConversationArtifactRef = {
  kind: "slides",
  documentId: "deck-1",
  title: "季度汇报",
  workspaceRoot: "/ws",
  entryPath: "/ws/.cortex-design/deck-1/deck.bento.html",
  createdAt: 0,
  updatedAt: 0,
};

function Host({ artifact }: { artifact: ConversationArtifactRef }) {
  useSlidesConversationTurn(artifact);
  return null;
}

function seedSession(patch: Partial<{ running: string }> = {}): void {
  usePersonalStore.setState({
    activeSessionId: "s1",
    sessions: [
      {
        id: "s1",
        projectId: "p1",
        title: "汇报",
        agent: "claude",
      },
    ] as never,
    projects: [{ id: "p1", name: "项目", path: "/repo", addedAt: 0 }],
    runningBySession: patch.running ? { s1: patch.running } : {},
  });
}

describe("useSlidesConversationTurn", () => {
  beforeEach(() => {
    send.mockClear();
    seedSession();
  });

  afterEach(() => {
    cleanup();
    usePersonalStore.setState({ runningBySession: {} });
  });

  it("slides 产物挂载后注册派发器,卸载后清除", () => {
    const view = render(<Host artifact={ARTIFACT} />);
    expect(resolveSlidesTurnDispatcher({ workspaceRoot: "/ws", deckId: "deck-1" })).not.toBeNull();
    view.unmount();
    expect(resolveSlidesTurnDispatcher({ workspaceRoot: "/ws", deckId: "deck-1" })).toBeNull();
  });

  it("设计稿产物不注册(只有演示文稿有面板内审批)", () => {
    render(<Host artifact={{ ...ARTIFACT, kind: "design", documentId: "d2" }} />);
    expect(resolveSlidesTurnDispatcher({ workspaceRoot: "/ws", deckId: "d2" })).toBeNull();
  });

  it("派发一轮:发给发起会话,正文进会话流、提纲经 system prompt 下发,并带上产物引用", async () => {
    render(<Host artifact={ARTIFACT} />);
    const dispatcher = resolveSlidesTurnDispatcher({ workspaceRoot: "/ws", deckId: "deck-1" })!;

    await expect(
      dispatcher.send({ text: "已批准提纲", systemPrompt: "OUTLINE_JSON" }),
    ).resolves.toBe(true);

    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0]!;
    const [session, projectPath, text, attachments, extraSystemPrompt] = call;
    expect((session as { id: string }).id).toBe("s1");
    expect(projectPath).toBe("/repo");
    expect(text).toBe("已批准提纲");
    expect(attachments).toEqual([]);
    // 产物定位段必须在:没有它 agent 会另建工作区(buildConversationArtifactPrompt 的契约)。
    expect(extraSystemPrompt).toContain("deck-1");
    expect(extraSystemPrompt).toContain("OUTLINE_JSON");
    expect(call[10]).toEqual(ARTIFACT);
  });

  it("会话仍在跑时先等这一轮结束,不并发起第二条 run", async () => {
    seedSession({ running: "run-1" });
    render(<Host artifact={ARTIFACT} />);
    const dispatcher = resolveSlidesTurnDispatcher({ workspaceRoot: "/ws", deckId: "deck-1" })!;

    const pending = dispatcher.send({ text: "已批准提纲", systemPrompt: "x" });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();

    usePersonalStore.setState({ runningBySession: {} });
    await expect(pending).resolves.toBe(true);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it("会话已被删除时返回 false(交给面板提示,不静默吞掉)", async () => {
    render(<Host artifact={ARTIFACT} />);
    const dispatcher = resolveSlidesTurnDispatcher({ workspaceRoot: "/ws", deckId: "deck-1" })!;
    usePersonalStore.setState({ sessions: [] });

    await expect(dispatcher.send({ text: "x", systemPrompt: "y" })).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

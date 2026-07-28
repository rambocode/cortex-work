// 画布「智能操作」菜单的去向:会话产物面板里回流发起会话,独立设计工作台仍种进助手栏。
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesignWorkspaceStore } from "@cortex-work/core/design/design-workspace-store";
import {
  clearArtifactTurnDispatcher,
  setArtifactTurnDispatcher,
  type ArtifactTurnDispatcher,
} from "@cortex-work/core/design/artifact-turn-dispatch";
import { useDesignAgentActionRunner } from "./useDesignAgentActionRunner";

const ACTION = {
  labelKey: "designAgentActionExploreDirections",
  intentMode: "generate" as const,
  prompt: "Create three distinct UI directions for this product.",
};

let run: (action: typeof ACTION | null) => void;

function Host({ onSeedPrompt }: { onSeedPrompt?: (prompt: string) => void }) {
  run = useDesignAgentActionRunner(onSeedPrompt);
  return null;
}

describe("useDesignAgentActionRunner", () => {
  beforeEach(() => {
    // 助手栏默认是展开的,先收起来才能断言「没有被这次点击打开」。
    useDesignWorkspaceStore.setState({
      workspaceRoot: "/ws",
      activeDocumentId: "doc-1",
      canvasAssistantOpen: false,
    });
  });

  afterEach(cleanup);

  it("会话产物面板:发回会话 —— 正文是操作名,完整指令走 system prompt", () => {
    const send = vi.fn(async (...args: unknown[]) => {
      void args;
      return true;
    });
    const dispatcher: ArtifactTurnDispatcher = {
      workspaceRoot: "/ws",
      documentId: "doc-1",
      send,
    };
    setArtifactTurnDispatcher(dispatcher);
    try {
      const onSeedPrompt = vi.fn();
      render(<Host onSeedPrompt={onSeedPrompt} />);
      run(ACTION);

      expect(send).toHaveBeenCalledTimes(1);
      const turn = send.mock.calls[0]![0] as { text: string; systemPrompt?: string };
      expect(turn.text).toBe("探索设计方向");
      expect(turn.systemPrompt).toBe(ACTION.prompt);
      // 产物面板里没有助手栏,不该顺手把它打开。
      expect(onSeedPrompt).not.toHaveBeenCalled();
      expect(useDesignWorkspaceStore.getState().canvasAssistantOpen).toBe(false);
    } finally {
      clearArtifactTurnDispatcher(dispatcher);
    }
  });

  it("独立设计工作台(无派发器):仍种进助手栏,不回归", () => {
    const onSeedPrompt = vi.fn();
    render(<Host onSeedPrompt={onSeedPrompt} />);
    run(ACTION);

    expect(onSeedPrompt).toHaveBeenCalledWith(ACTION.prompt);
    expect(useDesignWorkspaceStore.getState().canvasAssistantOpen).toBe(true);
  });

  it("禁用项点了什么也不发生", () => {
    const send = vi.fn(async (...args: unknown[]) => {
      void args;
      return true;
    });
    const dispatcher: ArtifactTurnDispatcher = { workspaceRoot: "/ws", documentId: "doc-1", send };
    setArtifactTurnDispatcher(dispatcher);
    try {
      const onSeedPrompt = vi.fn();
      render(<Host onSeedPrompt={onSeedPrompt} />);
      run({ ...ACTION, disabledReasonKey: "designAgentActionNeedsSelection" } as typeof ACTION);
      expect(send).not.toHaveBeenCalled();
      expect(onSeedPrompt).not.toHaveBeenCalled();
    } finally {
      clearArtifactTurnDispatcher(dispatcher);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  getSlidesSession,
  isSlidesRunId,
  parseSlidesRunId,
  registerSlidesSession,
  unregisterSlidesSession,
  type SlidesSessionState,
} from "./session";

describe("Slides run identity", () => {
  it("识别独立工作台与会话产物两种 runId", () => {
    expect(parseSlidesRunId("slides:deck-1:turn")).toBe("deck-1");
    expect(parseSlidesRunId("artifact:slides:deck-2:turn")).toBe("deck-2");
    expect(isSlidesRunId("artifact:design:doc-1:turn")).toBe(false);
  });

  it("旧代迟到注销不会删除同 session 的新代 state", () => {
    const oldState: SlidesSessionState = {
      sessionId: "same-generation",
      runId: "artifact:slides:deck-1:old",
      documentId: "deck-1",
      workspaceRoot: "/workspace",
    };
    const newState: SlidesSessionState = {
      ...oldState,
      runId: "artifact:slides:deck-1:new",
    };
    registerSlidesSession(oldState);
    registerSlidesSession(newState);

    unregisterSlidesSession("same-generation", oldState);

    expect(getSlidesSession("same-generation")).toBe(newState);
    unregisterSlidesSession("same-generation", newState);
  });
});

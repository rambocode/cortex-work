import { describe, expect, it } from "vitest";
import { isSlidesRunId, parseSlidesRunId } from "./session";

describe("Slides run identity", () => {
  it("识别独立工作台与会话产物两种 runId", () => {
    expect(parseSlidesRunId("slides:deck-1:turn")).toBe("deck-1");
    expect(parseSlidesRunId("artifact:slides:deck-2:turn")).toBe("deck-2");
    expect(isSlidesRunId("artifact:design:doc-1:turn")).toBe(false);
  });
});

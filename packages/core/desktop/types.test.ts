import { describe, expect, it } from "vitest";
import { AGENT_MODELS, DEFAULT_MODEL } from "./types";

describe("desktop agent model config", () => {
  it("Codex exposes selectable recommended models", () => {
    expect(AGENT_MODELS.codex.map((m) => m.value)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
  });

  it("Codex default model is selectable", () => {
    expect(AGENT_MODELS.codex.some((m) => m.value === DEFAULT_MODEL.codex)).toBe(true);
  });
});
